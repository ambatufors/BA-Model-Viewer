// Hair transparent shader.
//
// MX/C-Hair-Transparent shares the opaque hair lighting path, but the forward
// pass is queued transparent and does not run the alpha cutoff discard. DXBC
// chunk47 writes straight RGB plus alpha (`mad o0.xyz ...`, `mov o0.w r1.w`),
// so the host must use SrcAlpha + OneMinusSrcAlpha rather than premul blending.

import { toonVertSrc, toonFragSrc } from "./toon.js";

export const hairTransparentVertSrc = toonVertSrc;

export const hairTransparentFragSrc = toonFragSrc.replace(
  "    if (albedo.a < u_Cutoff) discard;\n\n",
  ""
);
