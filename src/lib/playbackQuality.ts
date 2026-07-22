import type { JellyfinMediaSource } from './types';

export type PlaybackQualityId = 'auto' | 'direct' | `hls-${number}k`;

export type PlaybackQualityOption = {
  id: PlaybackQualityId;
  label: string;
  detail: string;
  mode: 'auto' | 'direct' | 'hls';
  maxWidth?: number;
  maxHeight?: number;
  videoBitrate?: number;
  audioBitrate?: number;
};

const transcodePresets: PlaybackQualityOption[] = [
  {
    id: 'hls-20000k',
    label: '20 Mbps',
    detail: 'up to 4K',
    mode: 'hls',
    maxWidth: 3840,
    maxHeight: 2160,
    videoBitrate: 20_000_000,
    audioBitrate: 384_000
  },
  {
    id: 'hls-12000k',
    label: '12 Mbps',
    detail: 'up to 1080p',
    mode: 'hls',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: 12_000_000,
    audioBitrate: 256_000
  },
  {
    id: 'hls-8000k',
    label: '8 Mbps',
    detail: 'up to 1080p',
    mode: 'hls',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitrate: 8_000_000,
    audioBitrate: 192_000
  },
  {
    id: 'hls-4000k',
    label: '4 Mbps',
    detail: 'up to 720p',
    mode: 'hls',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitrate: 4_000_000,
    audioBitrate: 160_000
  },
  {
    id: 'hls-2000k',
    label: '2 Mbps',
    detail: 'up to 480p',
    mode: 'hls',
    maxWidth: 854,
    maxHeight: 480,
    videoBitrate: 2_000_000,
    audioBitrate: 128_000
  },
  {
    id: 'hls-1000k',
    label: '1 Mbps',
    detail: 'up to 360p',
    mode: 'hls',
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: 1_000_000,
    audioBitrate: 96_000
  }
];

export function playbackQualityOptions(
  source: JellyfinMediaSource,
  { directAvailable = false }: { directAvailable?: boolean } = {}
) {
  const options: PlaybackQualityOption[] = [
    {
      id: 'auto',
      label: 'Auto',
      detail: directAvailable ? 'device optimized' : 'Jellyfin managed',
      mode: 'auto'
    }
  ];

  if (directAvailable) {
    options.push({
      id: 'direct',
      label: 'Original',
      detail: originalQualityDetail(source),
      mode: 'direct'
    });
  }

  const sourceHeight = sourceVideoHeight(source);
  options.push(
    ...transcodePresets.filter((preset) => !sourceHeight || !preset.maxHeight || preset.maxHeight <= sourceHeight + 16)
  );
  return options;
}

export function playbackQualityById(
  options: PlaybackQualityOption[],
  qualityId: string | null | undefined
) {
  return options.find((option) => option.id === qualityId) ?? options[0];
}

export function sourceVideoHeight(source: JellyfinMediaSource) {
  return source.MediaStreams?.find((stream) => stream.Type === 'Video')?.Height ?? 0;
}

export function sourceVideoWidth(source: JellyfinMediaSource) {
  return source.MediaStreams?.find((stream) => stream.Type === 'Video')?.Width ?? 0;
}

function originalQualityDetail(source: JellyfinMediaSource) {
  const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const height = sourceVideoHeight(source);
  const width = sourceVideoWidth(source);
  const resolution = width >= 3800 ? '4K' : height ? `${height}p` : '';
  const rangeType = video?.VideoRangeType ?? '';
  const color = rangeType.startsWith('DOVI')
    ? `Dolby Vision${rangeType.includes('HDR10Plus') ? ' + HDR10+' : ''}`
    : rangeType === 'HDR10Plus'
      ? 'HDR10+'
      : rangeType === 'HDR10'
        ? 'HDR10'
        : rangeType === 'HLG'
          ? 'HLG'
          : '';
  const bitrate = source.Bitrate ?? video?.BitRate ?? 0;
  return [resolution, color, bitrate ? formatBitrate(bitrate) : 'source file'].filter(Boolean).join(' · ');
}

function formatBitrate(bitsPerSecond: number) {
  if (bitsPerSecond >= 1_000_000) {
    return `${Number((bitsPerSecond / 1_000_000).toFixed(1)).toLocaleString()} Mbps`;
  }
  if (bitsPerSecond >= 1_000) return `${Math.round(bitsPerSecond / 1_000)} Kbps`;
  return `${bitsPerSecond} bps`;
}
