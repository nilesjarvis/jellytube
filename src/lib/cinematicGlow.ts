export type CinematicGlowColors = {
  left: string;
  right: string;
  center: string;
  floor: string;
};

export type CinematicGlowColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

export type CinematicGlowPalette = {
  left: CinematicGlowColor;
  right: CinematicGlowColor;
  center: CinematicGlowColor;
  floor: CinematicGlowColor;
};

export type CinematicSampleState = {
  enabled: boolean;
  playing: boolean;
  visible: boolean;
  readyState: number;
  width: number;
  height: number;
  blocked: boolean;
  buffering: boolean;
  loading: boolean;
};

const SAMPLE_READY_STATE = 2;
const MIN_LUMA = 24;
const MAX_LUMA = 212;
const LOW_SATURATION_CUTOFF = 0.035;
const SATURATION_BOOST = 1.75;
const FALLBACK_PALETTE: CinematicGlowPalette = {
  left: { red: 20, green: 22, blue: 30, alpha: 0.42 },
  right: { red: 20, green: 22, blue: 30, alpha: 0.42 },
  center: { red: 34, green: 36, blue: 44, alpha: 0.26 },
  floor: { red: 4, green: 5, blue: 8, alpha: 0.54 }
};

type Region = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const PALETTE_KEYS: Array<keyof CinematicGlowPalette> = ['left', 'right', 'center', 'floor'];
const REGIONS: Record<keyof CinematicGlowPalette, Region> = {
  left: { x0: 0, y0: 0.06, x1: 0.24, y1: 0.94 },
  right: { x0: 0.76, y0: 0.06, x1: 1, y1: 0.94 },
  center: { x0: 0.28, y0: 0.18, x1: 0.72, y1: 0.68 },
  floor: { x0: 0.12, y0: 0.68, x1: 0.88, y1: 1 }
};

export const CINEMATIC_SAMPLE_WIDTH = 32;
export const CINEMATIC_SAMPLE_HEIGHT = 18;
export const CINEMATIC_SAMPLE_INTERVAL_MS = 900;
export const CINEMATIC_FAILURE_LIMIT = 3;
export const CINEMATIC_BLEND_AMOUNT = 0.55;
export const CINEMATIC_STYLE_EPSILON = 1.2;
export const CINEMATIC_FALLBACK_COLORS = cinematicColorsFromPalette(FALLBACK_PALETTE);
export const CINEMATIC_FALLBACK_STYLE = cinematicGlowStyle(CINEMATIC_FALLBACK_COLORS);

export function shouldSampleCinematicGlow(state: CinematicSampleState) {
  return (
    state.enabled &&
    state.playing &&
    state.visible &&
    !state.blocked &&
    !state.buffering &&
    !state.loading &&
    state.readyState >= SAMPLE_READY_STATE &&
    state.width > 0 &&
    state.height > 0
  );
}

export function cinematicPaletteFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): CinematicGlowPalette {
  return {
    left: regionColor(data, width, height, REGIONS.left),
    right: regionColor(data, width, height, REGIONS.right),
    center: scaleAlpha(regionColor(data, width, height, REGIONS.center), 0.92),
    floor: scaleAlpha(regionColor(data, width, height, REGIONS.floor), 1.25)
  };
}

export function cinematicColorsFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): CinematicGlowColors {
  return cinematicColorsFromPalette(cinematicPaletteFromImageData(data, width, height));
}

export function cinematicColorsFromPalette(palette: CinematicGlowPalette): CinematicGlowColors {
  return {
    left: formatGlowColor(palette.left),
    right: formatGlowColor(palette.right),
    center: formatGlowColor(palette.center),
    floor: formatGlowColor(palette.floor)
  };
}

export function blendCinematicGlowPalette(
  previous: CinematicGlowPalette | null | undefined,
  next: CinematicGlowPalette,
  amount = CINEMATIC_BLEND_AMOUNT
): CinematicGlowPalette {
  if (!previous) return next;
  const weight = Math.min(1, Math.max(0, amount));
  return {
    left: blendGlowColor(previous.left, next.left, weight),
    right: blendGlowColor(previous.right, next.right, weight),
    center: blendGlowColor(previous.center, next.center, weight),
    floor: blendGlowColor(previous.floor, next.floor, weight)
  };
}

export function cinematicPalettesAreClose(
  current: CinematicGlowPalette | null | undefined,
  next: CinematicGlowPalette,
  threshold = CINEMATIC_STYLE_EPSILON
) {
  if (!current) return false;
  return PALETTE_KEYS.every((key) => {
    const a = current[key];
    const b = next[key];
    return (
      Math.abs(a.red - b.red) <= threshold &&
      Math.abs(a.green - b.green) <= threshold &&
      Math.abs(a.blue - b.blue) <= threshold &&
      Math.abs(a.alpha - b.alpha) * 255 <= threshold
    );
  });
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
  const startX = clampIndex(Math.floor(region.x0 * width), width);
  let endX = clampIndex(Math.ceil(region.x1 * width), width);
  const startY = clampIndex(Math.floor(region.y0 * height), height);
  let endY = clampIndex(Math.ceil(region.y1 * height), height);
  if (endX <= startX) endX = Math.min(width, startX + 1);
  if (endY <= startY) endY = Math.min(height, startY + 1);
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] / 255;
      if (alpha <= 0) continue;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const weight = pixelWeight(red, green, blue, alpha);
      totalR += red * weight;
      totalG += green * weight;
      totalB += blue * weight;
      count += weight;
    }
  }

  if (count <= 0) return FALLBACK_PALETTE.center;
  return rgbToGlow(totalR / count, totalG / count, totalB / count);
}

function rgbToGlow(red: number, green: number, blue: number) {
  const { h, s, l } = rgbToHsl(red, green, blue);
  const boostedSaturation = s < LOW_SATURATION_CUTOFF ? 0 : Math.min(1, Math.max(0.38, s * SATURATION_BOOST));
  const boundedLightness = Math.min(MAX_LUMA / 255, Math.max(MIN_LUMA / 255, l));
  const [r, g, b] = hslToRgb(h, boostedSaturation, boundedLightness);
  const extremeLightnessPenalty = l < 0.06 || l > 0.94 ? 0.02 : 0;
  const alpha =
    boostedSaturation === 0
      ? 0.28 - extremeLightnessPenalty
      : 0.34 + Math.min(0.3, boostedSaturation * 0.24) - extremeLightnessPenalty;
  return {
    red: r,
    green: g,
    blue: b,
    alpha: Math.min(0.68, Math.max(0.18, alpha))
  };
}

function pixelWeight(red: number, green: number, blue: number, alpha: number) {
  const { s, l } = rgbToHsl(red, green, blue);
  const saturationWeight = 0.12 + Math.min(1, s * 2) * 0.88;
  const middleDistance = Math.min(1, Math.abs(l - 0.52) / 0.52);
  const midtoneWeight = 0.26 + (1 - middleDistance) * 0.74;
  const extremeWeight = l < 0.035 || l > 0.965 ? 0.42 : l < 0.08 || l > 0.9 ? 0.68 : 1;
  return alpha * saturationWeight * midtoneWeight * extremeWeight;
}

function scaleAlpha(color: CinematicGlowColor, amount: number): CinematicGlowColor {
  return {
    ...color,
    alpha: Math.max(0, Math.min(1, color.alpha * amount))
  };
}

function blendGlowColor(previous: CinematicGlowColor, next: CinematicGlowColor, amount: number) {
  return {
    red: lerp(previous.red, next.red, amount),
    green: lerp(previous.green, next.green, amount),
    blue: lerp(previous.blue, next.blue, amount),
    alpha: lerp(previous.alpha, next.alpha, amount)
  };
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function formatGlowColor(color: CinematicGlowColor) {
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${color.alpha.toFixed(2)})`;
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
