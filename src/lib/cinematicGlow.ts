export type CinematicGlowColors = {
  left: string;
  right: string;
  center: string;
  floor: string;
};

export type CinematicSampleState = {
  enabled: boolean;
  playing: boolean;
  visible: boolean;
  readyState: number;
  width: number;
  height: number;
  blocked: boolean;
};

const SAMPLE_READY_STATE = 2;
const MIN_LUMA = 26;
const MAX_LUMA = 196;
const SATURATION_BOOST = 1.18;
const FALLBACK_COLORS: CinematicGlowColors = {
  left: 'rgba(255, 0, 51, 0.38)',
  right: 'rgba(41, 121, 255, 0.32)',
  center: 'rgba(255, 255, 255, 0.16)',
  floor: 'rgba(0, 0, 0, 0.36)'
};

type Region = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export const CINEMATIC_SAMPLE_WIDTH = 32;
export const CINEMATIC_SAMPLE_HEIGHT = 18;
export const CINEMATIC_SAMPLE_INTERVAL_MS = 1800;
export const CINEMATIC_FAILURE_LIMIT = 3;
export const CINEMATIC_FALLBACK_STYLE = cinematicGlowStyle(FALLBACK_COLORS);

export function shouldSampleCinematicGlow(state: CinematicSampleState) {
  return (
    state.enabled &&
    state.playing &&
    state.visible &&
    !state.blocked &&
    state.readyState >= SAMPLE_READY_STATE &&
    state.width > 0 &&
    state.height > 0
  );
}

export function cinematicColorsFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): CinematicGlowColors {
  return {
    left: regionColor(data, width, height, {
      x0: 0,
      y0: 0,
      x1: Math.ceil(width * 0.5),
      y1: height
    }),
    right: regionColor(data, width, height, {
      x0: Math.floor(width * 0.5),
      y0: 0,
      x1: width,
      y1: height
    }),
    center: regionColor(data, width, height, {
      x0: Math.floor(width * 0.25),
      y0: Math.floor(height * 0.18),
      x1: Math.ceil(width * 0.75),
      y1: Math.ceil(height * 0.72)
    }),
    floor: regionColor(data, width, height, {
      x0: 0,
      y0: Math.floor(height * 0.62),
      x1: width,
      y1: height
    })
  };
}

export function cinematicGlowStyle(colors: CinematicGlowColors) {
  return [
    `--cinematic-left: ${colors.left}`,
    `--cinematic-right: ${colors.right}`,
    `--cinematic-center: ${colors.center}`,
    `--cinematic-floor: ${colors.floor}`
  ].join('; ');
}

function regionColor(data: Uint8ClampedArray, width: number, height: number, region: Region) {
  const startX = clampIndex(region.x0, width);
  const endX = clampIndex(region.x1, width);
  const startY = clampIndex(region.y0, height);
  const endY = clampIndex(region.y1, height);
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] / 255;
      totalR += data[offset] * alpha;
      totalG += data[offset + 1] * alpha;
      totalB += data[offset + 2] * alpha;
      count += alpha;
    }
  }

  if (count <= 0) return FALLBACK_COLORS.center;
  return rgbToGlow(totalR / count, totalG / count, totalB / count);
}

function rgbToGlow(red: number, green: number, blue: number) {
  const { h, s, l } = rgbToHsl(red, green, blue);
  const boostedSaturation = s < 0.08 ? 0 : Math.min(1, Math.max(0.28, s * SATURATION_BOOST));
  const boundedLightness = Math.min(MAX_LUMA / 255, Math.max(MIN_LUMA / 255, l));
  const [r, g, b] = hslToRgb(h, boostedSaturation, boundedLightness);
  const alpha = 0.28 + Math.min(0.2, boostedSaturation * 0.16);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha.toFixed(2)})`;
}

function clampIndex(value: number, size: number) {
  return Math.min(size, Math.max(0, Math.round(value)));
}

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const h =
    max === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;

  return { h: h / 6, s, l };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation === 0) {
    const value = lightness * 255;
    return [value, value, value];
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    hueToRgb(p, q, hue + 1 / 3) * 255,
    hueToRgb(p, q, hue) * 255,
    hueToRgb(p, q, hue - 1 / 3) * 255
  ];
}

function hueToRgb(p: number, q: number, t: number) {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}
