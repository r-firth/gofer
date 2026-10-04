import type { ActivityKind } from "./activity-kind";

export const smooth = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fract = (n: number) => n - Math.floor(n);
const line = (distance: number, width = 0.045) =>
  1 - smooth(width, width + 0.065, Math.abs(distance));
const box = (x: number, y: number, w: number, h: number) =>
  Math.max(Math.abs(x) - w, Math.abs(y) - h);

/** Analytic instruments, sampled on a Bayer matrix. Keep in sync with dither.wgsl.
 * Time is continuous; these show activity, never estimated progress or fake data.
 */
export function signalDensity(
  kind: ActivityKind,
  x: number,
  y: number,
  t: number,
): number {
  if (kind === "flow") {
    // The original sidebar field uses normalized UVs, unlike the instruments.
    const wave = 0.5 + Math.sin(x * 8 - t * 1.8) * 0.24;
    const echo = 0.5 + Math.cos(x * 11 + t * 1.2) * 0.2;
    const envelope = smooth(0, 0.16, x) * smooth(0, 0.08, 1 - x);
    const band = Math.exp(-(((y - wave) * 4.2) ** 2));
    const trail = Math.exp(-(((y - echo) * 6) ** 2)) * 0.55;
    return Math.min(1, (band + trail) * envelope * 0.85);
  }
  if (kind === "web") {
    const r = Math.hypot(x, y);
    if (r > 0.9) return 0;
    const z = Math.sqrt(Math.max(0, 0.81 - r * r));
    const longitude = Math.atan2(x, z) + t * 0.65;
    const meridian = line(Math.sin(longitude * 3) * Math.max(z, 0.2), 0.025);
    const latitude = Math.max(line(y, 0.015), line(Math.abs(y) - 0.44, 0.02));
    const land = smooth(
      0.25,
      0.7,
      Math.sin(longitude * 3 + y * 6) * Math.cos(longitude * 2 - y * 9),
    );
    return Math.max(
      line(r - 0.86, 0.025),
      meridian * 0.8,
      latitude * 0.7,
      (0.2 + land * 0.66) * z,
    );
  }
  if (kind === "command") {
    if (Math.abs(x) > 1.4 || Math.abs(y) > 0.78) return 0;
    const row = Math.floor((y + 0.75) / 0.5);
    const rowY = row * 0.5 - 0.5;
    const position = fract((x + 1.4) / 2.8 - t * 0.28 + row * 0.23);
    const head = Math.exp(-Math.pow((position - 0.78) * 14, 2));
    const trail =
      smooth(0.03, 0.72, position) * (1 - smooth(0.77, 0.84, position));
    const bit = Math.floor((x + 1.4) * 8 + row * 3) % 5 === 0 ? 0.3 : 1;
    return line(y - rowY, 0.065) * Math.max(head, trail * bit * 0.72);
  }
  if (kind === "files") {
    const edge = line(box(x, y, 0.62, 0.78), 0.025);
    if (Math.abs(x) > 0.53 || Math.abs(y) > 0.65) return edge * 0.65;
    const scan = -0.65 + fract(t * 0.24) * 1.3;
    const row = Math.floor((y + 0.6) / 0.3);
    const rowY = row * 0.3 - 0.45;
    const length = row % 2 === 0 ? 0.43 : 0.22;
    const written =
      (1 - smooth(length, length + 0.06, x)) * smooth(scan - 0.15, scan, y);
    return Math.max(
      edge * 0.65,
      line(y - scan, 0.035),
      line(y - rowY, 0.025) * written * 0.7,
    );
  }
  if (kind === "connection") {
    const nodes = line(box(Math.abs(x) - 1.03, y, 0.26, 0.48), 0.035);
    const cores =
      (1 - smooth(0.08, 0.17, Math.hypot(Math.abs(x) - 1.03, y))) * 0.9;
    if (Math.abs(x) > 0.73) return Math.max(nodes * 0.65, cores);
    const packet = fract((x + 0.73) / 1.46 - t * 0.65);
    return Math.max(
      line(y, 0.02) * 0.25,
      (1 - smooth(0.05, 0.2, Math.abs(packet - 0.5))) * line(y, 0.09),
    );
  }
  if (kind === "memory") {
    let density = 0;
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3;
      const nx = Math.cos(angle) * 1.04,
        ny = Math.sin(angle) * 0.68;
      const distance = Math.hypot(x - nx, y - ny);
      const strength = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.cos(t * 2 - i), 3);
      density = Math.max(
        density,
        (1 - smooth(0.06, 0.17, distance)) * strength,
      );
      const along = Math.max(
        0,
        Math.min(1, (x * nx + y * ny) / (nx * nx + ny * ny)),
      );
      const spoke = Math.hypot(x - along * nx, y - along * ny);
      const pulse = Math.exp(
        -Math.pow((along - fract(t * 0.4 - i * 0.14)) * 8, 2),
      );
      density = Math.max(density, line(spoke, 0.012) * (0.14 + pulse * 0.55));
    }
    return Math.max(density, (1 - smooth(0.09, 0.22, Math.hypot(x, y))) * 0.9);
  }
  const angle = t * 0.45;
  const rx = x * Math.cos(angle) - y * Math.sin(angle);
  const ry = x * Math.sin(angle) + y * Math.cos(angle);
  const orbit = Math.max(
    line(Math.hypot(rx, ry * 2.5) - 0.78, 0.025),
    line(Math.hypot(rx * 2.5, ry) - 0.78, 0.025),
  );
  const core =
    Math.exp(-(x * x + y * y) * 11) * (0.5 + Math.sin(t * 1.8) * 0.12);
  return Math.max(orbit * 0.75, core);
}
