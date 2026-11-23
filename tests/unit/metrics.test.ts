import { describe, expect, it } from 'vitest';
import {
  cameraAzimuthInBody,
  computeAngles,
  formatAngle,
  formatMetric,
  roundAngles,
} from '../../web/src/metrics/angles';
import { NUM_LANDMARKS } from '../../web/src/fusion/landmarks';
import type { Vec3 } from '../../web/src/fusion/math';
import { squatSkeleton } from '../synthetic/generator';

/** 直立：x右、y前、z上 */
function standing(): (Vec3 | null)[] {
  const J: (Vec3 | null)[] = new Array(NUM_LANDMARKS).fill(null);
  J[23] = [-0.1, 0, 0.9];
  J[24] = [0.1, 0, 0.9];
  J[25] = [-0.1, 0, 0.5];
  J[26] = [0.1, 0, 0.5];
  J[27] = [-0.1, 0, 0.08];
  J[28] = [0.1, 0, 0.08];
  J[29] = [-0.1, -0.06, 0.03];
  J[30] = [0.1, -0.06, 0.03];
  J[31] = [-0.1, 0.16, 0.02];
  J[32] = [0.1, 0.16, 0.02];
  J[11] = [-0.19, 0, 1.4];
  J[12] = [0.19, 0, 1.4];
  return J;
}

const rotZ = (J: (Vec3 | null)[], deg: number): (Vec3 | null)[] => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a),
    s = Math.sin(a);
  return J.map((p) => (p ? [c * p[0] + s * p[1], -s * p[0] + c * p[1], p[2]] : null));
};

describe('指標', () => {
  it('直立では膝0°・体幹0°・つま先0°、膝の入り込みは膝の曲げ30°未満でnull', () => {
    const a = computeAngles(standing());
    expect(a.kneeFlexL).toBeCloseTo(0, 6);
    expect(a.kneeFlexR).toBeCloseTo(0, 6);
    expect(a.trunkLean).toBeCloseTo(0, 6);
    expect(a.toeOutL).toBeCloseTo(0, 6);
    expect(a.toeOutR).toBeCloseTo(0, 6);
    expect(a.kneeInL).toBeNull();
    expect(a.kneeInR).toBeNull();
  });

  it('前傾は正、後傾は負', () => {
    const J = standing();
    J[11] = [-0.19, 0.3, 0.9 + 0.3 * Math.sqrt(3)];
    J[12] = [0.19, 0.3, 0.9 + 0.3 * Math.sqrt(3)]; // 30°前傾
    expect(computeAngles(J).trunkLean).toBeCloseTo(30, 6);
    J[11] = [-0.19, -0.5, 0.9 + 0.5];
    J[12] = [0.19, -0.5, 0.9 + 0.5];
    expect(computeAngles(J).trunkLean).toBeCloseTo(-45, 6);
  });

  it('膝の曲げ角度：90°', () => {
    const J = standing();
    J[23] = [-0.1, -0.4, 0.5];
    J[24] = [0.1, -0.4, 0.5]; // 大腿が水平
    const a = computeAngles(J);
    expect(a.kneeFlexL).toBeCloseTo(90, 6);
    expect(a.kneeFlexR).toBeCloseTo(90, 6);
  });

  it('つま先の開き：外向きが正で、左右対称', () => {
    const J = standing();
    const o = (20 * Math.PI) / 180;
    J[32] = [0.1 + 0.22 * Math.sin(o), -0.06 + 0.22 * Math.cos(o), 0.02]; // 右足先を右（外）へ
    J[31] = [-0.1 - 0.22 * Math.sin(o), -0.06 + 0.22 * Math.cos(o), 0.02]; // 左足先を左（外）へ
    const a = computeAngles(J);
    expect(a.toeOutR).toBeCloseTo(20, 6);
    expect(a.toeOutL).toBeCloseTo(20, 6);
    // 内向き（内股）は負
    J[32] = [0.1 - 0.22 * Math.sin(o), -0.06 + 0.22 * Math.cos(o), 0.02];
    expect(computeAngles(J).toeOutR).toBeCloseTo(-20, 6);
  });

  it('膝の内側への入り込み：内向きが正で、左右対称', () => {
    const base = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 0, kneeInM: 0 });
    const a0 = computeAngles(base);
    expect(a0.kneeInL).toBeCloseTo(0, 6);
    expect(a0.kneeInR).toBeCloseTo(0, 6);
    const valgus = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 0, kneeInM: 0.06 });
    const a1 = computeAngles(valgus);
    expect(a1.kneeInL!).toBeGreaterThan(5);
    expect(a1.kneeInR!).toBeCloseTo(a1.kneeInL!, 6);
    const varus = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 0, kneeInM: -0.06 });
    const a2 = computeAngles(varus);
    expect(a2.kneeInR!).toBeLessThan(-5);
    expect(a2.kneeInL!).toBeCloseTo(a2.kneeInR!, 6);
  });

  it('つま先を開いて膝もつま先の方向に出せば入り込みは0', () => {
    const J = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 25, kneeInM: 0 });
    const a = computeAngles(J);
    expect(a.toeOutL).toBeCloseTo(25, 6);
    expect(a.toeOutR).toBeCloseTo(25, 6);
    expect(a.kneeInL).toBeCloseTo(0, 6);
    expect(a.kneeInR).toBeCloseTo(0, 6);
  });

  it('体の向きを回しても指標は変わらない', () => {
    const J = squatSkeleton({ kneeFlexDeg: 80, trunkLeanDeg: 25, toeOutDeg: 15, kneeInM: 0.04 });
    const a = computeAngles(J);
    const b = computeAngles(rotZ(J, 73));
    for (const k of Object.keys(a) as (keyof typeof a)[]) expect(b[k]!).toBeCloseTo(a[k]!, 6);
  });

  it('脛の前傾：直立で0°、しゃがむと膝の曲げに応じて前傾（膝の入り込みには影響されない）', () => {
    const st = computeAngles(standing());
    expect(st.shinLeanL).toBeCloseTo(0, 6);
    expect(st.shinLeanR).toBeCloseTo(0, 6);
    // 合成データでは下腿の前傾＝膝の曲げ×0.45
    const J = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 0, kneeInM: 0.06 });
    const a = computeAngles(J);
    expect(a.shinLeanL).toBeCloseTo(40.5, 6);
    expect(a.shinLeanR).toBeCloseTo(40.5, 6);
    // 膝が足首より後ろなら負
    const B = standing();
    B[25] = [-0.1, -0.1, 0.5];
    expect(computeAngles(B).shinLeanL).toBeLessThan(0);
  });

  it('足幅（肩幅との比）：足首の左右の間隔 ÷ 肩幅', () => {
    // standing()：足首の間隔0.2m、肩幅0.38m
    expect(computeAngles(standing()).stanceRatio).toBeCloseTo(0.2 / 0.38, 6);
    // 合成データ：足首の間隔0.30m、肩幅0.38m。つま先を開いても、しゃがんでも変わらない
    const J = squatSkeleton({ kneeFlexDeg: 90, trunkLeanDeg: 30, toeOutDeg: 25, kneeInM: 0.04 });
    expect(computeAngles(J).stanceRatio).toBeCloseTo(0.3 / 0.38, 6);
    // 足を前後にずらしても、左右方向の間隔だけを使う
    const S = standing();
    S[27] = [-0.1, 0.3, 0.08];
    expect(computeAngles(S).stanceRatio).toBeCloseTo(0.2 / 0.38, 6);
    // 肩がなければnull
    S[11] = null;
    expect(computeAngles(S).stanceRatio).toBeNull();
  });

  it('関節がnullならその指標はnull', () => {
    const J = standing();
    J[26] = null;
    const a = computeAngles(J);
    expect(a.kneeFlexR).toBeNull();
    expect(a.kneeInR).toBeNull();
    expect(a.kneeFlexL).not.toBeNull();
    J[23] = null;
    const b = computeAngles(J);
    expect(b.trunkLean).toBeNull();
    expect(b.toeOutR).toBeNull();
  });

  it('丸めと表示', () => {
    const a = roundAngles({
      kneeFlexL: 12.345,
      kneeFlexR: null,
      trunkLean: -0.04,
      toeOutL: 1,
      toeOutR: 2,
      kneeInL: 3,
      kneeInR: NaN,
      shinLeanL: 30.06,
      shinLeanR: null,
      stanceRatio: 1.23456,
    });
    expect(a.kneeFlexL).toBe(12.3);
    expect(a.kneeInR).toBeNull();
    expect(a.shinLeanL).toBe(30.1);
    expect(a.stanceRatio).toBe(1.23); // 比は小数点以下2桁
    expect(formatMetric('stanceRatio', 1.234)).toBe('1.23倍');
    expect(formatMetric('stanceRatio', null)).toBe('—');
    expect(formatMetric('shinLeanL', 30.4)).toBe('30°');
    expect(formatAngle(null)).toBe('—');
    expect(formatAngle(-0.4)).toBe('0°');
    expect(formatAngle(85.6)).toBe('86°');
  });

  it('体の向きを基準にしたカメラの方位角', () => {
    const J = standing();
    expect(cameraAzimuthInBody(J, [2, 2, 1])).toBeCloseTo(45, 6); // 右前
    expect(cameraAzimuthInBody(J, [-2, 2, 1])).toBeCloseTo(-45, 6); // 左前
    expect(cameraAzimuthInBody(rotZ(J, 45), [2, 2, 1])).toBeCloseTo(0, 6); // 右に45°向いた人の正面
  });
});
