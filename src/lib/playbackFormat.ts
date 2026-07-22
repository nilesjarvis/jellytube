import type { HlsRemuxCapabilities } from './codecSupport';
import {
  isHdrVideoSource,
  sourceHasDolbyVisionSampleEntry,
  sourceVideoRangeType
} from './codecSupport';
import type { JellyfinMediaSource } from './types';

export type PlaybackFormatLogo = {
  kind: 'dolby-vision' | 'hdr10-plus' | 'hdr10' | 'hlg' | 'hdr';
  label: string;
  detail: string;
};

type ActivePlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode' | null | undefined;

// Report the format of the frames the active attempt is actually presenting. A
// tone-mapped transcode is SDR even when its source is HDR, and a Dolby Vision 8.1
// base-layer fallback is HDR10 rather than Dolby Vision on the current display path.
export function activePlaybackFormatLogo(
  source: JellyfinMediaSource | null | undefined,
  playMethod: ActivePlayMethod,
  capabilities?: HlsRemuxCapabilities | null
): PlaybackFormatLogo | null {
  if (!source || !playMethod || playMethod === 'Transcode' || !isHdrVideoSource(source)) {
    return null;
  }

  const rangeType = sourceVideoRangeType(source).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dolbyVisionSource = rangeType.startsWith('DOVI');
  if (dolbyVisionSource) {
    if (
      capabilities?.dolbyVision &&
      (playMethod !== 'DirectPlay' || sourceHasDolbyVisionSampleEntry(source))
    ) {
      return {
        kind: 'dolby-vision',
        label: 'Dolby Vision',
        detail: 'Dolby Vision playback is active'
      };
    }
    if (capabilities?.hdr10CompatibleBaseLayer) {
      return {
        kind: 'hdr10',
        label: 'HDR10',
        detail: 'HDR10 playback is active using the Dolby Vision 8.1 compatible base layer'
      };
    }
    return null;
  }

  if (rangeType.includes('HDR10PLUS')) {
    return { kind: 'hdr10-plus', label: 'HDR10+', detail: 'HDR10+ playback is active' };
  }
  if (rangeType.includes('HDR10')) {
    return { kind: 'hdr10', label: 'HDR10', detail: 'HDR10 playback is active' };
  }
  if (rangeType.includes('HLG')) {
    return { kind: 'hlg', label: 'HLG', detail: 'HLG HDR playback is active' };
  }
  return { kind: 'hdr', label: 'HDR', detail: 'HDR playback is active' };
}
