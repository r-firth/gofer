// The ground's pixels: a few very large, slow, soft fields of colour over warm ink, resolved into
// fine grain with a blue-noise threshold. Nothing here touches the page, so it runs in a worker
// and the per-pixel work never holds up a frame.

export const CELL = 12;
const LEVELS = 3;
const STRENGTH = 0.5;

type Blob = {
  k: number;
  f?: 1;
  x?: number;
  y?: number;
  ox?: number;
  oy?: number;
  r: number;
  a: number;
  dx: number;
  dy: number;
  w: number;
  p: number;
};
// k: ink (0 peach, 1 rose, 2 teal, 3 gold). f: follows the alert, offset by ox, oy.
const BLOBS: Blob[] = [
  {
    k: 0,
    f: 1,
    ox: 0,
    oy: 0,
    r: 0.17,
    a: 0.8,
    dx: 0.006,
    dy: 0.006,
    w: 0.09,
    p: 0,
  },
  {
    k: 1,
    f: 1,
    ox: -0.14,
    oy: 0.02,
    r: 0.15,
    a: 0.62,
    dx: 0.008,
    dy: 0.008,
    w: 0.07,
    p: 2.4,
  },
  {
    k: 3,
    f: 1,
    ox: 0.13,
    oy: -0.02,
    r: 0.11,
    a: 0.5,
    dx: 0.008,
    dy: 0.006,
    w: 0.08,
    p: 0.9,
  },
  { k: 1, x: 0, y: 0, r: 0.3, a: 0.6, dx: 0.03, dy: 0.03, w: 0.06, p: 1.3 },
  {
    k: 2,
    x: 1.02,
    y: 0.52,
    r: 0.46,
    a: 0.85,
    dx: 0.03,
    dy: 0.025,
    w: 0.05,
    p: 2.1,
  },
  {
    k: 2,
    x: 0.46,
    y: -0.06,
    r: 0.24,
    a: 0.5,
    dx: 0.04,
    dy: 0.012,
    w: 0.07,
    p: 4,
  },
  {
    k: 3,
    x: 0.84,
    y: 0.02,
    r: 0.16,
    a: 0.4,
    dx: 0.03,
    dy: 0.03,
    w: 0.08,
    p: 0.6,
  },
  {
    k: 1,
    x: 0.7,
    y: 0.66,
    r: 0.3,
    a: 0.42,
    dx: 0.03,
    dy: 0.02,
    w: 0.05,
    p: 3.3,
  },
  {
    k: 0,
    x: 0.16,
    y: 1.04,
    r: 0.24,
    a: 0.32,
    dx: 0.03,
    dy: 0.01,
    w: 0.06,
    p: 5,
  },
];

function blueNoise(n: number) {
  const size = n * n;
  const energy = new Float32Array(size);
  const out = new Float32Array(size);
  const radius = 5;
  const kernel: number[] = [];
  let seed = 7;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      kernel.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / 4.5));
  for (let i = 0; i < size; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    energy[i] = (seed / 0x7fffffff) * 1e-4;
  }
  for (let rank = 0; rank < size; rank++) {
    let best = 0;
    let min = Infinity;
    for (let i = 0; i < size; i++)
      if (energy[i] < min) {
        min = energy[i];
        best = i;
      }
    out[best] = (rank + 0.5) / size;
    energy[best] = Infinity;
    const bx = best % n;
    const by = (best / n) | 0;
    for (let k = 0; k < kernel.length; k += 3) {
      const j = ((by + kernel[k + 1] + n) % n) * n + ((bx + kernel[k] + n) % n);
      energy[j] += kernel[k + 2];
    }
  }
  return out;
}

/** Where the ground is heading or has got to: ink strengths, overall gain, and the alert's bloom. */
export type Target = {
  m: number[];
  gain: number;
  sat: number;
  px: number;
  py: number;
  f: number;
};

/** The grid of cells the fields are worked out on, for a canvas of this size. */
export const gridOf = (width: number, height: number) => ({
  gridW: Math.ceil(width / CELL) + 1,
  gridH: Math.ceil(height / CELL) + 2,
});

export function createPainter(inks: number[][], ground: number[]) {
  const noise = blueNoise(64);
  const tables = inks.map(() => new Uint8Array((LEVELS + 2) * 3));
  let scale = 1;
  let width = 0;
  let height = 0;
  let gridW = 0;
  let gridH = 0;
  let fields: Float32Array[] = [];
  let rows: Float32Array[] = [];
  let image: ImageData | undefined;
  let pixels: Uint32Array | undefined;
  let tableSat = -1;

  function size(w: number, h: number, s: number) {
    width = w;
    height = h;
    scale = s;
    ({ gridW, gridH } = gridOf(width, height));
    fields = inks.map(() => new Float32Array(gridW * gridH));
    rows = inks.map(() => new Float32Array(gridW));
    image = new ImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
  }

  /** Paints the cells in `seen` (all of them when it is absent) and returns the whole image. */
  function paint(t: number, now: Target, seen?: Uint8Array) {
    if (!width || !image || !pixels) return;
    if (Math.abs(now.sat - tableSat) > 0.003) {
      tableSat = now.sat;
      inks.forEach((c, k) => {
        const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
        for (let level = 0; level <= LEVELS + 1; level++)
          for (let j = 0; j < 3; j++)
            tables[k][level * 3 + j] = Math.round(
              ((lum + (c[j] - lum) * tableSat) *
                STRENGTH *
                Math.min(level, LEVELS)) /
                LEVELS,
            );
      });
    }
    const span = Math.max(width, height);
    for (const field of fields) field.fill(0);
    for (const b of BLOBS) {
      const amp = b.a * now.m[b.k] * now.gain * (b.f ? now.f : 1);
      if (amp < 0.004) continue;
      const cx =
        ((b.f ? now.px + (b.ox ?? 0) : (b.x ?? 0)) +
          b.dx * Math.sin(t * b.w + b.p)) *
        width;
      const cy =
        ((b.f ? now.py + (b.oy ?? 0) : (b.y ?? 0)) +
          b.dy * Math.cos(t * b.w * 0.8 + b.p * 1.7)) *
        height;
      const rr = b.r * span;
      const field = fields[b.k];
      for (let gy = 0; gy < gridH; gy++) {
        const dy = (gy * CELL - cy) / rr;
        const dy2 = dy * dy;
        if (dy2 > 3.2) continue;
        for (let gx = 0; gx < gridW; gx++) {
          const dx = (gx * CELL - cx) / rr;
          field[gy * gridW + gx] += amp * Math.exp(-(dx * dx + dy2) * 2.3);
        }
      }
    }
    const [R0, R1, R2, R3] = rows;
    const [T0, T1, T2, T3] = tables;
    const [g0, g1, g2] = ground;
    const plain = 0xff000000 | (g2 << 16) | (g1 << 8) | g0;
    const fadeFrom = height - 72 / scale;
    const fadeTo = height - 30 / scale;
    let p = 0;
    for (let y = 0; y < height; y++) {
      const gy = (y / CELL) | 0;
      const fy = (y % CELL) / CELL;
      const o = gy * gridW;
      const o2 = o + gridW;
      const calm =
        (y <= fadeFrom
          ? 1
          : y >= fadeTo
            ? 0.1
            : 1 - (0.9 * (y - fadeFrom)) / (fadeTo - fadeFrom)) * LEVELS;
      for (let k = 0; k < 4; k++) {
        const field = fields[k];
        const row = rows[k];
        for (let gx = 0; gx < gridW; gx++) {
          const v =
            (field[o + gx] + (field[o2 + gx] - field[o + gx]) * fy) * calm;
          row[gx] = v > LEVELS ? LEVELS : v;
        }
      }
      const yb = (y & 63) << 6;
      for (let gx = 0; gx < gridW - 1; gx++) {
        const x0 = gx * CELL;
        const n = Math.min(CELL, width - x0);
        if (n <= 0) break;
        if (seen && !seen[o + gx]) {
          p += n;
          continue;
        }
        let v0 = R0[gx];
        let v1 = R1[gx];
        let v2 = R2[gx];
        let v3 = R3[gx];
        const e0 = R0[gx + 1];
        const e1 = R1[gx + 1];
        const e2 = R2[gx + 1];
        const e3 = R3[gx + 1];
        if (v0 + v1 + v2 + v3 + e0 + e1 + e2 + e3 < 0.004) {
          for (let i = 0; i < n; i++) pixels[p++] = plain;
          continue;
        }
        const d0 = (e0 - v0) / CELL;
        const d1 = (e1 - v1) / CELL;
        const d2 = (e2 - v2) / CELL;
        const d3 = (e3 - v3) / CELL;
        for (let i = 0; i < n; i++) {
          const th = noise[yb | ((x0 + i) & 63)];
          let r = g0;
          let g = g1;
          let b = g2;
          let l = v0 | 0;
          if (v0 - l > th) l++;
          if (l) {
            l *= 3;
            r += T0[l];
            g += T0[l + 1];
            b += T0[l + 2];
          }
          l = v1 | 0;
          if (v1 - l > th) l++;
          if (l) {
            l *= 3;
            r += T1[l];
            g += T1[l + 1];
            b += T1[l + 2];
          }
          l = v2 | 0;
          if (v2 - l > th) l++;
          if (l) {
            l *= 3;
            r += T2[l];
            g += T2[l + 1];
            b += T2[l + 2];
          }
          l = v3 | 0;
          if (v3 - l > th) l++;
          if (l) {
            l *= 3;
            r += T3[l];
            g += T3[l + 1];
            b += T3[l + 2];
          }
          pixels[p++] =
            0xff000000 |
            ((b > 255 ? 255 : b) << 16) |
            ((g > 255 ? 255 : g) << 8) |
            (r > 255 ? 255 : r);
          v0 += d0;
          v1 += d1;
          v2 += d2;
          v3 += d3;
        }
      }
    }
    return image;
  }

  return { size, paint };
}
