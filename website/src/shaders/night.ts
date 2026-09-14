// Aubergine night sky behind the agent constellation. A full-screen triangle
// pair written straight to clip space, so it never depends on the camera.

export const nightVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;

export const nightFragment = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uWake;
uniform vec2 uResolution;
uniform vec2 uPointer;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 aspect = vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  vec2 p = (vUv - 0.5) * aspect;
  float t = uTime * 0.018;

  // Two layers of domain-warped cloud drifting in opposite directions.
  vec2 q = vec2(fbm(p * 1.6 + t), fbm(p * 1.6 - t + 4.0));
  float cloud = fbm(p * 2.2 + q * 1.4 + uPointer * 0.06);

  vec3 night = vec3(0.022, 0.012, 0.03);
  vec3 aubergine = vec3(0.27, 0.106, 0.322);
  vec3 sky = vec3(0.49, 0.827, 0.988);

  float glow = smoothstep(0.95, 0.0, length(p - vec2(0.18, -0.05)));
  vec3 color = mix(night, aubergine * 0.9, smoothstep(0.35, 0.95, cloud) * (0.45 + glow * 0.55));
  color += sky * pow(smoothstep(0.62, 1.0, cloud), 3.0) * 0.1 * (0.6 + uWake * 0.4);

  // Faint fixed stars, twinkling on their own clocks.
  vec2 grid = vUv * uResolution / 7.0;
  vec2 cell = floor(grid);
  float seed = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  vec2 jitter = vec2(fract(seed * 17.13), fract(seed * 91.7)) * 0.7 + 0.15;
  float star = step(0.985, seed) * smoothstep(0.22, 0.0, length(fract(grid) - jitter));
  color += star * (0.3 + 0.3 * sin(uTime * 1.3 + seed * 60.0)) * 0.6;

  float vignette = smoothstep(1.25, 0.25, length(p));
  gl_FragColor = vec4(color * vignette, 1.0);
}
`;
