export type PlayerAspectMode =
  | 'fit'
  | 'stretch-4-3'
  | 'stretch-16-9'
  | 'stretch-21-9'
  | 'crop-21-9';

export type PlayerAspectOption = {
  id: PlayerAspectMode;
  label: string;
  detail: string;
  behavior: 'fit' | 'stretch' | 'crop';
};

export const PLAYER_ASPECT_STORAGE_KEY = 'jellytube.playerAspect';
export const LEGACY_ULTRAWIDE_CROP_STORAGE_KEY = 'jellytube.ultrawideCrop';
export const DEFAULT_PLAYER_SOURCE_ASPECT_RATIO = 16 / 9;

export const PLAYER_ASPECT_OPTIONS: PlayerAspectOption[] = [
  {
    id: 'fit',
    label: 'Original',
    detail: 'Preserve the source proportions',
    behavior: 'fit'
  },
  {
    id: 'stretch-4-3',
    label: 'Stretch to 4:3',
    detail: 'Fill a standard frame without cropping',
    behavior: 'stretch'
  },
  {
    id: 'stretch-16-9',
    label: 'Stretch to 16:9',
    detail: 'Fill a widescreen frame without cropping',
    behavior: 'stretch'
  },
  {
    id: 'stretch-21-9',
    label: 'Stretch to 21:9',
    detail: 'Fill an ultrawide frame without cropping',
    behavior: 'stretch'
  },
  {
    id: 'crop-21-9',
    label: 'Crop to 21:9',
    detail: 'Fill an ultrawide frame by trimming edges',
    behavior: 'crop'
  }
];

export function playerAspectById(id: string | null | undefined): PlayerAspectOption | undefined {
  return PLAYER_ASPECT_OPTIONS.find((option) => option.id === id);
}

export function initialPlayerAspectMode(
  storedMode: string | null | undefined,
  legacyUltrawideCrop = false
): PlayerAspectMode {
  return playerAspectById(storedMode)?.id ?? (legacyUltrawideCrop ? 'crop-21-9' : 'fit');
}

export function playerSourceAspectRatio(
  width: number | null | undefined,
  height: number | null | undefined,
  fallback = DEFAULT_PLAYER_SOURCE_ASPECT_RATIO
) {
  const safeFallback = Number.isFinite(fallback) && fallback > 0
    ? fallback
    : DEFAULT_PLAYER_SOURCE_ASPECT_RATIO;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return safeFallback;
  }
  return width / height;
}
