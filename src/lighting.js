import * as THREE from "three";

// From ForwardLights::SetupMainLightConstants.
// Produces (lightTone, shadowTone, lightData) shader globals for a given main
// light colour. _MxCharLightData.y is consumed by the body VS to bias the
// shadow threshold.
export function computeLightTones(lightColorR, lightColorG, lightColorB) {
  const maxC = Math.max(lightColorR, lightColorG, lightColorB);
  const minC = Math.min(lightColorR, lightColorG, lightColorB);
  const safeMax = Math.max(maxC, 0.0001);

  const nR = lightColorR / safeMax;
  const nG = lightColorG / safeMax;
  const nB = lightColorB / safeMax;

  const contrast = (maxC - minC) / safeMax;
  const saturation = Math.min(Math.max(contrast * 0.88, 0.0), 1.0);

  const lightTone = new THREE.Vector4(
    nR + (1.0 - nR) * 0.25,
    nG + (1.0 - nG) * 0.25,
    nB + (1.0 - nB) * 0.25,
    0.0
  );

  const shadowTone = new THREE.Vector4(
    1.0 + (nR * 0.5 - 1.0) * saturation,
    1.0 + (nG * 0.5 - 1.0) * saturation,
    1.0 + (nB * 0.5 - 1.0) * saturation,
    0.0
  );

  const lightData = new THREE.Vector4(
    maxC * 0.85 + 0.15,
    (maxC + minC) * 0.5,
    0.0,
    0.0
  );

  return { lightTone, shadowTone, lightData };
}

export const ECHELON_LIGHT_COLOR = { r: 1.0, g: 1.0, b: 1.0 };

// Builds URP-style SH9 packed coefficients from a flat ambient colour.
// Layout matches Unity's SetSHCoefficients (cb1[25..31]):
//   SHAr/g/b : (linear band rotated to world) — for ambient-only this only
//              has the constant L0 in the .w slot.
//   SHBr/g/b : quadratic band (zero for flat ambient).
//   SHC      : (n.x²−n.y²) coefficient (zero for flat ambient).
// SampleSH9 in the VS recovers the flat colour by reading .w from each Ar/g/b.
export function computeSH9FromAmbient(color) {
  // Y0 (DC) coefficient under three.js LightProbe convention is colour /
  // sqrt(4π). The VS evaluates the dot product against (n,1) and adds a
  // constant offset, so packing the colour in the .w lane is sufficient for
  // a uniform ambient fill.
  const cR = color.r;
  const cG = color.g;
  const cB = color.b;
  return {
    SHAr: new THREE.Vector4(0, 0, 0, cR),
    SHAg: new THREE.Vector4(0, 0, 0, cG),
    SHAb: new THREE.Vector4(0, 0, 0, cB),
    SHBr: new THREE.Vector4(0, 0, 0, 0),
    SHBg: new THREE.Vector4(0, 0, 0, 0),
    SHBb: new THREE.Vector4(0, 0, 0, 0),
    SHC:  new THREE.Vector4(0, 0, 0, 0),
  };
}

// Build SH9 from a three.js LightProbe (full directional ambient). Use this
// when the host wants a more interesting probe than flat ambient. Pulls the
// 9 SH coefficients out of the probe and packs them in URP layout.
export function computeSH9FromLightProbe(lightProbe) {
  const sh = lightProbe?.sh;
  if (!sh) return computeSH9FromAmbient(new THREE.Color(0.06, 0.07, 0.085));

  // three.js stores SH9 in shCoefficients[0..8] = L0, L1{-1,0,1}, L2{-2,-1,0,1,2}.
  const c = sh.coefficients;
  const L0 = c[0]; // (1/2)*sqrt(1/π)        constant
  const L11 = c[1];
  const L10 = c[2];
  const L12 = c[3];
  const L22 = c[4]; // xy
  const L21 = c[5]; // yz
  const L20 = c[6]; // 3z²-1
  const L211 = c[7]; // xz
  const L222 = c[8]; // x²-y²

  // Pack URP-style: SHAr.xyz = L1 (rotated), SHAr.w = L0 + offset
  return {
    SHAr: new THREE.Vector4(-L11.r, -L10.r, L12.r, L0.r),
    SHAg: new THREE.Vector4(-L11.g, -L10.g, L12.g, L0.g),
    SHAb: new THREE.Vector4(-L11.b, -L10.b, L12.b, L0.b),
    SHBr: new THREE.Vector4(L22.r, L21.r, L20.r, L211.r),
    SHBg: new THREE.Vector4(L22.g, L21.g, L20.g, L211.g),
    SHBb: new THREE.Vector4(L22.b, L21.b, L20.b, L211.b),
    SHC:  new THREE.Vector4(L222.r, L222.g, L222.b, 1.0),
  };
}
