// MX/C-Simple-Transparent.
//
// The game shader uses the character/simple lighting path, but its forward
// pass is queued Transparent with ZWrite Off and Cull Off. Its PS writes
// premultiplied RGB for One + OneMinusSrcAlpha blending, and it has no
// alpha-cutoff property.

import { toonVertSrc, toonFragSrc } from "./toon.js";

export const simpleTransparentVertSrc = toonVertSrc;

export const simpleTransparentFragSrc = toonFragSrc
  .replace("    if (albedo.a < u_Cutoff) discard;\n\n", "")
  .replace(
    "        gl_FragColor = vec4(albedo.rgb, albedo.a);\n",
    "        gl_FragColor = vec4(albedo.rgb * albedo.a, albedo.a);\n"
  )
  .replace(
    "        gl_FragColor = vec4(albedo.rgb * shadowMul, albedo.a);\n",
    "        gl_FragColor = vec4(albedo.rgb * shadowMul * albedo.a, albedo.a);\n"
  )
  .replace(
    "    gl_FragColor = vec4(color, albedo.a);\n",
    "    gl_FragColor = vec4(color * albedo.a, albedo.a);\n"
  );
