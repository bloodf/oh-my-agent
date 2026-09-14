// Agents as points of sky-blue light, and the messages they exchange as packets
// travelling along arcs between them. All motion runs on the GPU.

export const agentVertex = /* glsl */ `
attribute float aPhase;
attribute float aSize;
uniform float uTime;
uniform float uWake;
uniform float uPixelRatio;
varying float vPulse;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float beat = pow(0.5 + 0.5 * sin(uTime * 1.3 + aPhase), 8.0);
  vPulse = beat;
  gl_PointSize = aSize * uPixelRatio * (1.0 + beat * 0.45) * (0.75 + uWake * 0.25) * (420.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const agentFragment = /* glsl */ `
precision highp float;
uniform float uWake;
varying float vPulse;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.09, 0.02, d);
  float halo = exp(-d * d * 14.0) * 0.8 + exp(-d * d * 60.0) * 0.6;
  float ring = smoothstep(0.02, 0.0, abs(d - 0.2 - vPulse * 0.22)) * vPulse;
  vec3 sky = vec3(0.49, 0.827, 0.988);
  vec3 color = sky * (halo * 0.9 + ring * 0.8) + vec3(1.0) * core;
  float alpha = (halo * 0.85 + core + ring) * (0.55 + uWake * 0.45);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

export const packetVertex = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aOffset;
attribute float aSpeed;
uniform float uTime;
uniform float uWake;
uniform float uPixelRatio;
varying float vFade;
void main() {
  float t = fract(uTime * aSpeed + aOffset);
  vec3 mid = (aStart + aEnd) * 0.5 + vec3(0.0, 0.35 + length(aEnd - aStart) * 0.12, 0.2);
  // Quadratic Bezier arc from start through the lifted midpoint to end.
  vec3 pos = mix(mix(aStart, mid, t), mix(mid, aEnd, t), t);
  vFade = sin(t * 3.14159) * uWake;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = (5.0 + 7.0 * vFade) * uPixelRatio * (9.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const packetFragment = /* glsl */ `
precision highp float;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float glow = exp(-d * d * 18.0);
  gl_FragColor = vec4(mix(vec3(0.49, 0.827, 0.988), vec3(1.0), glow * 0.5), glow * vFade);
}
`;

export const linkVertex = /* glsl */ `
attribute float aT;
attribute float aPhase;
varying float vT;
varying float vPhase;
void main() {
  vT = aT;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const linkFragment = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uWake;
varying float vT;
varying float vPhase;
void main() {
  float head = fract(uTime * 0.22 + vPhase);
  float trail = smoothstep(0.28, 0.0, head - vT) * step(vT, head);
  float alpha = (0.07 + trail * 0.5) * uWake;
  gl_FragColor = vec4(vec3(0.49, 0.827, 0.988), alpha);
}
`;
