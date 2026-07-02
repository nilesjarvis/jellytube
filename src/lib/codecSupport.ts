import type { JellyfinMediaSource } from './types';

// Representative codec strings used for `canPlayType` capability probes.
// AV1 Main profile / level 4.0 / 8-bit covers this library's 1080p content; browsers
// report support for the codec family largely independent of the exact level here.
export const AV1_PROBE_CODEC = 'av01.0.08M.08';
// HEVC Main profile. Both the `hvc1` and `hev1` sample-entry tags appear in the wild.
export const HEVC_PROBE_CODECS = ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'] as const;

export type VideoProbe = Pick<HTMLVideoElement, 'canPlayType'>;

export type DirectPlayCodecs = {
  h264: boolean;
  hevc: boolean;
  vp8: boolean;
  vp9: boolean;
  av1: boolean;
};

let sharedProbe: VideoProbe | null = null;

function defaultProbe(): VideoProbe {
  if (sharedProbe) return sharedProbe;
  sharedProbe =
    typeof document !== 'undefined' && typeof document.createElement === 'function'
      ? document.createElement('video')
      : { canPlayType: () => '' };
  return sharedProbe;
}

function canPlay(video: VideoProbe, mime: string) {
  return video.canPlayType(mime) !== '';
}

// Which video codecs this browser can decode for progressive (direct-play) `<video>`
// playback. Used to build the Jellyfin device profile so we only advertise direct play
// for codecs the client can actually handle, keeping transcoding as the fallback.
export function detectDirectPlayCodecs(video: VideoProbe = defaultProbe()): DirectPlayCodecs {
  return {
    h264: canPlay(video, 'video/mp4; codecs="avc1.42E01E"'),
    hevc: HEVC_PROBE_CODECS.some((codec) => canPlay(video, `video/mp4; codecs="${codec}"`)),
    vp8: canPlay(video, 'video/webm; codecs="vp8"'),
    vp9:
      canPlay(video, 'video/webm; codecs="vp09.00.10.08"') ||
      canPlay(video, 'video/webm; codecs="vp9"'),
    av1:
      canPlay(video, `video/webm; codecs="${AV1_PROBE_CODEC}"`) ||
      canPlay(video, `video/mp4; codecs="${AV1_PROBE_CODEC}"`)
  };
}

export function normalizeCodec(codec?: string) {
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

export function directStreamExtension(source: JellyfinMediaSource): 'mp4' | 'webm' | '' {
  const tokens = `${source.Container ?? ''}`
    .toLowerCase()
    .split(',')
    .map((token) => token.trim());
  if (tokens.includes('mp4') || tokens.includes('m4v')) return 'mp4';
  if (tokens.includes('webm')) return 'webm';
  return '';
}

function isMp4Audio(codec: string) {
  return !codec || codec === 'aac' || codec === 'mp3';
}

// AV1 in an mp4 container is also commonly muxed with opus/flac by some archivers.
function isExtendedMp4Audio(codec: string) {
  return isMp4Audio(codec) || codec === 'opus' || codec === 'flac';
}

function videoCodecProbeString(videoCodec: string) {
  return videoCodec === 'av1' ? AV1_PROBE_CODEC : videoCodec;
}

function sourceVideoCodec(source: JellyfinMediaSource) {
  return normalizeCodec(source.MediaStreams?.find((stream) => stream.Type === 'Video')?.Codec);
}

function sourceAudioCodec(source: JellyfinMediaSource) {
  const stream =
    source.MediaStreams?.find(
      (candidate) => candidate.Type === 'Audio' && candidate.Index === source.DefaultAudioStreamIndex
    ) ?? source.MediaStreams?.find((candidate) => candidate.Type === 'Audio');
  return normalizeCodec(stream?.Codec);
}

// Whether the browser can direct-play (progressive, no server transcode) this source
// as-is. Shared by the watch player and hover previews so both stay in agreement with
// the advertised Jellyfin device profile.
export function canDirectPlaySource(
  source: JellyfinMediaSource,
  video: VideoProbe,
  extension: string = directStreamExtension(source)
): boolean {
  if (source.SupportsDirectPlay === false || !extension) return false;
  const videoCodec = sourceVideoCodec(source);
  const audioCodec = sourceAudioCodec(source);

  if (extension === 'mp4') {
    if (!videoCodec) return canPlay(video, 'video/mp4');
    if (videoCodec === 'h264' && isMp4Audio(audioCodec)) {
      return (
        canPlay(video, 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || canPlay(video, 'video/mp4')
      );
    }
    if (videoCodec === 'hevc' && isMp4Audio(audioCodec)) {
      return HEVC_PROBE_CODECS.some((codec) => canPlay(video, `video/mp4; codecs="${codec}"`));
    }
    if (videoCodec === 'av1' && isExtendedMp4Audio(audioCodec)) {
      return canPlay(video, `video/mp4; codecs="${AV1_PROBE_CODEC}"`);
    }
    return false;
  }

  if (extension === 'webm') {
    if (!videoCodec) return canPlay(video, 'video/webm');
    if (videoCodec !== 'vp8' && videoCodec !== 'vp9' && videoCodec !== 'av1') return false;
    if (audioCodec && audioCodec !== 'opus' && audioCodec !== 'vorbis') return false;
    const codecString = `${videoCodecProbeString(videoCodec)}, ${audioCodec || 'opus'}`;
    return canPlay(video, `video/webm; codecs="${codecString}"`);
  }

  return false;
}
