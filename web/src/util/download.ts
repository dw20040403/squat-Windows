// ファイルのダウンロード
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadJson(obj: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), filename);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** 録画の拡張子（SafariはMP4、ChromeはWebMのことがある） */
export function videoExt(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'bin';
}
