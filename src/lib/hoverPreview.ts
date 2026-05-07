import type { JellyfinClient } from './jellyfin';
import type { JellyfinItem, JellyfinMediaSource } from './types';

export const HOVER_PREVIEW_DELAY_MS = 300;
export const HOVER_PREVIEW_MAX_CACHE = 48;
export const HOVER_PREVIEW_HLS_WIDTH = 640;
export const HOVER_PREVIEW_HLS_HEIGHT = 360;
export const HOVER_PREVIEW_VIDEO_BITRATE = 3_000_000;
export const HOVER_PREVIEW_AUDIO_BITRATE = 128_000;
export const HOVER_PREVIEW_DIRECT_MAX_BITRATE = 8_000_000;
export const HOVER_PREVIEW_DIRECT_MAX_WIDTH = 1280;
export const HOVER_PREVIEW_DIRECT_MAX_HEIGHT = 720;
export const HOVER_PREVIEW_HLS_BUFFER_SECONDS = 6;
export const HOVER_PREVIEW_HLS_MAX_BUFFER_SECONDS = 8;
export const HOVER_PREVIEW_HLS_MAX_BUFFER_SIZE = 8_000_000;

type PreviewEligibilityOptions = {
  poster?: boolean;
  finePointer?: boolean;
  reducedMotion?: boolean;
};

let activePreviewStop: (() => void) | null = null;
const previewPlaybackInfoCache = new Map<string, ReturnType<JellyfinClient['getPreviewPlaybackInfo']>>();

export function isHoverPreviewEligible(
  item: JellyfinItem,
  { poster = false, finePointer = true, reducedMotion = false }: PreviewEligibilityOptions = {}
) {
  if (poster || reducedMotion || !finePointer) return false;
  return item.Type !== 'Movie' && item.contentKind !== 'movie';
}

export function claimHoverPreview(stop: () => void) {
  if (activePreviewStop && activePreviewStop !== stop) activePreviewStop();
  activePreviewStop = stop;
}

export function releaseHoverPreview(stop: () => void) {
  if (activePreviewStop === stop) activePreviewStop = null;
}

export function getCachedPreviewPlaybackInfo(client: JellyfinClient, itemId: string) {
  const cacheKey = `${client.serverUrl}:${client.userId ?? ''}:${itemId}`;
  const cached = previewPlaybackInfoCache.get(cacheKey);
  if (cached) return cached;

  const request = client.getPreviewPlaybackInfo(itemId).catch((error) => {
    previewPlaybackInfoCache.delete(cacheKey);
    throw error;
  });
  previewPlaybackInfoCache.set(cacheKey, request);
  trimPreviewCache();
  return request;
}

export function directStreamExtension(source: JellyfinMediaSource) {
  const tokens = `${source.Container ?? ''}`
    .toLowerCase()
    .split(',')
    .map((token) => token.trim());
  if (tokens.includes('mp4') || tokens.includes('m4v')) return 'mp4';
  if (tokens.includes('webm')) return 'webm';
  return '';
}

export function canDirectPreview(
  source: JellyfinMediaSource,
  video: Pick<HTMLVideoElement, 'canPlayType'>,
  extension = directStreamExtension(source)
) {
  if (source.SupportsDirectPlay === false || !extension) return false;
  const videoCodec = normalizeCodec(source.MediaStreams?.find((stream) => stream.Type === 'Video')?.Codec);
  const audioCodec = normalizeCodec(source.MediaStreams?.find((stream) => stream.Type === 'Audio')?.Codec);

  if (extension === 'mp4') {
    if (videoCodec === 'h264' && isMp4Audio(audioCodec)) {
      return Boolean(
        video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || video.canPlayType('video/mp4')
      );
    }
    if (videoCodec === 'hevc' && isMp4Audio(audioCodec)) {
      return Boolean(video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'));
    }
    return !videoCodec && Boolean(video.canPlayType('video/mp4'));
  }

  if (extension === 'webm') {
    if (videoCodec !== 'vp8' && videoCodec !== 'vp9') return false;
    if (audioCodec && audioCodec !== 'opus' && audioCodec !== 'vorbis') return false;
    const codecString = `${videoCodec}, ${audioCodec || 'opus'}`;
    return Boolean(
      video.canPlayType(`video/webm; codecs="${codecString}"`) || video.canPlayType('video/webm')
    );
  }

  return false;
}

export function isDirectPreviewLightweight(source: JellyfinMediaSource) {
  const videoStream = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const bitrate = source.Bitrate ?? videoStream?.BitRate ?? 0;
  const width = videoStream?.Width ?? 0;
  const height = videoStream?.Height ?? 0;

  if (bitrate > HOVER_PREVIEW_DIRECT_MAX_BITRATE) return false;
  if (width > HOVER_PREVIEW_DIRECT_MAX_WIDTH) return false;
  if (height > HOVER_PREVIEW_DIRECT_MAX_HEIGHT) return false;
  return true;
}

export function supportsNativeHls(video: Pick<HTMLVideoElement, 'canPlayType'>) {
  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')
  );
}

export function previewHlsOptions(source: JellyfinMediaSource, playSessionId = '') {
  return {
    startTicks: 0,
    playSessionId,
    audioStreamIndex: source.DefaultAudioStreamIndex,
    subtitleStreamIndex: undefined,
    maxWidth: HOVER_PREVIEW_HLS_WIDTH,
    maxHeight: HOVER_PREVIEW_HLS_HEIGHT,
    videoBitrate: HOVER_PREVIEW_VIDEO_BITRATE,
    audioBitrate: HOVER_PREVIEW_AUDIO_BITRATE
  };
}

function trimPreviewCache() {
  while (previewPlaybackInfoCache.size > HOVER_PREVIEW_MAX_CACHE) {
    const oldest = previewPlaybackInfoCache.keys().next().value;
    if (!oldest) return;
    previewPlaybackInfoCache.delete(oldest);
  }
}

function normalizeCodec(codec?: string) {
  const value = (codec ?? '').toLowerCase();
  if (!value) return '';
  if (value.includes('h264') || value.includes('avc')) return 'h264';
  if (value.includes('h265') || value.includes('hevc')) return 'hevc';
  if (value.includes('vp9')) return 'vp9';
  if (value.includes('vp8')) return 'vp8';
  if (value.includes('av1') || value.includes('av01')) return 'av1';
  if (value.includes('aac') || value.includes('mp4a')) return 'aac';
  if (value.includes('mp3')) return 'mp3';
  if (value.includes('opus')) return 'opus';
  if (value.includes('vorbis')) return 'vorbis';
  return value;
}

function isMp4Audio(codec: string) {
  return !codec || codec === 'aac' || codec === 'mp3';
}
