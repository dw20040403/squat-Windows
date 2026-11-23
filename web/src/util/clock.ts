// 端末の時計（epoch ms、サブミリ秒の精度）
export const nowMs = (): number => performance.timeOrigin + performance.now();
