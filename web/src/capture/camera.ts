// カメラの取得（spec 5.1）。前面＝内カメ（user）か背面＝外カメ（environment）を選ぶ（設定画面、既定は params.json の video.facing）

export interface CameraHandle {
  stream: MediaStream;
  video: HTMLVideoElement;
  width: number;
  height: number;
  label: string;
  deviceId: string | undefined;
  settings: MediaTrackSettings;
  /** 実機で確認するための情報（plan フェーズ2 手順8） */
  devices: { label: string; deviceId: string }[];
  stop(): void;
}

export class CameraError extends Error {
  constructor(
    message: string,
    readonly kind: 'permission' | 'not-found' | 'insecure' | 'other',
  ) {
    super(message);
  }
}

export type CameraFacing = 'user' | 'environment';

/** 背面の標準広角カメラらしいものを選ぶ（超広角・望遠・レンズを切り替える仮想カメラを避ける） */
export function pickBackWideCamera(devices: { label: string; deviceId: string }[]): string | undefined {
  const back = devices.filter((d) => /back|背面|rear|environment/i.test(d.label));
  const wide = back.find((d) => !/ultra|超広角|tele|望遠|dual|triple|デュアル|トリプル/i.test(d.label));
  return (wide ?? back[0])?.deviceId;
}

/** 前面（画面側・内側）のカメラらしいものを選ぶ */
export function pickFrontCamera(devices: { label: string; deviceId: string }[]): string | undefined {
  return devices.find((d) => /front|前面|user|facetime|truedepth/i.test(d.label))?.deviceId;
}

export function pickCamera(
  devices: { label: string; deviceId: string }[],
  facing: CameraFacing,
): string | undefined {
  return facing === 'user' ? pickFrontCamera(devices) : pickBackWideCamera(devices);
}

export async function openCamera(
  video: HTMLVideoElement,
  opt: { width: number; height: number; deviceId?: string; facing?: CameraFacing },
): Promise<CameraHandle> {
  if (!window.isSecureContext) throw new CameraError('カメラを使うにはHTTPSで開いてください', 'insecure');
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CameraError('このブラウザはカメラに対応していません', 'other');
  const base: MediaTrackConstraints = {
    width: { ideal: opt.width },
    height: { ideal: opt.height },
    frameRate: { ideal: 30 },
  };
  const facing = opt.facing ?? 'user';
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: opt.deviceId
        ? { ...base, deviceId: { exact: opt.deviceId } }
        : { ...base, facingMode: { ideal: facing } },
    });
  } catch (e) {
    const err = e as DOMException;
    if (err.name === 'NotAllowedError')
      throw new CameraError(
        'カメラの使用が許可されていません。設定でSafariのカメラを許可してください',
        'permission',
      );
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')
      throw new CameraError('カメラが見つかりません', 'not-found');
    throw new CameraError(`カメラを開けませんでした：${err.message}`, 'other');
  }
  // 許可を得た後ならラベルが取れる。目的のカメラが別にあれば開き直す
  const all = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ label: d.label, deviceId: d.deviceId }));
  const track = stream.getVideoTracks()[0];
  if (!opt.deviceId) {
    const wanted = pickCamera(all, facing);
    if (wanted && wanted !== track.getSettings().deviceId) {
      stream.getTracks().forEach((t) => t.stop());
      return openCamera(video, { ...opt, deviceId: wanted });
    }
  }
  // ズームは等倍に固定する（対応していれば）
  try {
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: unknown };
    if ('zoom' in caps) await track.applyConstraints({ advanced: [{ zoom: 1 } as MediaTrackConstraintSet] });
  } catch {
    /* 対応していない */
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  await video.play();
  await new Promise<void>((res) => {
    if (video.videoWidth) res();
    else video.addEventListener('loadedmetadata', () => res(), { once: true });
  });
  const settings = track.getSettings();
  return {
    stream,
    video,
    width: video.videoWidth,
    height: video.videoHeight,
    label: track.label,
    deviceId: settings.deviceId,
    settings,
    devices: all,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}
