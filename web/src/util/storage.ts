// localStorageの読み書き（プライベートブラウズなどで失敗しても落ちないように）
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s === null ? fallback : (JSON.parse(s) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorageに保存できませんでした', e);
  }
}

export const KEYS = {
  deviceName: 'squat.deviceName',
  extrinsics: 'squat.extrinsics',
  layout: 'squat.layout',
  subject: 'squat.subject',
  displayMode: 'squat.displayMode',
  panelVisible: 'squat.panelVisible',
  recordVideo: 'squat.recordVideo',
  arucoDetector: 'squat.arucoDetector',
  delegate: 'squat.delegate',
  countdown: 'squat.countdown',
  cameraFacing: 'squat.cameraFacing',
} as const;
