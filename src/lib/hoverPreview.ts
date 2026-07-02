import { canDirectPlaySource, directStreamExtension, type VideoProbe } from './codecSupport';
import type { JellyfinClient } from './jellyfin';
import type { JellyfinItem, JellyfinMediaSource } from './types';

export { directStreamExtension };

export const HOVER_PREVIEW_DELAY_MS = 300;
export const HOVER_PREVIEW_MAX_CACHE = 48;
export const HOVER_PREVIEW_HLS_WIDTH = 640;
export const HOVER_PREVIEW_HLS_HEIGHT = 360;
export const HOVER_PREVIEW_VIDEO_BITRATE = 1_500_000;
export const HOVER_PREVIEW_AUDIO_BITRATE = 128_000;
export const HOVER_PREVIEW_DIRECT_MAX_BITRATE = 4_000_000;
export const HOVER_PREVIEW_DIRECT_MAX_UNKNOWN_BITRATE_WIDTH = 1280;
export const HOVER_PREVIEW_DIRECT_MAX_UNKNOWN_BITRATE_HEIGHT = 720;
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

export function canDirectPreview(
  source: JellyfinMediaSource,
  video: VideoProbe,
  extension = directStreamExtension(source)
) {
  return canDirectPlaySource(source, video, extension);
}

export function isDirectPreviewLightweight(source: JellyfinMediaSource) {
  const videoStream = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const bitrate = source.Bitrate ?? videoStream?.BitRate ?? 0;
  const width = videoStream?.Width ?? 0;
  const height = videoStream?.Height ?? 0;

  if (bitrate > 0) return bitrate <= HOVER_PREVIEW_DIRECT_MAX_BITRATE;
  if (width > HOVER_PREVIEW_DIRECT_MAX_UNKNOWN_BITRATE_WIDTH) return false;
  if (height > HOVER_PREVIEW_DIRECT_MAX_UNKNOWN_BITRATE_HEIGHT) return false;
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
