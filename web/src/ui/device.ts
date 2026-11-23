// 主端末・副端末に共通の部分：カメラ、2D推定、2D表示（表示モード①②③）
import { openCamera, type CameraFacing, type CameraHandle } from '../capture/camera';
import { FrameLoop, type FrameInfo } from '../capture/frameLoop';
import { WakeLock } from '../capture/wakeLock';
import { loadIntrinsics } from '../configLoader';
import type { AppConfig } from '../configLoader';
import type { Intrinsics } from '../fusion/camera';
import type { Pose2D } from '../fusion/landmarks';
import { MovingAverage, RateMeter } from '../monitor/fps';
import { PoseEstimator, type Delegate } from '../pose/landmarker';
import { drawSkeleton2D, fitContain, syncCanvasSize } from '../render/view2d';
import { nowMs } from '../util/clock';
import { KEYS, loadJson, saveJson } from '../util/storage';
import { h } from './dom';

export type DisplayMode = 'video' | 'skeleton' | 'overlay' | '3d';

export interface PoseFrame {
  /** 自分の時計（ms） */
  t: number;
  pose: Pose2D | null;
  w: number;
  h: number;
  inferMs: number;
}

export class DeviceCore {
  readonly stage: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLCanvasElement;
  cam: CameraHandle | null = null;
  est: PoseEstimator | null = null;
  loop: FrameLoop | null = null;
  readonly wakeLock = new WakeLock();
  /** 端末の名前（例：iphone12）。内部パラメータの名前はこれにカメラの向きを付けたもの */
  baseName: string;
  /** 使うカメラ：user＝内カメ（前面）、environment＝外カメ（背面） */
  facing: CameraFacing;
  intr: Intrinsics | null = null;
  lastPose: Pose2D | null = null;
  lastFrame: PoseFrame | null = null;
  readonly rate = new RateMeter(2000);
  readonly inferMs = new MovingAverage(30);
  mode: DisplayMode = 'overlay';
  /** 2D描画の上に重ねる追加の描画 */
  extraDraw:
    | ((ctx: CanvasRenderingContext2D, map: { scale: number; offsetX: number; offsetY: number }) => void)
    | null = null;
  onPose: (f: PoseFrame) => void = () => {};
  /** カメラを自動で開き直したとき（理由つき）。録画中なら止まるので、画面で知らせる */
  onCameraRestart: (reason: string) => void = () => {};
  invalidJoints: Set<number> | undefined;
  error: string | null = null;
  private recovering = false;
  private lastMediaTime = -1;
  private stalledSince = 0;

  constructor(
    readonly cfg: AppConfig,
    readonly role: 'main' | 'sub',
  ) {
    this.baseName = stripFacing(loadJson<string>(KEYS.deviceName, role === 'main' ? 'iphone12' : 'iphone11'));
    this.facing = loadJson<CameraFacing>(KEYS.cameraFacing, cfg.params.video.facing ?? 'user');
    this.video = h('video', { playsinline: true, muted: true, autoplay: true });
    this.overlay = h('canvas', { class: 'overlay' });
    this.stage = h('div', { class: 'stage mode-overlay' }, this.video, this.overlay);
    this.setMode(loadJson<DisplayMode>(KEYS.displayMode, 'overlay'));
  }

  setMode(m: DisplayMode): void {
    this.mode = m;
    this.stage.classList.remove('mode-video', 'mode-skeleton', 'mode-overlay', 'mode-3d');
    this.stage.classList.add(`mode-${m}`);
    saveJson(KEYS.displayMode, m);
    this.draw();
  }

  /** 内部パラメータの名前（例：iphone12-front）。副端末への通知・外部校正・記録にもこの名前を使う */
  get deviceName(): string {
    return intrinsicsName(this.baseName, this.facing);
  }

  async setDeviceName(name: string): Promise<void> {
    this.baseName = stripFacing(name);
    saveJson(KEYS.deviceName, this.baseName);
    this.intr = await loadIntrinsics(this.deviceName);
  }

  /** カメラの向きを保存する（カメラを開き直すため、反映にはページの再読み込みが必要） */
  saveFacing(f: CameraFacing): void {
    saveJson(KEYS.cameraFacing, f);
  }

  get resolutionOk(): boolean {
    return (
      !!this.intr &&
      !!this.cam &&
      this.intr.imageSize[0] === this.cam.width &&
      this.intr.imageSize[1] === this.cam.height
    );
  }

  /** カメラ → 推定器 → フレームループの順に起動する */
  async start(status: (s: string) => void): Promise<void> {
    status('内部パラメータを読み込み中…');
    this.intr = await loadIntrinsics(this.deviceName);
    status('カメラを起動中…');
    this.cam = await openCamera(this.video, { ...this.cfg.params.video, facing: this.facing });
    status('姿勢推定のモデルを読み込み中…');
    const delegate = loadJson<Delegate | 'auto'>(KEYS.delegate, 'auto');
    this.est = await PoseEstimator.create({ model: this.cfg.params.poseModel, delegate });
    this.loop = new FrameLoop(this.video, this.cfg.params.frameIntervalMs, (f) => this.process(f));
    this.loop.start();
    new ResizeObserver(() => this.draw()).observe(this.stage);
    this.watchCamera();
    status('');
  }

  /**
   * カメラの映像が止まったら復旧する。iOSのSafariでは、録画の停止やダウンロードの確認、
   * 画面の切り替えのあとにカメラが中断され、映像が真っ暗のまま戻らないことがある。
   * - 映像の要素が一時停止していたら再生し直す
   * - トラックが終了した、または映像の時刻が一定時間進まない場合はカメラを開き直す
   */
  private watchCamera(): void {
    const check = () => void this.checkCamera();
    this.video.addEventListener('pause', () => {
      if (document.visibilityState === 'visible') void this.video.play().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      this.stalledSince = 0;
      if (document.visibilityState === 'visible') check();
    });
    this.bindTrack();
    window.setInterval(check, 1000);
  }

  private bindTrack(): void {
    const track = this.cam?.stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => void this.restartCamera('カメラが終了しました'));
  }

  private async checkCamera(): Promise<void> {
    if (!this.cam || this.recovering || document.visibilityState !== 'visible') return;
    const track = this.cam.stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') return this.restartCamera('カメラが終了しました');
    if (this.video.paused) await this.video.play().catch(() => {});
    // 映像の時刻が進んでいるか（推論で主スレッドが止まっていても、映像の時刻は進む）
    const mt = this.video.currentTime;
    const now = performance.now();
    if (mt !== this.lastMediaTime) {
      this.lastMediaTime = mt;
      this.stalledSince = 0;
      return;
    }
    if (!this.stalledSince) this.stalledSince = now;
    else if (now - this.stalledSince > CAMERA_STALL_MS)
      await this.restartCamera(track.muted ? 'カメラが中断されました' : 'カメラの映像が止まりました');
  }

  /** カメラを開き直す（同じカメラを選ぶ） */
  async restartCamera(reason: string): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    console.warn(`[camera] ${reason}。カメラを開き直します`);
    try {
      const old = this.cam;
      old?.stop();
      this.cam = await openCamera(this.video, {
        ...this.cfg.params.video,
        facing: this.facing,
        deviceId: old?.deviceId,
      }).catch(() => openCamera(this.video, { ...this.cfg.params.video, facing: this.facing }));
      this.bindTrack();
      // 映像の要素が新しくなったので、フレームの受け取りもやり直す
      this.loop?.stop();
      this.loop?.start();
      this.lastMediaTime = -1;
      this.stalledSince = 0;
      this.error = null;
      this.onCameraRestart(reason);
    } catch (e) {
      this.error = `カメラを開き直せませんでした：${(e as Error).message}`;
      console.error(e);
    } finally {
      this.recovering = false;
    }
  }

  private process(f: FrameInfo): void {
    if (!this.est || !this.cam) return;
    const w = this.video.videoWidth;
    const hh = this.video.videoHeight;
    const t0 = performance.now();
    let pose: Pose2D | null = null;
    try {
      pose = this.est.detect(this.video, f.t - performance.timeOrigin, w, hh);
    } catch (e) {
      this.error = (e as Error).message;
      console.error(e);
    }
    const ms = performance.now() - t0;
    this.inferMs.push(ms);
    this.rate.tick(nowMs());
    this.lastPose = pose;
    this.lastFrame = { t: f.t, pose, w, h: hh, inferMs: ms };
    this.draw();
    this.onPose(this.lastFrame);
  }

  /** 2D骨格を描く */
  draw(): void {
    if (this.mode === 'video' || this.mode === '3d') return;
    const { w, h: ch } = syncCanvasSize(this.overlay);
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, w, ch);
    if (this.mode === 'skeleton') {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, w, ch);
    }
    const vw = this.video.videoWidth || this.cfg.params.video.height;
    const vh = this.video.videoHeight || this.cfg.params.video.width;
    const map = fitContain(vw, vh, w, ch);
    if (this.lastPose) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      drawSkeleton2D(ctx, this.lastPose, {
        minVisibility: this.cfg.params.fusion.minVisibility,
        ...map,
        lineWidth: 3 * dpr,
        radius: 4 * dpr,
        invalid: this.invalidJoints,
      });
    }
    this.extraDraw?.(ctx, map);
  }

  /** 校正画像の撮影用：現在のフレームをPNGにする（計測時と同じ解像度） */
  async snapshotPng(): Promise<{ blob: Blob; w: number; h: number }> {
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    c.getContext('2d')!.drawImage(this.video, 0, 0);
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('PNGにできませんでした'))), 'image/png'),
    );
    return { blob, w: c.width, h: c.height };
  }
}

/** 映像の時刻がこれ以上進まなければ、カメラを開き直す（ms） */
const CAMERA_STALL_MS = 3000;

export const FACING_SUFFIX: Record<CameraFacing, string> = { user: 'front', environment: 'back' };
export const FACING_LABEL: Record<CameraFacing, string> = {
  user: '内カメ（前面）',
  environment: '外カメ（背面）',
};

/** 端末の名前とカメラの向きから、内部パラメータの名前を作る（例：iphone12 + user → iphone12-front） */
export const intrinsicsName = (base: string, facing: CameraFacing): string =>
  `${base}-${FACING_SUFFIX[facing]}`;

/** 内部パラメータの名前から、カメラの向きの部分を取り除く */
export const stripFacing = (name: string): string => name.replace(/-(front|back)$/, '');

/** 表示モードのボタン（①〜④） */
export function modeButtons(
  core: { mode: DisplayMode; setMode(m: DisplayMode): void },
  with3d: boolean,
  hasVideo = true,
): HTMLElement {
  const defs: [DisplayMode, string][] = [
    ['video', '①映像'],
    ['skeleton', '②骨格'],
    ['overlay', '③合成'],
  ];
  if (with3d) defs.push(['3d', '④3D']);
  const wrap = h('div', { class: 'modes' });
  const buttons = defs.map(([m, label]) => {
    const b = h(
      'button',
      {
        onclick: () => (core.setMode(m), update()),
        disabled: !hasVideo && (m === 'video' || m === 'overlay'),
      },
      label,
    );
    wrap.appendChild(b);
    return { m, b };
  });
  const update = () => buttons.forEach(({ m, b }) => b.classList.toggle('on', core.mode === m));
  update();
  return wrap;
}
