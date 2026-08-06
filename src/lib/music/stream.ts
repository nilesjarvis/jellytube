import type { JellyfinClient } from '../jellyfin';
import type { JellyfinMediaSource, PlaybackInfo } from '../types';

export type MusicStreamPlayMethod = 'DirectPlay' | 'Transcode';

export type MusicStream = {
  src: string;
  mediaSource: JellyfinMediaSource | null;
  container: string;
  playMethod: MusicStreamPlayMethod;
};

export function pickMusicSource(info: PlaybackInfo): JellyfinMediaSource | null {
  const sources = info.MediaSources ?? [];
  return (
    sources.find((source) => source.SupportsDirectPlay) ??
    sources.find((source) => source.SupportsTranscoding) ??
    sources[0] ??
    null
  );
}

/**
 * Resolve a playable audio URL for a song. Prefers a static direct stream; falls
 * back to Jellyfin's own transcoded URL when the container cannot be direct-played.
 */
export function musicStreamFor(
  client: JellyfinClient,
  itemId: string,
  info: PlaybackInfo
): MusicStream | null {
  const source = pickMusicSource(info);
  if (!source) return null;

  if (source.SupportsDirectPlay) {
    return {
      src: client.getAudioStreamUrl(itemId, source.Id, source.Container),
      mediaSource: source,
      container: source.Container ?? '',
      playMethod: 'DirectPlay'
    };
  }

  if (source.SupportsTranscoding && source.TranscodingUrl) {
    return {
      src: client.getPlaybackUrl(source.TranscodingUrl),
      mediaSource: source,
      container: source.TranscodingContainer ?? '',
      playMethod: 'Transcode'
    };
  }

  return null;
}
