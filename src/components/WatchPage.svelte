<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type Hls from 'hls.js';
  import {
    ArrowLeft,
    Loader2,
    Maximize,
    Minimize,
    Pause,
    Play,
    Ratio,
    RotateCcw,
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
    playbackProgress
  } from '../lib/recommendations';
  import {
    CINEMATIC_FAILURE_LIMIT,
    CINEMATIC_FALLBACK_STYLE,
    CINEMATIC_SAMPLE_HEIGHT,
    CINEMATIC_SAMPLE_INTERVAL_MS,
    CINEMATIC_SAMPLE_WIDTH,
    cinematicColorsFromImageData,
    cinematicGlowStyle,
    shouldSampleCinematicGlow
  } from '../lib/cinematicGlow';
  import { episodeCode, episodeInfo, type EpisodeSeason } from '../lib/episodes';
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
  }>();

  type PlaybackAttempt = {
    url: string;
    label: string;
    detail: string;
    mediaKind: 'direct' | 'hls';
    playMethod: PlaybackEventPayload['PlayMethod'];
  };

  let video: HTMLVideoElement;
  let playerShell: HTMLDivElement;
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
  let ultrawideCrop = localStorage.getItem('jellytube.ultrawideCrop') === 'true';
  let cinematicMode = localStorage.getItem('jellytube.cinematicMode') === 'true';
  let cinematicStyle = CINEMATIC_FALLBACK_STYLE;
  let cinematicTimer = 0;
  let cinematicFailures = 0;
  let cinematicBlocked = false;
  let cinematicCanvas: HTMLCanvasElement | null = null;
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
  $: queueIndex = queue.findIndex((queueItem) => queueItem.Id === item.Id);
  $: hasNextQueued = queueIndex >= 0 && queueIndex < queue.length - 1;
  $: upcomingQueue = queueIndex >= 0 ? queue.slice(queueIndex + 1) : queue;
  $: hasEpisodeShelf = episodeSeasons.length > 0;
  $: isMovie = detailedItem.Type === 'Movie' || detailedItem.contentKind === 'movie';
  $: contextLabel = isMovie ? detailedItem.sourceLibraryName || 'YouTube Movies' : channelName(detailedItem);
  $: title = displayTitle(detailedItem, {
    context: detailedItem.Type === 'Episode' ? 'series' : isMovie ? 'feed' : 'channel',
    channel: contextLabel
  });
  $: selectedEpisodeItems =
    episodeSeasons.find((season) => season.season === selectedEpisodeSeason)?.items ??
    episodeSeasons[0]?.items ??
    [];

  onMount(() => {
    void loadPlayback(autoplay);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
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
    currentTime = 0;
    bufferedPercent = 0;
    duration = 0;
    resetCinematicGlow();
    await stopPlayback();
    playRequested = autoPlay;
    await tick();

    try {
      detailedItem = await client.getItem(item.Id);
      const startTicks = detailedItem.UserData?.PlaybackPositionTicks ?? 0;
      resumeSeconds = startTicks / 10_000_000;
      const playbackInfo = await client.getPlaybackInfo(item.Id, startTicks);
      mediaSource = playbackInfo.MediaSources[0] ?? null;
      playSessionId = playbackInfo.PlaySessionId ?? '';
      if (!mediaSource) throw new Error('No playable media source was returned by Jellyfin.');

      attempts = buildPlaybackAttempts(mediaSource);
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

  function buildPlaybackAttempts(source: JellyfinMediaSource) {
    const nextAttempts: PlaybackAttempt[] = [];
    const directAttempt = getDirectAttempt(source);
    const hlsAttempt = getHlsAttempt(source);

    if (directAttempt) nextAttempts.push(directAttempt);
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
      label: 'Direct play',
      detail: mediaSummary(source),
      mediaKind: 'direct',
      playMethod: 'DirectPlay'
    };
  }

  function getHlsAttempt(source: JellyfinMediaSource): PlaybackAttempt | null {
    if (source.SupportsTranscoding === false) return null;
    const { maxWidth, maxHeight } = preferredHlsSize();
    return {
      url: client.getHlsUrl(item.Id, source.Id, {
        startTicks: 0,
        playSessionId,
        audioStreamIndex: source.DefaultAudioStreamIndex,
        subtitleStreamIndex: source.DefaultSubtitleStreamIndex,
        maxWidth,
        maxHeight
      }),
      label: 'Jellyfin HLS',
      detail: `H.264/AAC up to ${maxHeight}p`,
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
      fallbackNotice = `${failedLabel} was rejected by this browser. Switched to Jellyfin HLS.`;
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
    void finishReporting();
    if (autoplayNext && hasNextQueued) dispatch('next');
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

  function toggleUltrawideCrop() {
    ultrawideCrop = !ultrawideCrop;
    localStorage.setItem('jellytube.ultrawideCrop', String(ultrawideCrop));
  }

  function toggleCinematicMode() {
    cinematicMode = !cinematicMode;
    localStorage.setItem('jellytube.cinematicMode', String(cinematicMode));
    cinematicFailures = 0;
    cinematicBlocked = false;
    if (cinematicMode) {
      scheduleCinematicSample(0);
    } else {
      clearCinematicTimer();
      cinematicStyle = CINEMATIC_FALLBACK_STYLE;
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
    if (!playerShell) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await playerShell.requestFullscreen();
    }
  }

  function handleFullscreenChange() {
    fullscreen = Boolean(document.fullscreenElement);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && isPlaying) {
      scheduleCinematicSample(250);
    } else {
      clearCinematicTimer();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
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
    if (!isPlaying) return;
    controlsTimer = window.setTimeout(() => {
      controlsVisible = false;
    }, 2400);
  }

  function resetCinematicGlow() {
    cinematicStyle = CINEMATIC_FALLBACK_STYLE;
    cinematicFailures = 0;
    cinematicBlocked = false;
    lastCinematicSampleTime = -1;
  }

  function clearCinematicTimer() {
    window.clearTimeout(cinematicTimer);
    cinematicTimer = 0;
  }

  function scheduleCinematicSample(delay = CINEMATIC_SAMPLE_INTERVAL_MS) {
    clearCinematicTimer();
    if (!cinematicMode || cinematicBlocked || error) return;
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
      blocked: cinematicBlocked
    };

    if (!shouldSampleCinematicGlow(state)) {
      if (cinematicMode && isPlaying && !cinematicBlocked) scheduleCinematicSample();
      return;
    }

    if (Math.abs(video.currentTime - lastCinematicSampleTime) < 0.75) {
      scheduleCinematicSample();
      return;
    }

    try {
      const canvas = cinematicCanvas ?? document.createElement('canvas');
      cinematicCanvas = canvas;
      canvas.width = CINEMATIC_SAMPLE_WIDTH;
      canvas.height = CINEMATIC_SAMPLE_HEIGHT;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas sampling is unavailable.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      cinematicStyle = cinematicGlowStyle(
        cinematicColorsFromImageData(frame.data, canvas.width, canvas.height)
      );
      lastCinematicSampleTime = video.currentTime;
      cinematicFailures = 0;
    } catch {
      cinematicFailures += 1;
      cinematicBlocked = cinematicFailures >= CINEMATIC_FAILURE_LIMIT;
    }

    if (cinematicMode && isPlaying && !cinematicBlocked) scheduleCinematicSample();
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
</script>

<section class="watch-layout">
  <div class="watch-main">
    <button class="back-button" on:click={() => dispatch('back')}>
      <ArrowLeft size={19} />
      <span>Back</span>
    </button>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="player-frame" class:cinematic={cinematicMode} class:ultrawide-crop={ultrawideCrop} style={cinematicStyle}>
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
          }}
          on:playing={() => {
            loading = false;
            buffering = false;
          }}
          on:waiting={() => {
            if (!video.paused) buffering = true;
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
                aria-label={cinematicMode ? 'Disable cinematic glow' : 'Enable cinematic glow'}
                title={cinematicMode ? 'Cinematic glow on' : 'Cinematic glow off'}
                on:click={toggleCinematicMode}
              >
                <Sparkles size={21} />
              </button>

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
    {#if progress > 0 && progress < 95}
      <div class="resume-note">Resume point: {Math.round(progress)}%</div>
    {/if}
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
        <h2>More movies</h2>
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
    {/if}
  </aside>
</section>
