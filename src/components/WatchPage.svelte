<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type Hls from 'hls.js';
  import {
    ArrowLeft,
    Check,
    Loader2,
    Maximize,
    Minimize,
    Pause,
    Play,
    Ratio,
    Repeat,
    RotateCcw,
    RectangleHorizontal,
    Settings,
    Sparkles,
    SkipBack,
    SkipForward,
    TriangleAlert,
    Volume2,
    VolumeX
  } from 'lucide-svelte';
  import type { JellyfinClient, PlaybackEventPayload } from '../lib/jellyfin';
  import {
    channelName,
    compactMeta,
    displayTitle,
    formatDuration,
    playbackProgress,
    shouldStartFromBeginning
  } from '../lib/recommendations';
  import {
    CINEMATIC_FAILURE_LIMIT,
    CINEMATIC_FALLBACK_STYLE,
    CINEMATIC_SAMPLE_HEIGHT,
    CINEMATIC_SAMPLE_INTERVAL_MS,
    CINEMATIC_SAMPLE_WIDTH,
    blendCinematicGlowPalette,
    cinematicColorsFromPalette,
    cinematicGlowStyle,
    cinematicPaletteFromImageData,
    cinematicPalettesAreClose,
    type CinematicGlowPalette,
    shouldSampleCinematicGlow
  } from '../lib/cinematicGlow';
  import { episodeCode, episodeInfo, type EpisodeSeason } from '../lib/episodes';
  import {
    playbackQualityById,
    playbackQualityOptions,
    type PlaybackQualityId,
    type PlaybackQualityOption
  } from '../lib/playbackQuality';
  import type { JellyfinItem, JellyfinMediaSource, JellyfinMediaStream } from '../lib/types';
  import VideoCard from './VideoCard.svelte';

  export let client: JellyfinClient;
  export let item: JellyfinItem;
  export let autoplay = false;
  export let queue: JellyfinItem[] = [];
  export let queueTitle = '';
  export let episodeSeasons: EpisodeSeason[] = [];
  export let selectedEpisodeSeason = 0;
  export let episodeSeriesTitle = '';
  export let recommendations: JellyfinItem[] = [];

  const dispatch = createEventDispatcher<{
    select: JellyfinItem;
    queueSelect: JellyfinItem;
    episodeSelect: JellyfinItem;
    episodeSeason: number;
    back: void;
    channel: string;
    movies: void;
    next: void;
    finished: JellyfinItem;
  }>();

  type PlaybackAttempt = {
    url: string;
    label: string;
    detail: string;
    qualityId: PlaybackQualityId;
    mediaKind: 'direct' | 'hls';
    playMethod: PlaybackEventPayload['PlayMethod'];
  };

  type WebKitVideoElement = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
    webkitSupportsFullscreen?: boolean;
    webkitDisplayingFullscreen?: boolean;
  };

  type WebKitFullscreenElement = HTMLDivElement & {
    webkitRequestFullscreen?: () => void;
  };

  type WebKitDocument = Document & {
    webkitFullscreenElement?: Element | null;
    webkitFullscreenEnabled?: boolean;
    webkitExitFullscreen?: () => void;
  };

  type CinematicAvailability = 'idle' | 'dynamic' | 'unavailable';

  let video: WebKitVideoElement;
  let playerShell: WebKitFullscreenElement;
  let loading = true;
  let buffering = false;
  let error = '';
  let fallbackNotice = '';
  let detailedItem: JellyfinItem = item;
  let mediaSource: JellyfinMediaSource | null = null;
  let playSessionId = '';
  let playMethod: PlaybackEventPayload['PlayMethod'] = 'DirectPlay';
  let hls: Hls | null = null;
  let progressTimer = 0;
  let started = false;
  let attempts: PlaybackAttempt[] = [];
  let attemptIndex = 0;
  let activeAttempt: PlaybackAttempt | null = null;
  let playRequested = false;
  let suppressMediaErrors = false;
  let hlsRecovered = false;
  let seekApplied = false;
  let resumeSeconds = 0;
  let controlsVisible = true;
  let controlsTimer = 0;
  let clickTimer = 0;
  let autoplayNext = localStorage.getItem('jellytube.autoplayNext') !== 'false';
  let preferredQualityId = savedQualityId();
  let selectedQualityId = preferredQualityId;
  let qualityOptions: PlaybackQualityOption[] = [];
  let qualityMenuOpen = false;
  let ultrawideCrop = localStorage.getItem('jellytube.ultrawideCrop') === 'true';
  let cinematicMode = localStorage.getItem('jellytube.cinematicMode') === 'true';
  let theaterMode = localStorage.getItem('jellytube.theaterMode') === 'true';
  let loopMusicVideo = localStorage.getItem('jellytube.loopMusicVideo') === 'true';

  function toggleTheaterMode() {
    theaterMode = !theaterMode;
    localStorage.setItem('jellytube.theaterMode', String(theaterMode));
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  let cinematicStyle = CINEMATIC_FALLBACK_STYLE;
  let cinematicTimer = 0;
  let cinematicFailures = 0;
  let cinematicBlocked = false;
  let cinematicAvailability: CinematicAvailability = 'idle';
  let cinematicCanvas: HTMLCanvasElement | null = null;
  let cinematicContext: CanvasRenderingContext2D | null = null;
  let cinematicAnimationFrame = 0;
  let cinematicPalette: CinematicGlowPalette | null = null;
  let cinematicRenderedPalette: CinematicGlowPalette | null = null;
  let lastCinematicSampleTime = -1;
  let isPlaying = false;
  let isMuted = localStorage.getItem('jellytube.playerMuted') === 'true';
  let volume = savedVolume();
  let currentTime = 0;
  let duration = 0;
  let bufferedPercent = 0;
  let fullscreen = false;
  let scrolledEpisodeId = '';

  $: currentEpisodeCode = episodeCode(detailedItem);
  $: progress = playbackProgress(detailedItem);
  $: durationSeconds = duration || ticksToSeconds(detailedItem.RunTimeTicks);
  $: progressPercent = durationSeconds > 0 ? Math.min(100, (currentTime / durationSeconds) * 100) : 0;
  $: seekMax = durationSeconds || 0;
  $: seekStyle = `--progress: ${progressPercent}%; --buffered: ${Math.max(bufferedPercent, progressPercent)}%;`;
  $: sourceLabel = activeAttempt?.label ?? 'Preparing';
  $: selectedQuality = playbackQualityById(qualityOptions, selectedQualityId);
  $: qualityButtonLabel = selectedQuality?.label ?? 'Auto';
  $: queueIndex = queue.findIndex((queueItem) => queueItem.Id === item.Id);
  $: hasNextQueued = queueIndex >= 0 && queueIndex < queue.length - 1;
  $: upcomingQueue = queueIndex >= 0 ? queue.slice(queueIndex + 1) : queue;
  $: hasEpisodeShelf = episodeSeasons.length > 0;
  $: recommendationAutoplayItem = recommendations.find(
    (recommendation) =>
      recommendation.Id !== item.Id && !queue.some((queueItem) => queueItem.Id === recommendation.Id)
  );
  $: showRecommendationAutoplayToggle = Boolean(
    recommendationAutoplayItem && !hasEpisodeShelf && queue.length <= 1
  );
  $: isMovie = detailedItem.Type === 'Movie' || detailedItem.contentKind === 'movie';
  $: isMusicVideo = detailedItem.Type === 'MusicVideo' || detailedItem.contentKind === 'musicVideo';
  $: contextLabel = isMovie ? detailedItem.sourceLibraryName || 'YouTube Movies' : channelName(detailedItem);
  $: title = displayTitle(detailedItem, {
    context: detailedItem.Type === 'Episode' ? 'series' : isMovie ? 'feed' : 'channel',
    channel: contextLabel
  });
  $: selectedEpisodeItems =
    episodeSeasons.find((season) => season.season === selectedEpisodeSeason)?.items ??
    episodeSeasons[0]?.items ??
    [];
  $: cinematicReady = cinematicMode && cinematicAvailability === 'dynamic';
  $: cinematicControlLabel =
    cinematicMode && cinematicAvailability === 'unavailable'
      ? 'Cinematic glow unavailable for this stream'
      : cinematicMode
        ? 'Disable cinematic glow'
        : 'Enable cinematic glow';
  $: cinematicControlTitle =
    cinematicMode && cinematicAvailability === 'unavailable'
      ? 'Cinematic glow unavailable for this stream'
      : cinematicMode && cinematicAvailability === 'dynamic'
        ? 'Cinematic glow on'
        : cinematicMode
          ? 'Cinematic glow warming up'
          : 'Cinematic glow off';

  onMount(() => {
    video?.setAttribute('webkit-playsinline', 'true');
    void loadPlayback(autoplay);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    video?.addEventListener('webkitbeginfullscreen', handleFullscreenChange);
    video?.addEventListener('webkitendfullscreen', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      video?.removeEventListener('webkitbeginfullscreen', handleFullscreenChange);
      video?.removeEventListener('webkitendfullscreen', handleFullscreenChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  onDestroy(() => {
    clearCinematicTimer();
    void stopPlayback();
  });

  afterUpdate(() => {
    if (!hasEpisodeShelf || scrolledEpisodeId === item.Id) return;
    scrolledEpisodeId = item.Id;
    window.setTimeout(() => {
      playerShell
        ?.closest('.watch-main')
        ?.querySelector('.episode-tile.active')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, 0);
  });

  async function loadPlayback(autoPlay = false) {
    loading = true;
    buffering = false;
    error = '';
    fallbackNotice = '';
    qualityMenuOpen = false;
    currentTime = 0;
    bufferedPercent = 0;
    duration = 0;
    resetCinematicGlow();
    await stopPlayback();
    playRequested = autoPlay;
    await tick();

    try {
      detailedItem = {
        ...(await client.getItem(item.Id)),
        sourceLibraryId: item.sourceLibraryId,
        sourceLibraryName: item.sourceLibraryName,
        sourceCollectionType: item.sourceCollectionType,
        contentKind: item.contentKind
      };
      const startTicks = shouldStartFromBeginning(detailedItem)
        ? 0
        : detailedItem.UserData?.PlaybackPositionTicks ?? 0;
      resumeSeconds = startTicks / 10_000_000;
      const playbackInfo = await client.getPlaybackInfo(item.Id, startTicks);
      mediaSource = playbackInfo.MediaSources[0] ?? null;
      playSessionId = playbackInfo.PlaySessionId ?? '';
      if (!mediaSource) throw new Error('No playable media source was returned by Jellyfin.');

      qualityOptions = playbackQualityOptions(mediaSource, { directAvailable: Boolean(getDirectAttempt(mediaSource)) });
      selectedQualityId = playbackQualityById(qualityOptions, preferredQualityId)?.id ?? 'auto';
      attempts = buildPlaybackAttempts(mediaSource, selectedQualityId);
      if (!attempts.length) {
        throw new Error('Jellyfin did not return a browser-compatible direct stream or HLS transcode option.');
      }

      await startAttempt(0, autoPlay);
    } catch (caught) {
      loading = false;
      buffering = false;
      error = caught instanceof Error ? caught.message : 'Could not prepare playback.';
    }
  }

  function buildPlaybackAttempts(source: JellyfinMediaSource, qualityId: string | null | undefined = selectedQualityId) {
    const nextAttempts: PlaybackAttempt[] = [];
    const directAttempt = getDirectAttempt(source);
    const quality = playbackQualityById(qualityOptions, qualityId);

    if (quality?.mode === 'direct') {
      if (directAttempt) nextAttempts.push(directAttempt);
      const fallbackHlsAttempt = getHlsAttempt(source);
      if (fallbackHlsAttempt) nextAttempts.push(fallbackHlsAttempt);
      return nextAttempts;
    }

    if (quality?.mode === 'hls') {
      const hlsAttempt = getHlsAttempt(source, quality);
      if (hlsAttempt) nextAttempts.push(hlsAttempt);
      return nextAttempts;
    }

    if (directAttempt) nextAttempts.push(directAttempt);
    const hlsAttempt = getHlsAttempt(source);
    if (hlsAttempt) nextAttempts.push(hlsAttempt);
    return nextAttempts;
  }

  function getDirectAttempt(source: JellyfinMediaSource): PlaybackAttempt | null {
    if (source.SupportsDirectPlay === false) return null;
    const extension = directStreamExtension(source);
    if (!extension) return null;
    const playable = canDirectPlay(source, extension);
    if (!playable) return null;

    return {
      url: client.getStreamUrl(item.Id, source.Id, extension),
      label: 'Original',
      detail: mediaSummary(source),
      qualityId: 'direct',
      mediaKind: 'direct',
      playMethod: 'DirectPlay'
    };
  }

  function getHlsAttempt(source: JellyfinMediaSource, quality?: PlaybackQualityOption): PlaybackAttempt | null {
    if (source.SupportsTranscoding === false) return null;
    const preferredSize = preferredHlsSize();
    const maxWidth = quality?.maxWidth ?? preferredSize.maxWidth;
    const maxHeight = quality?.maxHeight ?? preferredSize.maxHeight;
    return {
      url: client.getHlsUrl(item.Id, source.Id, {
        startTicks: 0,
        playSessionId,
        audioStreamIndex: source.DefaultAudioStreamIndex,
        subtitleStreamIndex: source.DefaultSubtitleStreamIndex,
        maxWidth,
        maxHeight,
        videoBitrate: quality?.videoBitrate,
        audioBitrate: quality?.audioBitrate
      }),
      label: quality?.label ?? 'Auto',
      detail: quality ? `Jellyfin transcode · ${quality.detail}` : `Jellyfin HLS up to ${maxHeight}p`,
      qualityId: quality?.id ?? 'auto',
      mediaKind: 'hls',
      playMethod: 'Transcode'
    };
  }

  async function startAttempt(index: number, autoPlay = false) {
    const attempt = attempts[index];
    if (!attempt) throw new Error('No playback attempt is available.');

    attemptIndex = index;
    activeAttempt = attempt;
    playMethod = attempt.playMethod;
    loading = true;
    buffering = false;
    error = '';
    seekApplied = false;
    hlsRecovered = false;

    teardownHls();
    clearVideoSource();
    await tick();

    if (attempt.mediaKind === 'hls' && !supportsNativeHls()) {
      const { default: HlsPlayer } = await import('hls.js');
      if (!HlsPlayer.isSupported()) {
        throw new Error('This browser cannot play Jellyfin HLS streams.');
      }
      hls = new HlsPlayer({
        lowLatencyMode: false,
        backBufferLength: 120,
        capLevelToPlayerSize: true,
        maxBufferLength: 45
      });
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && !hlsRecovered) {
          hlsRecovered = true;
          hls?.recoverMediaError();
          return;
        }
        if (data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR && hls) {
          hls.startLoad();
          return;
        }
        void handlePlaybackFailure(`HLS error: ${data.details || data.type}`);
      });
      hls.loadSource(attempt.url);
      hls.attachMedia(video);
    } else {
      video.src = attempt.url;
      video.load();
    }

    applySavedAudioState();
    if (autoPlay) void requestPlay();
    scheduleControls();
  }

  async function handlePlaybackFailure(detail = mediaErrorMessage()) {
    if (suppressMediaErrors) return;
    loading = false;
    buffering = false;

    if (attemptIndex < attempts.length - 1) {
      const failedLabel = activeAttempt?.label ?? 'The stream';
      const nextAttempt = attempts[attemptIndex + 1];
      const nextLabel = nextAttempt?.label ?? 'Jellyfin HLS';
      fallbackNotice = `${failedLabel} was rejected by this browser. Switched to ${nextLabel}.`;
      if (nextAttempt) selectedQualityId = nextAttempt.qualityId;
      await startAttempt(attemptIndex + 1, playRequested);
      return;
    }

    error = `Playback failed. ${detail}`;
    controlsVisible = true;
  }

  async function reportStart() {
    if (started || !mediaSource) return;
    started = true;
    await safeReport('start');
    progressTimer = window.setInterval(() => safeReport('progress'), 10_000);
  }

  async function safeReport(kind: 'start' | 'progress' | 'stop') {
    if (!mediaSource) return;
    const payload = eventPayload();
    try {
      if (kind === 'start') await client.reportPlaybackStart(payload);
      if (kind === 'progress') await client.reportPlaybackProgress({ ...payload, EventName: 'timeupdate' });
      if (kind === 'stop') await client.reportPlaybackStopped(payload);
    } catch {
      // Playback reporting should not interrupt the viewing experience.
    }
  }

  async function finishReporting() {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = 0;
    if (started) await safeReport('stop');
    started = false;
  }

  async function stopPlayback() {
    window.clearTimeout(controlsTimer);
    window.clearTimeout(clickTimer);
    qualityMenuOpen = false;
    await finishReporting();
    teardownHls();
    clearVideoSource();
    playRequested = false;
    isPlaying = false;
    clearCinematicTimer();
  }

  function teardownHls() {
    hls?.destroy();
    hls = null;
  }

  function clearVideoSource() {
    if (!video) return;
    suppressMediaErrors = true;
    video.pause();
    video.removeAttribute('src');
    video.load();
    window.setTimeout(() => {
      suppressMediaErrors = false;
    }, 100);
  }

  function eventPayload(): PlaybackEventPayload {
    const position = Math.round((video?.currentTime ?? 0) * 10_000_000);
    return {
      ItemId: detailedItem.Id,
      MediaSourceId: mediaSource?.Id,
      PlaySessionId: playSessionId,
      PositionTicks: position,
      CanSeek: true,
      IsPaused: video?.paused ?? true,
      IsMuted: video?.muted ?? false,
      VolumeLevel: Math.round((video?.volume ?? 1) * 100),
      PlayMethod: playMethod,
      RepeatMode: 'RepeatNone',
      PlaybackStartTimeTicks: detailedItem.UserData?.PlaybackPositionTicks ?? 0,
      AudioStreamIndex: mediaSource?.DefaultAudioStreamIndex,
      SubtitleStreamIndex: mediaSource?.DefaultSubtitleStreamIndex
    };
  }

  function directStreamExtension(source: JellyfinMediaSource) {
    const container = `${source.Container ?? ''}`.toLowerCase();
    const tokens = container.split(',').map((token) => token.trim());
    if (tokens.includes('mp4') || tokens.includes('m4v')) return 'mp4';
    if (tokens.includes('webm')) return 'webm';
    return null;
  }

  function canDirectPlay(source: JellyfinMediaSource, extension: string) {
    const videoStream = streamOfType(source, 'Video');
    const audioStream = defaultAudioStream(source);
    const videoCodec = normalizeCodec(videoStream?.Codec);
    const audioCodec = normalizeCodec(audioStream?.Codec);

    if (extension === 'mp4') {
      if (videoCodec === 'h264' && isMp4Audio(audioCodec)) {
        return Boolean(
          video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') ||
            video.canPlayType('video/mp4')
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

  function streamOfType(source: JellyfinMediaSource, type: JellyfinMediaStream['Type']) {
    return source.MediaStreams?.find((stream) => stream.Type === type);
  }

  function defaultAudioStream(source: JellyfinMediaSource) {
    return (
      source.MediaStreams?.find(
        (stream) => stream.Type === 'Audio' && stream.Index === source.DefaultAudioStreamIndex
      ) ?? streamOfType(source, 'Audio')
    );
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

  function supportsNativeHls() {
    return Boolean(
      video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')
    );
  }

  function preferredHlsSize() {
    const pixelRatio = window.devicePixelRatio || 1;
    const renderedWidth = playerShell?.clientWidth || 1280;
    const maxWidth = Math.min(1920, Math.max(854, Math.round(renderedWidth * pixelRatio)));
    const maxHeight = Math.min(1080, Math.max(480, Math.round((maxWidth / 16) * 9)));
    return { maxWidth, maxHeight };
  }

  function mediaSummary(source: JellyfinMediaSource) {
    const videoStream = streamOfType(source, 'Video');
    const audioStream = defaultAudioStream(source);
    const resolution = videoStream?.Width && videoStream?.Height ? `${videoStream.Width}x${videoStream.Height}` : '';
    return [source.Container, videoStream?.Codec, audioStream?.Codec, resolution].filter(Boolean).join(' · ');
  }

  function mediaErrorMessage() {
    const code = video?.error?.code;
    const nativeMessage = video?.error?.message;
    const reason =
      code === MediaError.MEDIA_ERR_ABORTED
        ? 'The browser aborted playback.'
        : code === MediaError.MEDIA_ERR_NETWORK
          ? 'The browser lost the media connection.'
          : code === MediaError.MEDIA_ERR_DECODE
            ? 'The browser could not decode this stream.'
            : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
              ? 'The browser rejected this stream format or MIME type.'
              : 'The browser rejected the stream.';
    return nativeMessage ? `${reason} ${nativeMessage}` : reason;
  }

  function handleLoadedMetadata() {
    duration = Number.isFinite(video.duration) ? video.duration : ticksToSeconds(detailedItem.RunTimeTicks);
    if (!seekApplied && resumeSeconds > 1 && duration && resumeSeconds < duration - 1) {
      video.currentTime = resumeSeconds;
      seekApplied = true;
    }
    syncPlaybackState();
    loading = false;
    buffering = false;
    if (cinematicMode) scheduleCinematicSample(180);
  }

  function handlePlay() {
    isPlaying = true;
    playRequested = true;
    buffering = false;
    if (fallbackNotice.startsWith('Autoplay was blocked')) fallbackNotice = '';
    void reportStart();
    scheduleControls();
    scheduleCinematicSample(160);
  }

  function handlePause() {
    isPlaying = false;
    buffering = false;
    controlsVisible = true;
    clearCinematicTimer();
    void safeReport('progress');
  }

  function handleEnded() {
    isPlaying = false;
    playRequested = false;
    controlsVisible = true;
    clearCinematicTimer();
    dispatch('finished', detailedItem);
    void finishReporting();
    if (isMusicVideo && loopMusicVideo) {
      video.currentTime = 0;
      void requestPlay();
      return;
    }
    if (!autoplayNext) return;
    if (hasNextQueued) {
      dispatch('next');
      return;
    }
    if (recommendationAutoplayItem) dispatch('select', recommendationAutoplayItem);
  }

  function syncPlaybackState() {
    currentTime = video?.currentTime || 0;
    duration = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : durationSeconds;
    isMuted = video?.muted ?? false;
    volume = video?.volume ?? volume;
    syncBuffered();
  }

  function handleVolumeChange() {
    syncPlaybackState();
    persistAudioState();
  }

  function syncBuffered() {
    if (!video || !durationSeconds || video.buffered.length === 0) {
      bufferedPercent = 0;
      return;
    }
    let end = 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= currentTime && video.buffered.end(index) >= currentTime) {
        end = video.buffered.end(index);
        break;
      }
      end = Math.max(end, video.buffered.end(index));
    }
    bufferedPercent = Math.min(100, (end / durationSeconds) * 100);
  }

  async function requestPlay() {
    if (!video || error) return;
    try {
      await video.play();
    } catch (caught) {
      playRequested = false;
      const message = caught instanceof Error ? caught.message : 'The browser blocked playback.';
      if (caught instanceof DOMException && caught.name === 'NotAllowedError') {
        fallbackNotice = 'Autoplay was blocked by the browser. Press play to continue.';
        controlsVisible = true;
        isPlaying = false;
        return;
      }
      error = message;
      controlsVisible = true;
    }
  }

  function togglePlay() {
    if (!video || error) return;
    playerShell?.focus();
    if (video.paused || video.ended) {
      void requestPlay();
    } else {
      video.pause();
    }
  }

  function handlePlayerClick() {
    if (qualityMenuOpen) {
      qualityMenuOpen = false;
      scheduleControls();
      return;
    }
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
      togglePlay();
      clickTimer = 0;
    }, 220);
  }

  function handlePlayerDoubleClick() {
    window.clearTimeout(clickTimer);
    clickTimer = 0;
    playerShell?.focus();
    void toggleFullscreen();
  }

  function toggleAutoplayNext() {
    autoplayNext = !autoplayNext;
    localStorage.setItem('jellytube.autoplayNext', String(autoplayNext));
  }

  function toggleLoopMusicVideo() {
    loopMusicVideo = !loopMusicVideo;
    localStorage.setItem('jellytube.loopMusicVideo', String(loopMusicVideo));
  }

  function toggleQualityMenu(event: MouseEvent) {
    event.stopPropagation();
    qualityMenuOpen = !qualityMenuOpen;
    controlsVisible = true;
    if (!qualityMenuOpen) scheduleControls();
  }

  async function selectQuality(event: MouseEvent, option: PlaybackQualityOption) {
    event.stopPropagation();
    qualityMenuOpen = false;
    controlsVisible = true;
    if (!mediaSource || option.id === selectedQualityId) {
      scheduleControls();
      return;
    }

    const previousQualityId = selectedQualityId;
    const previousPreferredQualityId = preferredQualityId;
    const previousTime = video?.currentTime ?? currentTime;
    const shouldResume = Boolean(video && !video.paused && !video.ended) || playRequested;
    preferredQualityId = option.id;
    selectedQualityId = option.id;
    localStorage.setItem('jellytube.playerQuality', preferredQualityId);
    resumeSeconds = Number.isFinite(previousTime) ? previousTime : 0;
    currentTime = resumeSeconds;
    attempts = buildPlaybackAttempts(mediaSource, selectedQualityId);

    if (!attempts.length) {
      preferredQualityId = previousPreferredQualityId;
      selectedQualityId = previousQualityId;
      localStorage.setItem('jellytube.playerQuality', preferredQualityId);
      fallbackNotice = `${option.label} is not available for this video.`;
      scheduleControls();
      return;
    }

    try {
      await startAttempt(0, shouldResume);
    } catch (caught) {
      preferredQualityId = previousPreferredQualityId;
      selectedQualityId = previousQualityId;
      localStorage.setItem('jellytube.playerQuality', preferredQualityId);
      error = caught instanceof Error ? caught.message : 'Could not switch quality.';
      controlsVisible = true;
    }
  }

  function toggleUltrawideCrop() {
    ultrawideCrop = !ultrawideCrop;
    localStorage.setItem('jellytube.ultrawideCrop', String(ultrawideCrop));
  }

  function toggleCinematicMode() {
    cinematicMode = !cinematicMode;
    localStorage.setItem('jellytube.cinematicMode', String(cinematicMode));
    resetCinematicGlow();
    if (cinematicMode) {
      scheduleCinematicSample(0);
    } else {
      clearCinematicTimer();
    }
  }

  function changeEpisodeSeason(event: Event) {
    const season = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(season)) return;
    dispatch('episodeSeason', season);
  }

  function seekBy(seconds: number) {
    if (!video || !durationSeconds) return;
    video.currentTime = Math.min(durationSeconds, Math.max(0, video.currentTime + seconds));
    syncPlaybackState();
  }

  function handleSeekInput(event: Event) {
    if (!video) return;
    const target = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(target)) return;
    video.currentTime = target;
    currentTime = target;
    syncBuffered();
  }

  function toggleMute() {
    if (!video) return;
    video.muted = !video.muted;
    handleVolumeChange();
  }

  function handleVolumeInput(event: Event) {
    if (!video) return;
    const nextVolume = Number((event.currentTarget as HTMLInputElement).value);
    video.volume = Math.min(1, Math.max(0, nextVolume));
    video.muted = video.volume === 0;
    handleVolumeChange();
  }

  function handleWheel(event: WheelEvent) {
    if (!video) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const step = event.shiftKey ? 0.02 : 0.05;
    const nextVolume = Math.min(1, Math.max(0, video.volume + direction * step));
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    handleVolumeChange();
    showControls();
  }

  function applySavedAudioState() {
    if (!video) return;
    video.volume = volume;
    video.muted = isMuted || volume === 0;
  }

  function persistAudioState() {
    localStorage.setItem('jellytube.playerVolume', String(volume));
    localStorage.setItem('jellytube.playerMuted', String(isMuted));
  }

  function savedVolume() {
    const stored = Number(localStorage.getItem('jellytube.playerVolume'));
    if (!Number.isFinite(stored)) return 1;
    return Math.min(1, Math.max(0, stored));
  }

  async function toggleFullscreen() {
    if (!playerShell || !video) return;
    fallbackNotice = '';
    const doc = document as WebKitDocument;
    const standardFullscreenElement = document.fullscreenElement;
    const webkitFullscreenElement = doc.webkitFullscreenElement;

    if (standardFullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    if (webkitFullscreenElement && typeof doc.webkitExitFullscreen === 'function') {
      doc.webkitExitFullscreen();
      return;
    }

    if (video.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === 'function') {
      video.webkitExitFullscreen();
      return;
    }

    let fullscreenAttemptFailed = false;

    if (typeof playerShell.requestFullscreen === 'function' && document.fullscreenEnabled === true) {
      try {
        await playerShell.requestFullscreen();
        return;
      } catch {
        fullscreenAttemptFailed = true;
      }
    }

    if (typeof playerShell.webkitRequestFullscreen === 'function' && doc.webkitFullscreenEnabled !== false) {
      try {
        playerShell.webkitRequestFullscreen();
        return;
      } catch {
        fullscreenAttemptFailed = true;
      }
    }

    if (video.webkitSupportsFullscreen && typeof video.webkitEnterFullscreen === 'function') {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch {
        fullscreenAttemptFailed = true;
      }
    }

    fallbackNotice = fullscreenAttemptFailed
      ? 'Fullscreen could not be started in this browser.'
      : 'Fullscreen is not supported in this browser.';
  }

  function handleFullscreenChange() {
    const doc = document as WebKitDocument;
    fullscreen = Boolean(document.fullscreenElement || doc.webkitFullscreenElement || video?.webkitDisplayingFullscreen);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && isPlaying) {
      scheduleCinematicSample(250);
    } else {
      clearCinematicTimer();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && qualityMenuOpen) {
      event.preventDefault();
      qualityMenuOpen = false;
      scheduleControls();
      return;
    }

    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLButtonElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }

    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekBy(-5);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBy(5);
    } else if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      toggleMute();
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      void toggleFullscreen();
    }
  }

  function showControls() {
    controlsVisible = true;
    scheduleControls();
  }

  function scheduleControls() {
    window.clearTimeout(controlsTimer);
    if (!isPlaying || qualityMenuOpen) return;
    controlsTimer = window.setTimeout(() => {
      controlsVisible = false;
    }, 2400);
  }

  function resetCinematicGlow() {
    clearCinematicTimer();
    cinematicStyle = CINEMATIC_FALLBACK_STYLE;
    cinematicFailures = 0;
    cinematicBlocked = false;
    cinematicAvailability = 'idle';
    cinematicPalette = null;
    cinematicRenderedPalette = null;
    lastCinematicSampleTime = -1;
  }

  function clearCinematicTimer() {
    window.clearTimeout(cinematicTimer);
    cinematicTimer = 0;
    if (cinematicAnimationFrame) {
      window.cancelAnimationFrame(cinematicAnimationFrame);
      cinematicAnimationFrame = 0;
    }
  }

  function scheduleCinematicSample(delay = CINEMATIC_SAMPLE_INTERVAL_MS) {
    clearCinematicTimer();
    if (!cinematicMode || cinematicBlocked || cinematicAvailability === 'unavailable' || error || loading || buffering) {
      return;
    }
    cinematicTimer = window.setTimeout(sampleCinematicGlow, delay);
  }

  function sampleCinematicGlow() {
    cinematicTimer = 0;
    if (!video) return;

    const state = {
      enabled: cinematicMode,
      playing: isPlaying,
      visible: document.visibilityState === 'visible',
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      blocked: cinematicBlocked || cinematicAvailability === 'unavailable',
      buffering,
      loading
    };

    if (!shouldSampleCinematicGlow(state)) {
      if (cinematicMode && isPlaying && !cinematicBlocked && !buffering && !loading) scheduleCinematicSample();
      return;
    }

    if (Math.abs(video.currentTime - lastCinematicSampleTime) < 0.75) {
      scheduleCinematicSample();
      return;
    }

    cinematicAnimationFrame = window.requestAnimationFrame(captureCinematicFrame);
  }

  function captureCinematicFrame() {
    cinematicAnimationFrame = 0;
    if (!video || cinematicBlocked || cinematicAvailability === 'unavailable') return;

    try {
      const context = getCinematicContext();
      if (!context) throw new Error('Canvas sampling is unavailable.');
      context.clearRect(0, 0, CINEMATIC_SAMPLE_WIDTH, CINEMATIC_SAMPLE_HEIGHT);
      context.drawImage(video, 0, 0, CINEMATIC_SAMPLE_WIDTH, CINEMATIC_SAMPLE_HEIGHT);
      const frame = context.getImageData(0, 0, CINEMATIC_SAMPLE_WIDTH, CINEMATIC_SAMPLE_HEIGHT);
      const nextPalette = blendCinematicGlowPalette(
        cinematicPalette,
        cinematicPaletteFromImageData(frame.data, CINEMATIC_SAMPLE_WIDTH, CINEMATIC_SAMPLE_HEIGHT)
      );
      cinematicPalette = nextPalette;
      if (!cinematicPalettesAreClose(cinematicRenderedPalette, nextPalette)) {
        cinematicStyle = cinematicGlowStyle(cinematicColorsFromPalette(nextPalette));
        cinematicRenderedPalette = nextPalette;
      }
      cinematicAvailability = 'dynamic';
      lastCinematicSampleTime = video.currentTime;
      cinematicFailures = 0;
    } catch {
      handleCinematicSampleFailure();
    }

    if (cinematicMode && isPlaying && !cinematicBlocked && !buffering && !loading) scheduleCinematicSample();
  }

  function getCinematicContext() {
    if (!cinematicCanvas) {
      cinematicCanvas = document.createElement('canvas');
      cinematicCanvas.width = CINEMATIC_SAMPLE_WIDTH;
      cinematicCanvas.height = CINEMATIC_SAMPLE_HEIGHT;
    }
    cinematicContext ??= cinematicCanvas.getContext('2d', { willReadFrequently: true });
    return cinematicContext;
  }

  function handleCinematicSampleFailure() {
    cinematicFailures += 1;
    if (cinematicFailures < CINEMATIC_FAILURE_LIMIT) return;
    cinematicBlocked = true;
    cinematicAvailability = 'unavailable';
    cinematicPalette = null;
    cinematicRenderedPalette = null;
    cinematicStyle = CINEMATIC_FALLBACK_STYLE;
  }

  function ticksToSeconds(ticks?: number) {
    return ticks ? ticks / 10_000_000 : 0;
  }

  function formatClock(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
    }
    return `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function savedQualityId(): PlaybackQualityId {
    const stored = localStorage.getItem('jellytube.playerQuality');
    return stored && (stored === 'auto' || stored === 'direct' || /^hls-\d+k$/.test(stored))
      ? (stored as PlaybackQualityId)
      : 'auto';
  }
</script>

<section class="watch-layout" class:theater-mode={theaterMode}>
  <div class="watch-left">
    <div class="watch-player-area">
      <button class="back-button" on:click={() => dispatch('back')}>
      <ArrowLeft size={19} />
      <span>Back</span>
    </button>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="player-frame"
      class:cinematic={cinematicMode}
      class:cinematic-ready={cinematicReady}
      class:cinematic-unavailable={cinematicAvailability === 'unavailable'}
      class:ultrawide-crop={ultrawideCrop}
      style={cinematicStyle}
    >
      <div class="cinematic-glow" aria-hidden="true"></div>

      <div
        class="player-shell youtube-player"
        class:controls-visible={!isPlaying || controlsVisible || Boolean(error)}
        bind:this={playerShell}
        tabindex="0"
        role="application"
        aria-label={`Video player for ${title}`}
        on:mousemove={showControls}
        on:mouseleave={scheduleControls}
        on:focus={showControls}
        on:keydown={handleKeydown}
        on:wheel={handleWheel}
      >
        <video
          bind:this={video}
          autoplay={autoplay}
          crossorigin="anonymous"
          playsinline
          preload="metadata"
          poster={client.getImageUrl(detailedItem, 1280)}
          on:play={handlePlay}
          on:pause={handlePause}
          on:ended={handleEnded}
          on:loadedmetadata={handleLoadedMetadata}
          on:canplay={() => {
            loading = false;
            buffering = false;
            if (cinematicMode) scheduleCinematicSample(120);
          }}
          on:playing={() => {
            loading = false;
            buffering = false;
            if (cinematicMode) scheduleCinematicSample(120);
          }}
          on:waiting={() => {
            if (!video.paused) {
              buffering = true;
              clearCinematicTimer();
            }
          }}
          on:timeupdate={syncPlaybackState}
          on:progress={syncBuffered}
          on:volumechange={handleVolumeChange}
          on:error={() => void handlePlaybackFailure()}
        ></video>

        {#if !error}
          <button
            class="player-hit-target"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            on:click={handlePlayerClick}
            on:dblclick={handlePlayerDoubleClick}
          ></button>
        {/if}

        {#if loading || buffering}
          <div class="player-overlay player-loading">
            <Loader2 size={38} class="spin" />
          </div>
        {/if}

        {#if error}
          <div class="player-overlay error-overlay">
            <TriangleAlert size={32} />
            <strong>{error}</strong>
            <span>{mediaSource ? mediaSummary(mediaSource) : 'No media source'}</span>
            <button class="player-retry" on:click={() => void loadPlayback(true)}>
              <RotateCcw size={17} />
              <span>Retry playback</span>
            </button>
          </div>
        {:else}
          {#if !isPlaying && !loading}
            <button class="center-play" aria-label="Play" on:click={togglePlay}>
              <Play size={34} fill="currentColor" />
            </button>
          {/if}

          {#if fallbackNotice}
            <div class="player-status-toast">{fallbackNotice}</div>
          {/if}

          <div class="player-controls-layer" aria-label="Playback controls">
            <input
              class="player-seek"
              style={seekStyle}
              type="range"
              min="0"
              max={seekMax}
              step="0.1"
              value={currentTime}
              aria-label="Seek"
              on:input={handleSeekInput}
              on:pointerdown={showControls}
            />

            <div class="player-control-row">
              <button class="player-control" aria-label={isPlaying ? 'Pause' : 'Play'} on:click={togglePlay}>
                {#if isPlaying}
                  <Pause size={22} fill="currentColor" />
                {:else}
                  <Play size={22} fill="currentColor" />
                {/if}
              </button>
              <button class="player-control" aria-label="Back 5 seconds" on:click={() => seekBy(-5)}>
                <SkipBack size={21} />
              </button>
              <button class="player-control" aria-label="Forward 5 seconds" on:click={() => seekBy(5)}>
                <SkipForward size={21} />
              </button>

              <div class="volume-control">
                <button class="player-control" aria-label={isMuted ? 'Unmute' : 'Mute'} on:click={toggleMute}>
                  {#if isMuted || volume === 0}
                    <VolumeX size={22} />
                  {:else}
                    <Volume2 size={22} />
                  {/if}
                </button>
                <input
                  class="volume-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  aria-label="Volume"
                  on:input={handleVolumeInput}
                />
              </div>

              <span class="player-time">{formatClock(currentTime)} / {formatClock(durationSeconds)}</span>
              <span class="player-source-pill" title={activeAttempt?.detail}>{sourceLabel}</span>

              {#if isMusicVideo}
                <button
                  class="player-control loop-control"
                  class:active={loopMusicVideo}
                  aria-label={loopMusicVideo ? 'Disable loop' : 'Loop this music video'}
                  title={loopMusicVideo ? 'Loop on' : 'Loop off'}
                  on:click={toggleLoopMusicVideo}
                >
                  <Repeat size={21} />
                </button>
              {/if}

              <button
                class="player-control ultrawide-control"
                class:active={ultrawideCrop}
                aria-label={ultrawideCrop ? 'Use original player aspect' : 'Crop to 21:9 player'}
                title={ultrawideCrop ? '21:9 crop on' : '21:9 crop off'}
                on:click={toggleUltrawideCrop}
              >
                <Ratio size={21} />
              </button>

              <button
                class="player-control cinematic-control"
                class:active={cinematicMode}
                class:unavailable={cinematicAvailability === 'unavailable'}
                aria-label={cinematicControlLabel}
                title={cinematicControlTitle}
                on:click={toggleCinematicMode}
              >
                <Sparkles size={21} />
              </button>
              
              <button
                class="player-control theater-control"
                class:active={theaterMode}
                aria-label={theaterMode ? 'Default view' : 'Theater mode'}
                title={theaterMode ? 'Default view' : 'Theater mode'}
                on:click={toggleTheaterMode}
              >
                <RectangleHorizontal size={21} />
              </button>

              <div class="quality-control">
                <button
                  class="player-control quality-button"
                  class:active={qualityMenuOpen}
                  aria-label={`Quality: ${qualityButtonLabel}`}
                  aria-expanded={qualityMenuOpen}
                  aria-haspopup="menu"
                  title={`Quality: ${qualityButtonLabel}`}
                  on:click={toggleQualityMenu}
                >
                  <Settings size={21} />
                </button>

                {#if qualityMenuOpen}
                  <div class="quality-menu" role="menu" aria-label="Playback quality">
                    <div class="quality-menu-heading">Quality</div>
                    {#each qualityOptions as option (option.id)}
                      <button
                        class:active={option.id === selectedQualityId}
                        class="quality-option"
                        role="menuitemradio"
                        aria-checked={option.id === selectedQualityId}
                        on:click={(event) => void selectQuality(event, option)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.detail}</small>
                        </span>
                        {#if option.id === selectedQualityId}
                          <Check size={16} />
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <button class="player-control fullscreen-control" aria-label="Toggle fullscreen" on:click={() => void toggleFullscreen()}>
                {#if fullscreen}
                  <Minimize size={22} />
                {:else}
                  <Maximize size={22} />
                {/if}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="watch-main">
    <h1>{title}</h1>
    <div class="watch-meta">
      <button class="watch-channel" on:click={() => (isMovie ? dispatch('movies') : dispatch('channel', contextLabel))}>
        {contextLabel}
      </button>
      {#if currentEpisodeCode}
        <span>{currentEpisodeCode}</span>
      {/if}
      <span>{compactMeta(detailedItem)}</span>
      {#if formatDuration(detailedItem.RunTimeTicks)}
        <span>{formatDuration(detailedItem.RunTimeTicks)}</span>
      {/if}
    </div>
    {#if detailedItem.Overview}
      <p class="overview">{detailedItem.Overview}</p>
    {/if}

    {#if hasEpisodeShelf}
      <section class="episode-shelf" aria-label="Episodes">
        <div class="episode-shelf-heading">
          <div>
            <h2>{episodeSeriesTitle || queueTitle || 'Episodes'}</h2>
            <span>{queueIndex >= 0 ? `Episode ${queueIndex + 1} of ${queue.length}` : 'Episodes'}</span>
          </div>
          <div class="episode-shelf-actions">
            <label class="autoplay-next">
              <input type="checkbox" checked={autoplayNext} on:change={toggleAutoplayNext} />
              <span>Autoplay</span>
            </label>
            <label class="season-picker">
              <span>Season</span>
              <select value={selectedEpisodeSeason} on:change={changeEpisodeSeason}>
                {#each episodeSeasons as season (season.season)}
                  <option value={season.season}>{season.label}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>

        <div class="episode-strip">
          {#each selectedEpisodeItems as episode (episode.Id)}
            <button
              class:active={episode.Id === item.Id}
              class="episode-tile"
              on:click={() => dispatch('episodeSelect', episode)}
            >
              <span class="episode-thumb">
                {#if client.getImageUrl(episode, 360)}
                  <img src={client.getImageUrl(episode, 360)} alt="" loading="lazy" />
                {:else}
                  <span>{episodeInfo(episode)?.episode ?? ''}</span>
                {/if}
                {#if episode.Id === item.Id}
                  <span class="now-playing-pill">
                    <div class="now-playing-bars">
                      <i></i><i></i><i></i>
                    </div>
                    Playing
                  </span>
                {/if}
                {#if formatDuration(episode.RunTimeTicks)}
                  <span class="duration">{formatDuration(episode.RunTimeTicks)}</span>
                {/if}
                {#if playbackProgress(episode) > 0}
                  <span class="progress-bar" style={`width:${playbackProgress(episode)}%`}></span>
                {/if}
              </span>
              <span class="episode-copy">
                <span class="episode-code">{episodeCode(episode)}</span>
                <strong>{displayTitle(episode, { context: 'series' })}</strong>
                <small>{compactMeta(episode)}</small>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}
  </div>
  </div>

  <aside class="recommendation-rail" aria-label={isMovie ? 'Recommended movies' : 'Recommended videos'}>
    {#if queue.length > 1 && !hasEpisodeShelf}
      <section class="queue-panel" aria-label="Mix playlist">
        <div class="queue-heading">
          <strong>{queueTitle || 'Mix playlist'}</strong>
          <div class="queue-heading-meta">
            {#if queueIndex >= 0}
              <span>{queueIndex + 1} / {queue.length}</span>
            {/if}
            <label class="autoplay-next">
              <input type="checkbox" checked={autoplayNext} on:change={toggleAutoplayNext} />
              <span>Autoplay</span>
            </label>
          </div>
        </div>
        {#if upcomingQueue.length}
          {#each upcomingQueue.slice(0, 12) as queueItem (queueItem.Id)}
            <VideoCard
              {client}
              item={queueItem}
              compact
              on:select={(event) => dispatch('queueSelect', event.detail)}
              on:channel={(event) => dispatch('channel', event.detail)}
            />
          {/each}
        {:else}
          <div class="queue-complete">End of mix</div>
        {/if}
      </section>
    {/if}

    {#if isMovie && recommendations.length}
      <section class="movie-recommendation-panel" aria-label="More movies">
        <div class="recommendation-heading">
          <h2>More movies</h2>
          {#if showRecommendationAutoplayToggle}
            <label class="autoplay-next">
              <input type="checkbox" checked={autoplayNext} on:change={toggleAutoplayNext} />
              <span>Autoplay</span>
            </label>
          {/if}
        </div>
        <div class="movie-recommendation-grid">
          {#each recommendations as recommendation (recommendation.Id)}
            <VideoCard
              {client}
              item={recommendation}
              poster
              on:select={(event) => dispatch('select', event.detail)}
              on:channel={() => dispatch('movies')}
            />
          {/each}
        </div>
      </section>
    {:else}
      {#if recommendations.length}
        <section class="recommendation-panel" aria-label="Recommended videos">
          <div class="recommendation-heading">
            <h2>Recommended</h2>
            {#if showRecommendationAutoplayToggle}
              <label class="autoplay-next">
                <input type="checkbox" checked={autoplayNext} on:change={toggleAutoplayNext} />
                <span>Autoplay</span>
              </label>
            {/if}
          </div>
          {#each recommendations as recommendation (recommendation.Id)}
            <VideoCard
              {client}
              item={recommendation}
              compact
              titleContext={channelName(recommendation) === contextLabel ? 'channel' : 'feed'}
              titleChannel={contextLabel}
              on:select={(event) => dispatch('select', event.detail)}
              on:channel={(event) => dispatch('channel', event.detail)}
            />
          {/each}
        </section>
      {/if}
    {/if}
  </aside>
</section>
