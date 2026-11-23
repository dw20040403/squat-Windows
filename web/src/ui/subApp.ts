// 副端末：カメラB → 2D推定 → 主時計に換算して主端末へ送る（spec 5.7.3）
import { VideoRecorder } from '../capture/recorder';
import type { AppConfig } from '../configLoader';
import { toFlat } from '../fusion/landmarks';
import { ClockSyncClient, type SyncRes } from '../net/clockSync';
import type { CtrlMsg } from '../net/messages';
import { PeerLink } from '../net/peer';
import { nowMs } from '../util/clock';
import { downloadBlob, downloadJson, videoExt } from '../util/download';
import { openCalibCapture } from './calibCapture';
import type { RecordingMeta } from './calibState';
import { DeviceCore, modeButtons } from './device';
import { alertDialog, fmtNum, h, openSheet, toast } from './dom';
import { detectExtrinsics } from './extrinsicsUi';
import { openSettings } from './settings';

export class SubApp {
  readonly core: DeviceCore;
  readonly peer = new PeerLink('sub');
  private clock: ClockSyncClient;
  private seq = 0;
  private recorder = new VideoRecorder();
  private statusEl: HTMLElement;
  private reasonEl: HTMLElement;

  constructor(
    readonly cfg: AppConfig,
    root: HTMLElement,
  ) {
    this.core = new DeviceCore(cfg, 'sub');
    if (this.core.mode === '3d') this.core.setMode('overlay');
    this.clock = new ClockSyncClient(cfg.params.clockSync, {
      send: (m) => this.peer.sendCtrl(m),
      now: nowMs,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    this.clock.onUpdate = () => this.renderStatus();
    this.core.stage.append(modeButtons(this.core, false));
    this.statusEl = h('div', { class: 'statusbar' });
    this.reasonEl = h('div', { class: 'reason' });
    root.appendChild(
      h(
        'div',
        { class: 'app' },
        this.statusEl,
        this.core.stage,
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn', onclick: () => openCalibCapture(this.core) }, '校正画像撮影'),
          h('button', { class: 'btn', onclick: () => void this.runExtrinsics() }, '外部校正'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => openSettings(this.core, { main: false, onChanged: () => this.sendHello() }),
            },
            '設定',
          ),
          this.reasonEl,
        ),
      ),
    );
  }

  async start(): Promise<void> {
    try {
      await this.core.start((s) => (this.reasonEl.textContent = s));
    } catch (e) {
      this.reasonEl.textContent = (e as Error).message;
      await alertDialog('起動できません', (e as Error).message);
      return;
    }
    await this.core.wakeLock.acquire();
    this.peer.onState = (s) => {
      if (s === 'connected') {
        this.sendHello();
        void this.clock.start();
      } else this.clock.stop();
      this.renderStatus();
    };
    this.peer.onCtrl = (m) => this.onCtrl(m);
    this.peer.start();
    this.core.onCameraRestart = (reason) => {
      if (this.recorder.active) {
        toast(`${reason}。カメラを開き直しました（テスト録画はここで止めました）`, 5000);
        void this.stopTestRecording();
      } else toast(`${reason}。カメラを開き直しました`, 4000);
    };
    this.core.onPose = (f) => {
      // 時刻同期が済むまでは送らない（時刻が主時計に揃わないため）
      if (!this.clock.state.synced) return;
      this.peer.sendPose({
        type: 'pose',
        seq: this.seq++,
        t: this.clock.toMain(f.t),
        w: f.w,
        h: f.h,
        lm: toFlat(f.pose),
      });
    };
    setInterval(() => this.sendStatus(), 1000);
    setInterval(() => this.renderStatus(), 500);
  }

  private sendHello(): void {
    this.peer.sendCtrl({
      type: 'hello',
      deviceName: this.core.deviceName,
      intrinsics: this.core.intr,
      videoSize: [this.core.cam?.width ?? 0, this.core.cam?.height ?? 0],
      cameraLabel: this.core.cam?.label,
    });
  }

  private sendStatus(): void {
    const s = this.clock.state;
    this.peer.sendCtrl({
      type: 'status',
      fps: this.core.rate.rate(nowMs()),
      personDetected: !!this.core.lastPose,
      synced: s.synced,
      offsetMs: s.offset,
      rttMs: s.rttMs,
      probeRttMs: s.probeRttMs,
      inferMs: this.core.inferMs.value,
      recording: this.recorder.recording,
    });
  }

  private onCtrl(m: CtrlMsg): void {
    switch (m.type) {
      case 'sync-res':
        this.clock.handle(m as SyncRes);
        break;
      case 'calib-start':
        void this.runExtrinsics();
        break;
      case 'test-rec-start':
        if (this.core.cam && !this.recorder.recording) {
          this.recorder.start(this.core.cam.stream);
          toast('テスト録画を開始しました');
        }
        break;
      case 'test-rec-stop':
        void this.stopTestRecording();
        break;
      default:
        break;
    }
  }

  private async runExtrinsics(): Promise<void> {
    toast('外部校正：マーカーを検出しています…');
    try {
      const { result, detector } = await detectExtrinsics(
        this.core,
        this.cfg.board,
        (s) => (this.reasonEl.textContent = s),
      );
      this.reasonEl.textContent = '';
      this.peer.sendCtrl({
        type: 'extrinsics',
        R: result.extr.R,
        t: result.extr.t,
        reprojErrPx: result.reprojErrPx,
        markers: result.markers.length,
        detector: `${detector.detector.name}/${result.method}`,
      });
      toast(
        `外部校正の結果を送りました（再投影誤差 ${result.reprojErrPx.toFixed(2)}px、マーカー${result.markers.length}個）`,
        4000,
      );
    } catch (e) {
      this.reasonEl.textContent = '';
      this.peer.sendCtrl({
        type: 'notice',
        level: 'error',
        text: `外部校正に失敗しました：${(e as Error).message}`,
      });
      toast(`外部校正に失敗しました：${(e as Error).message}`, 5000);
    }
  }

  private async stopTestRecording(): Promise<void> {
    if (!this.recorder.active) return;
    const startedLocal = this.recorder.startedAtLocal;
    const mimeType = this.recorder.mimeType;
    const blob = await this.recorder.stop();
    this.peer.sendCtrl({ type: 'test-rec-done', ok: !!blob });
    if (!blob) return;
    const meta: RecordingMeta = {
      role: 'sub',
      deviceName: this.core.deviceName,
      intrinsics: this.core.intr,
      recordStartedAt: this.clock.toMain(startedLocal),
      videoSize: [this.core.cam!.width, this.core.cam!.height],
      mimeType,
      cameraLabel: this.core.cam?.label,
      clockOffsetMs: this.clock.state.offset,
    };
    const ext = videoExt(mimeType);
    // iOSではユーザーの操作がないとダウンロードできないため、ボタンを出す
    openSheet('テスト録画のダウンロード', (body) => {
      body.append(
        h('p', {}, `録画しました（${(blob.size / 1e6).toFixed(1)}MB）。`),
        h(
          'div',
          { class: 'menu' },
          h(
            'button',
            { class: 'btn primary', onclick: () => downloadBlob(blob, `sub.${ext}`) },
            `sub.${ext}`,
          ),
          h('button', { class: 'btn', onclick: () => downloadJson(meta, 'sub-meta.json') }, 'sub-meta.json'),
        ),
      );
    });
  }

  private renderStatus(): void {
    const ps = this.peer.state;
    const s = this.clock.state;
    const conn = ps === 'connected' ? 'ok' : ps === 'rejected' ? 'bad' : 'warn';
    const label = {
      idle: '待機',
      signaling: 'サーバー接続中',
      'waiting-peer': '主端末を待機中',
      connecting: '接続中',
      connected: '接続済み',
      disconnected: '切断',
      rejected: '副端末が既にあります',
    }[ps];
    this.statusEl.replaceChildren(
      h('span', { class: 'item' }, h('i', { class: `dot ${conn}` }), label),
      h(
        'span',
        { class: 'item' },
        h('i', { class: `dot ${s.synced ? 'ok' : 'bad'}` }),
        s.synced
          ? `ずれ${fmtNum(s.offset, 0)}ms 往復${fmtNum(s.probeRttMs ?? s.rttMs, 0)}ms`
          : '時刻同期：未',
      ),
      h(
        'span',
        { class: 'item' },
        `${fmtNum(this.core.rate.rate(nowMs()), 1)}fps 推論${fmtNum(this.core.inferMs.value, 0)}ms`,
      ),
      h(
        'span',
        { class: 'item' },
        this.core.deviceName,
        this.core.intr ? (this.core.resolutionOk ? '' : '（解像度不一致）') : '（内部パラメータなし）',
      ),
      this.recorder.recording ? h('span', { class: 'badge rec' }, '● 録画中') : h('span', {}),
    );
  }
}
