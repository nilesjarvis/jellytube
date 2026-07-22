import type { JellyfinMediaSource, JellyfinMediaStream } from './types';

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

export type MediaCapabilitiesVideoConfiguration = {
  type: 'file' | 'media-source';
  video: {
    contentType: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
    hdrMetadataType?: 'smpteSt2086' | 'smpteSt2094-10' | 'smpteSt2094-40';
    colorGamut?: 'srgb' | 'p3' | 'rec2020';
    transferFunction?: 'srgb' | 'pq' | 'hlg';
  };
};

export type MediaCapabilitiesDecodingInfo = {
  supported: boolean;
  smooth: boolean;
  powerEfficient: boolean;
};

export type MediaCapabilitiesProbe = {
  decodingInfo(
    configuration: MediaCapabilitiesVideoConfiguration
  ): Promise<MediaCapabilitiesDecodingInfo>;
};

export type MediaSourceTypeProbe = Pick<typeof MediaSource, 'isTypeSupported'>;

export type MatchMediaProbe = (query: string) => Pick<MediaQueryList, 'matches'>;

export type HlsRemuxCapabilities = {
  videoCodec: 'hevc';
  videoRangeTypes: string[];
  maxVideoLevel: number;
  audioCodecs: string[];
  maxAudioChannels: number;
  hdr: boolean;
  dolbyVisionSource: boolean;
  dolbyVision: boolean;
  hdr10CompatibleBaseLayer: boolean;
  hdr10Plus: boolean;
  preferHlsForStartup: boolean;
  autoPrefer: boolean;
};

export type HlsVideoPreference = {
  preferHDR: true;
  allowedVideoRanges: Array<'PQ' | 'HLG'>;
};

export type HlsManifestLevel = {
  videoCodec?: string;
  videoRange?: string;
  attrs?: {
    CODECS?: string;
    'VIDEO-RANGE'?: string;
  };
};

export type HlsRemuxEnvironment = {
  video?: VideoProbe;
  mediaCapabilities?: MediaCapabilitiesProbe | null;
  mediaSource?: MediaSourceTypeProbe | null;
  matchMedia?: MatchMediaProbe | null;
  userAgent?: string;
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

function defaultMediaCapabilitiesProbe(): MediaCapabilitiesProbe | null {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaCapabilities ||
    typeof navigator.mediaCapabilities.decodingInfo !== 'function'
  ) {
    return null;
  }
  return navigator.mediaCapabilities as unknown as MediaCapabilitiesProbe;
}

function defaultMediaSourceTypeProbe(): MediaSourceTypeProbe | null {
  if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
    return null;
  }
  return MediaSource;
}

function defaultMatchMediaProbe(): MatchMediaProbe | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia.bind(window);
}

function defaultUserAgent() {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
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

function isMp4Audio(codec: string, supportedAudioCodecs: readonly string[] = ['aac', 'mp3']) {
  return !codec || supportedAudioCodecs.includes(codec);
}

// AV1 in an mp4 container is also commonly muxed with opus/flac by some archivers.
function isExtendedMp4Audio(codec: string, supportedAudioCodecs?: readonly string[]) {
  return isMp4Audio(codec, supportedAudioCodecs) || codec === 'opus' || codec === 'flac';
}

function videoCodecProbeString(videoCodec: string) {
  return videoCodec === 'av1' ? AV1_PROBE_CODEC : videoCodec;
}

function sourceVideoStream(source: JellyfinMediaSource) {
  return source.MediaStreams?.find((stream) => stream.Type === 'Video');
}

function sourceVideoCodec(source: JellyfinMediaSource) {
  return normalizeCodec(sourceVideoStream(source)?.Codec);
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
  extension: string = directStreamExtension(source),
  supportedMp4AudioCodecs: readonly string[] = ['aac', 'mp3']
): boolean {
  if (source.SupportsDirectPlay === false || !extension) return false;
  const videoCodec = sourceVideoCodec(source);
  const audioCodec = sourceAudioCodec(source);

  if (extension === 'mp4') {
    if (!videoCodec) return canPlay(video, 'video/mp4');
    if (videoCodec === 'h264' && isMp4Audio(audioCodec, supportedMp4AudioCodecs)) {
      return (
        canPlay(video, 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || canPlay(video, 'video/mp4')
      );
    }
    if (videoCodec === 'hevc' && isMp4Audio(audioCodec, supportedMp4AudioCodecs)) {
      const stream = sourceVideoStream(source);
      const codec = stream ? hevcCodecString(stream) : '';
      if (codec && canPlay(video, `video/mp4; codecs="${codec}"`)) return true;
      const needsExactProbe = Boolean(
        stream && ((stream.BitDepth ?? 8) > 8 || (stream.Level ?? 0) > 120 || isHdrVideoSource(source))
      );
      return !needsExactProbe &&
        HEVC_PROBE_CODECS.some((probeCodec) => canPlay(video, `video/mp4; codecs="${probeCodec}"`));
    }
    if (videoCodec === 'av1' && isExtendedMp4Audio(audioCodec, supportedMp4AudioCodecs)) {
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

function positiveNumber(...values: Array<number | undefined>) {
  return values.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
}

function inferredHevcLevel(width: number, height: number) {
  if (width > 3840 || height > 2160) return 153;
  if (width > 1920 || height > 1080) return 150;
  return 120;
}

export function hevcCodecString(stream: JellyfinMediaStream) {
  const profile = (stream.Profile ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const main10 = profile.includes('main10') || (stream.BitDepth ?? 8) > 8;
  const profileId = main10 ? 2 : 1;
  const compatibilityFlags = main10 ? 4 : 6;
  const level = Math.round(
    positiveNumber(stream.Level) ?? inferredHevcLevel(stream.Width ?? 0, stream.Height ?? 0)
  );
  return `hvc1.${profileId}.${compatibilityFlags}.L${level}.B0`;
}

function dolbyVisionCodecString(stream: JellyfinMediaStream) {
  const profile = Math.round(positiveNumber(stream.DvProfile) ?? 0);
  const inferredLevel = (stream.Width ?? 0) > 1920 || (stream.Height ?? 0) > 1080
    ? 6
    : (stream.Width ?? 0) > 1280 || (stream.Height ?? 0) > 720
      ? 3
      : 1;
  const level = Math.round(positiveNumber(stream.DvLevel) ?? inferredLevel);
  if (!profile || !level) return '';
  return `dvh1.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}`;
}

function av1ProfileNumber(profile?: string) {
  const normalized = (profile ?? '').toLowerCase();
  if (normalized.includes('professional')) return 2;
  if (normalized.includes('high')) return 1;
  return 0;
}

function inferredAv1Level(width: number, height: number, framerate: number) {
  const pixels = width * height;
  if (pixels > 1920 * 1080) return framerate > 30 ? 13 : 12;
  if (pixels >= 1920 * 1080) return framerate > 30 ? 9 : 8;
  return 5;
}

function av1CodecString(
  stream: JellyfinMediaStream,
  width: number,
  height: number,
  framerate: number
) {
  const profile = av1ProfileNumber(stream.Profile);
  const level = Math.round(
    positiveNumber(stream.Level) ?? inferredAv1Level(width, height, framerate)
  );
  const bitDepth = Math.round(positiveNumber(stream.BitDepth) ?? 8);
  return `av01.${profile}.${String(level).padStart(2, '0')}M.${String(bitDepth).padStart(2, '0')}`;
}

function inferredVp9Level(width: number, height: number, framerate: number) {
  const pixels = width * height;
  if (pixels > 2560 * 1440) return framerate > 30 ? 51 : 50;
  if (pixels > 1920 * 1080) return framerate > 30 ? 41 : 40;
  return framerate > 30 ? 40 : 31;
}

function vp9CodecString(
  stream: JellyfinMediaStream,
  width: number,
  height: number,
  framerate: number
) {
  const level = Math.round(
    positiveNumber(stream.Level) ?? inferredVp9Level(width, height, framerate)
  );
  const bitDepth = Math.round(positiveNumber(stream.BitDepth) ?? 8);
  return `vp09.00.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
}

function mediaCapabilitiesCodecString(
  stream: JellyfinMediaStream,
  width: number,
  height: number,
  framerate: number
) {
  switch (normalizeCodec(stream.Codec)) {
    case 'av1':
      return av1CodecString(stream, width, height, framerate);
    case 'hevc':
      return hevcCodecString(stream);
    case 'h264':
      return 'avc1.42E01E';
    case 'vp9':
      return vp9CodecString(stream, width, height, framerate);
    case 'vp8':
      return 'vp8';
    default:
      return '';
  }
}

export function sourceVideoRangeType(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  const explicit = stream?.VideoRangeType?.trim();
  // Some Jellyfin/ffprobe combinations expose only the broad `HDR` range even
  // though the transfer characteristics identify the concrete format. Keep
  // authoritative format names, but let generic/unknown values fall through to
  // the bitstream metadata below so PQ content is reported as HDR10.
  const normalizedExplicit = (explicit ?? '')
    .toUpperCase()
    .replace(/\+/g, 'PLUS')
    .replace(/[^A-Z0-9]/g, '');
  if (explicit && normalizedExplicit !== 'HDR' && normalizedExplicit !== 'UNKNOWN') {
    if (normalizedExplicit === 'HDR10PLUS') return 'HDR10Plus';
    return explicit;
  }
  if ((stream?.DvProfile ?? 0) > 0) {
    if (stream?.Hdr10PlusPresentFlag) return 'DOVIWithHDR10Plus';
    if (stream?.DvBlSignalCompatibilityId === 1) return 'DOVIWithHDR10';
    return 'DOVI';
  }
  if (stream?.Hdr10PlusPresentFlag) return 'HDR10Plus';
  const transfer = (stream?.ColorTransfer ?? '').toLowerCase();
  if (transfer.includes('2084') || transfer === 'pq') return 'HDR10';
  if (transfer.includes('b67') || transfer === 'hlg') return 'HLG';
  if (normalizedExplicit === 'HDR' || (stream?.VideoRange ?? '').toUpperCase() === 'HDR') {
    return 'HDR';
  }
  return 'SDR';
}

export function isHdrVideoSource(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  const rangeType = sourceVideoRangeType(source).toUpperCase();
  return rangeType !== 'SDR' || (stream?.VideoRange ?? '').toUpperCase() === 'HDR';
}

const LARGE_PROGRESSIVE_MP4_BYTES = 4 * 1024 * 1024 * 1024;
const MULTITRACK_PROGRESSIVE_MP4_STREAMS = 12;

// Large distributor MP4s commonly put a multi-megabyte `moov` index after the
// media payload. A remote browser must fetch that tail before showing frame one,
// while Jellyfin can read it locally and emit a small fMP4 initialization segment.
// The API does not expose atom placement, so size and track count provide a narrow
// source-level signal without changing ordinary progressive playback.
export function shouldPreferHlsForStartup(source: JellyfinMediaSource) {
  if (directStreamExtension(source) !== 'mp4' || !isHdrVideoSource(source)) return false;
  const size = positiveNumber(source.Size) ?? 0;
  const streamCount = source.MediaStreams?.length ?? 0;
  return size >= LARGE_PROGRESSIVE_MP4_BYTES || streamCount >= MULTITRACK_PROGRESSIVE_MP4_STREAMS;
}

function sourceHasDolbyVision(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  return (stream?.DvProfile ?? 0) > 0 || sourceVideoRangeType(source).toUpperCase().startsWith('DOVI');
}

export function sourceHasDolbyVisionSampleEntry(source: JellyfinMediaSource) {
  const codecTag = (sourceVideoStream(source)?.CodecTag ?? '').trim().toLowerCase();
  return codecTag === 'dvh1' || codecTag === 'dvhe';
}

function sourceHasHdr10CompatibleDolbyVisionBaseLayer(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  const rangeType = sourceVideoRangeType(source).toUpperCase();
  return (
    (stream?.DvProfile === 8 && stream.DvBlSignalCompatibilityId === 1) ||
    rangeType.includes('DOVIWITHHDR10')
  );
}

function sourceHasHdr10Plus(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  return Boolean(stream?.Hdr10PlusPresentFlag) || sourceVideoRangeType(source).toUpperCase().includes('HDR10PLUS');
}

function sourceUsesHlg(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  const transfer = (stream?.ColorTransfer ?? '').toLowerCase();
  return transfer.includes('b67') || transfer === 'hlg' || sourceVideoRangeType(source).toUpperCase().includes('HLG');
}

function hdrVideoConfiguration(source: JellyfinMediaSource) {
  if (!isHdrVideoSource(source)) return {};
  if (sourceUsesHlg(source)) {
    return {
      colorGamut: 'rec2020' as const,
      transferFunction: 'hlg' as const
    };
  }
  return {
    colorGamut: 'rec2020' as const,
    transferFunction: 'pq' as const,
    // Media Capabilities has no Dolby Vision enum. Probe Dolby Vision separately and
    // describe its HDR10-compatible base layer here instead of asking for HDR10+.
    hdrMetadataType: sourceHasHdr10Plus(source) && !sourceHasDolbyVision(source)
      ? 'smpteSt2094-40' as const
      : 'smpteSt2086' as const
  };
}

// Builds the stream-specific Media Capabilities query used by Auto playback. Unlike
// canPlayType, this lets the browser account for resolution, frame rate, and bitrate.
export function mediaCapabilitiesVideoConfiguration(
  source: JellyfinMediaSource,
  options: {
    extension?: 'mp4' | 'webm';
    type?: MediaCapabilitiesVideoConfiguration['type'];
    includeHdr?: boolean;
  } = {}
): MediaCapabilitiesVideoConfiguration | null {
  const stream = sourceVideoStream(source);
  const width = positiveNumber(stream?.Width);
  const height = positiveNumber(stream?.Height);
  const bitrate = positiveNumber(stream?.BitRate, source.Bitrate);
  const framerate = positiveNumber(stream?.AverageFrameRate, stream?.RealFrameRate) ?? 30;
  const extension = options.extension ?? directStreamExtension(source);
  if (!stream || !width || !height || !bitrate || !extension) return null;

  const codec = mediaCapabilitiesCodecString(stream, width, height, framerate);
  if (!codec) return null;
  const mime = extension === 'webm' ? 'video/webm' : 'video/mp4';
  return {
    type: options.type ?? 'file',
    video: {
      contentType: `${mime}; codecs="${codec}"`,
      width: Math.round(width),
      height: Math.round(height),
      bitrate: Math.round(bitrate),
      framerate,
      ...(options.includeHdr ? hdrVideoConfiguration(source) : {})
    }
  };
}

function supportsNativeHls(video: VideoProbe) {
  return canPlay(video, 'application/vnd.apple.mpegurl') || canPlay(video, 'application/x-mpegURL');
}

export function hasKnownBrokenFmp4Hls(userAgent: string) {
  return /Firefox\/149(?:\.|\s|$)/i.test(userAgent);
}

function supportsHighDynamicRange(matchMedia: MatchMediaProbe | null) {
  if (!matchMedia) return false;
  try {
    return matchMedia('(dynamic-range: high)').matches;
  } catch {
    return false;
  }
}

function supportsFmp4AudioCodec(
  codec: 'ac-3' | 'ec-3',
  video: VideoProbe,
  nativeHls: boolean,
  mediaSource: MediaSourceTypeProbe | null
) {
  if (!canPlay(video, `audio/mp4; codecs="${codec}"`)) return false;
  if (nativeHls) return true;
  try {
    return Boolean(mediaSource?.isTypeSupported(`audio/mp4; codecs="${codec}"`));
  } catch {
    return false;
  }
}

// Detects the source-specific fMP4 HLS route that can change only the container while
// preserving the encoded HEVC frames. HDR sources require an HDR output. Dolby Vision
// is used only when the browser reports it exactly; MSE browsers may instead decode a
// Profile 8.1 stream's explicitly HDR10-compatible base layer.
export async function detectHlsRemuxCapabilities(
  source: JellyfinMediaSource,
  environment: HlsRemuxEnvironment = {}
): Promise<HlsRemuxCapabilities | null> {
  const stream = sourceVideoStream(source);
  if (!stream || sourceVideoCodec(source) !== 'hevc' || stream.IsInterlaced) return null;

  const video = environment.video ?? defaultProbe();
  const mediaSource = environment.mediaSource === undefined
    ? defaultMediaSourceTypeProbe()
    : environment.mediaSource;
  const matchMedia = environment.matchMedia === undefined
    ? defaultMatchMediaProbe()
    : environment.matchMedia;
  const userAgent = environment.userAgent ?? defaultUserAgent();
  if (hasKnownBrokenFmp4Hls(userAgent)) return null;

  const hevcCodec = hevcCodecString(stream);
  const hevcMime = `video/mp4; codecs="${hevcCodec}"`;
  if (!canPlay(video, hevcMime)) return null;

  const nativeHls = supportsNativeHls(video);
  let mseHevc = false;
  if (!nativeHls) {
    try {
      mseHevc = Boolean(mediaSource?.isTypeSupported(hevcMime));
    } catch {
      return null;
    }
    if (!mseHevc) return null;
  }

  const dolbyVisionSource = sourceHasDolbyVision(source);
  const hdr10CompatibleBaseLayer =
    dolbyVisionSource && sourceHasHdr10CompatibleDolbyVisionBaseLayer(source);
  let dolbyVision = false;
  if (dolbyVisionSource) {
    const dolbyCodec = dolbyVisionCodecString(stream);
    // The server signals Profile 8 as a supplemental codec. Native HLS understands
    // this pairing. On MSE, hls.js passes through the HEVC base layer; only an
    // explicitly HDR10-compatible Profile 8.1 base is safe to use without DV output.
    dolbyVision = Boolean(
      nativeHls && dolbyCodec && canPlay(video, `video/mp4; codecs="${dolbyCodec}"`)
    );
    if (!dolbyVision && !(mseHevc && hdr10CompatibleBaseLayer)) {
      return null;
    }
  }

  const hdr = isHdrVideoSource(source);
  if (hdr && !supportsHighDynamicRange(matchMedia)) return null;

  const audioCodecs = ['aac'];
  if (supportsFmp4AudioCodec('ac-3', video, nativeHls, mediaSource)) audioCodecs.push('ac3');
  if (supportsFmp4AudioCodec('ec-3', video, nativeHls, mediaSource)) audioCodecs.push('eac3');

  let autoPrefer = true;
  const mediaCapabilities = environment.mediaCapabilities === undefined
    ? defaultMediaCapabilitiesProbe()
    : environment.mediaCapabilities;
  if (mediaCapabilities) {
    const configuration = mediaCapabilitiesVideoConfiguration(source, {
      extension: 'mp4',
      type: nativeHls ? 'file' : 'media-source',
      includeHdr: true
    });
    if (configuration) {
      try {
        const result = await mediaCapabilities.decodingInfo(configuration);
        autoPrefer = result.supported && result.smooth;
      } catch {
        // Exact codec/HDR probes above are still sufficient to offer and prefer the
        // original stream when Media Capabilities is absent or incomplete.
      }
    }
  }

  const rangeType = sourceVideoRangeType(source);
  return {
    videoCodec: 'hevc',
    videoRangeTypes: [...new Set(['SDR', rangeType])],
    maxVideoLevel: Math.round(
      positiveNumber(stream.Level) ?? inferredHevcLevel(stream.Width ?? 0, stream.Height ?? 0)
    ),
    audioCodecs,
    maxAudioChannels: audioCodecs.some((codec) => codec === 'ac3' || codec === 'eac3') ? 6 : 2,
    hdr,
    dolbyVisionSource,
    dolbyVision,
    hdr10CompatibleBaseLayer,
    hdr10Plus: sourceHasHdr10Plus(source),
    preferHlsForStartup: shouldPreferHlsForStartup(source),
    autoPrefer
  };
}

const VIDEO_COPY_TRANSCODE_REASONS = new Set([
  '',
  'ContainerNotSupported',
  'AudioCodecNotSupported',
  'AudioIsExternal',
  'SecondaryAudioNotSupported',
  'AudioChannelsNotSupported',
  'AudioBitrateNotSupported',
  'AudioBitDepthNotSupported',
  'AudioProfileNotSupported',
  'AudioSampleRateNotSupported',
  'UnknownAudioStreamInfo'
]);

export function isNegotiatedHlsRemux(
  source: JellyfinMediaSource,
  capabilities: HlsRemuxCapabilities | null | undefined,
  audioStreamIndex?: number
) {
  if (!capabilities || !source.TranscodingUrl) return false;
  let url: URL;
  try {
    url = new URL(source.TranscodingUrl, 'http://jellytube.invalid');
  } catch {
    return false;
  }

  const segmentContainer = (
    url.searchParams.get('SegmentContainer') ?? source.TranscodingContainer ?? ''
  ).toLowerCase();
  const videoCodecs = (url.searchParams.get('VideoCodec') ?? '')
    .toLowerCase()
    .split(',')
    .map((codec) => codec.trim());
  if (
    segmentContainer !== 'mp4' ||
    videoCodecs.length !== 1 ||
    videoCodecs[0] !== capabilities.videoCodec
  ) {
    return false;
  }
  if ((url.searchParams.get('AllowVideoStreamCopy') ?? '').toLowerCase() === 'false') return false;

  const negotiatedAudioValue = url.searchParams.get('AudioStreamIndex');
  const negotiatedAudioIndex = negotiatedAudioValue === null ? undefined : Number(negotiatedAudioValue);
  if (
    negotiatedAudioValue === null &&
    audioStreamIndex !== undefined &&
    source.DefaultAudioStreamIndex !== undefined &&
    audioStreamIndex !== source.DefaultAudioStreamIndex
  ) {
    return false;
  }
  if (
    audioStreamIndex !== undefined &&
    negotiatedAudioIndex !== undefined &&
    Number.isFinite(negotiatedAudioIndex) &&
    negotiatedAudioIndex !== audioStreamIndex
  ) {
    return false;
  }

  const reasons = (url.searchParams.get('TranscodeReasons') ?? '')
    .split(',')
    .map((reason) => reason.trim());
  return reasons.every(
    (reason) =>
      VIDEO_COPY_TRANSCODE_REASONS.has(reason) ||
      (reason === 'DirectPlayError' && capabilities.preferHlsForStartup)
  );
}

export function hlsRemuxVideoPreference(
  capabilities: HlsRemuxCapabilities | null | undefined
): HlsVideoPreference | undefined {
  if (!capabilities?.hdr) return undefined;
  const hlg = capabilities.videoRangeTypes.some((range) => range.toUpperCase().includes('HLG'));
  return {
    preferHDR: true,
    allowedVideoRanges: [hlg ? 'HLG' : 'PQ']
  };
}

// hls.js correctly treats Dolby Vision supplemental codec support as preferable to
// the base codec, but marks that level unsupported when Firefox exposes only HEVC.
// Profile 8.1 explicitly permits the HDR10 base layer to be decoded independently,
// so lock that one verified PQ/HEVC rendition instead of letting ABR discard it.
export function hlsRemuxBaseLayerLevel(
  levels: readonly HlsManifestLevel[],
  capabilities: HlsRemuxCapabilities | null | undefined
) {
  if (
    !capabilities?.dolbyVisionSource ||
    capabilities.dolbyVision ||
    !capabilities.hdr10CompatibleBaseLayer
  ) {
    return -1;
  }
  return levels.findIndex((level) => {
    const range = (level.videoRange ?? level.attrs?.['VIDEO-RANGE'] ?? '').toUpperCase();
    const codec = (level.videoCodec ?? level.attrs?.CODECS ?? '').toLowerCase();
    return range === 'PQ' && (codec.includes('hvc1') || codec.includes('hev1'));
  });
}

function isDemandingVideoSource(source: JellyfinMediaSource) {
  const stream = sourceVideoStream(source);
  const width = positiveNumber(stream?.Width) ?? 0;
  const height = positiveNumber(stream?.Height) ?? 0;
  const bitrate = positiveNumber(stream?.BitRate, source.Bitrate) ?? 0;
  const framerate = positiveNumber(stream?.AverageFrameRate, stream?.RealFrameRate) ?? 30;
  return (
    width >= 2560 ||
    height >= 1440 ||
    (width >= 1920 && height >= 1080 && framerate >= 50) ||
    bitrate >= 20_000_000
  );
}

function needsConservativeCapabilityFallback(source: JellyfinMediaSource) {
  const codec = sourceVideoCodec(source);
  return codec === 'av1' || codec === 'hevc' || codec === 'vp9';
}

// Auto can direct-play ordinary sources immediately. For demanding sources, it only
// prefers the original file when the browser confirms decoding will be supported,
// smooth, and power efficient. Explicit Original playback remains available.
export async function shouldPreferDirectPlayForAuto(
  source: JellyfinMediaSource,
  probe: MediaCapabilitiesProbe | null = defaultMediaCapabilitiesProbe()
) {
  if (!isDemandingVideoSource(source)) return true;

  const configuration = mediaCapabilitiesVideoConfiguration(source);
  if (!configuration || !probe) return !needsConservativeCapabilityFallback(source);

  try {
    const result = await probe.decodingInfo(configuration);
    return result.supported && result.smooth && result.powerEfficient;
  } catch {
    return !needsConservativeCapabilityFallback(source);
  }
}
