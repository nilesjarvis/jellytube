<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type Hls from 'hls.js';
  import {
    ArrowLeft,
    Captions,
    Check,
    Loader2,
    Languages,
    Maximize,
    Minimize,
    Pause,
    Play,
    Ratio,
    Repeat,
    RotateCcw,
    RotateCw,
    RectangleHorizontal,
    Settings,
    Sparkles,
    TriangleAlert,
    Volume2,
    VolumeX,
    X
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
  import type { ProjectedRecommendation } from '../lib/showRecommendations';
  import {
    PLAYING_NEXT_COUNTDOWN_SECONDS,
    countdownSecondsRemaining,
    episodePlayingNextItem,
    shouldAdvancePlayingNext,
    shouldShowPlayingNext
  } from '../lib/playingNext';
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
    containerDefaultAudioStream,
    initialPlaybackAudioId,
    playbackAudioById,
    playbackAudioOptions,
    playbackAudioPreferenceKey,
    serializePlaybackAudioPreference,
    type PlaybackAudioOption
  } from '../lib/playbackAudio';
  import {
    playbackQualityById,
    playbackQualityOptions,
    type PlaybackQualityId,
    type PlaybackQualityOption
  } from '../lib/playbackQuality';
  import {
    initialPlayerAspectMode,
    LEGACY_ULTRAWIDE_CROP_STORAGE_KEY,
    PLAYER_ASPECT_OPTIONS,
    PLAYER_ASPECT_STORAGE_KEY,
    playerAspectById,
    type PlayerAspectOption
  } from '../lib/playerAspect';
  import type { JellyfinItem, JellyfinMediaSource, JellyfinMediaStream, JellyfinPerson } from '../lib/types';
  import { canDirectPlaySource, directStreamExtension } from '../lib/codecSupport';
  import { actorsForItem } from '../lib/people';
  import ActorCast from './ActorCast.svelte';
  import ShowRecommendationCard from './ShowRecommendationCard.svelte';
  import VideoCard from './VideoCard.svelte';

  export let client: JellyfinClient;
  export let item: JellyfinItem;
  export let autoplay = false;
  export let queue: JellyfinItem[] = [];
  export let queueTitle = '';
  export let episodeSeasons: EpisodeSeason[] = [];
  export let selectedEpisodeSeason = 0;
  export let episodeSeriesTitle = '';
  export let recommendations: ProjectedRecommendation[] = [];
  export let minimized = false;

  const dispatch = createEventDispatcher<{
    recommendationSelect: ProjectedRecommendation;
    queueSelect: JellyfinItem;
    episodeSelect: JellyfinItem;
    episodeSeason: number;
    back: void;
    channel: string;
    actor: JellyfinPerson;
    movies: void;
    next: void;
    finished: JellyfinItem;
    restore: void;
    close: void;
  }>();

  type PlaybackAttempt = {
    url: string;
    label: string;
    detail: string;
    qualityId: PlaybackQualityId;
    mediaKind: 'direct' | 'hls';
    playMethod: PlaybackEventPayload['PlayMethod'];
  };

  type SubtitleOption = {
    id: string;
    label: string;
    detail: string;
    stream: JellyfinMediaStream | null;
    index: number | null;
    delivery: 'off' | 'track' | 'burn';
  };

  type AudioSelectionRollback = {
    audioId: string;
    qualityOptions: PlaybackQualityOption[];
    qualityId: PlaybackQualityId;
    preferenceKey: string;
    preference: string | null;
    shouldResume: boolean;
    attemptedLabel: string;
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
  type MiniPlayerResizeAxis = 'top' | 'left' | 'corner';
  type MiniPlayerResizeState = {
    axis: MiniPlayerResizeAxis;
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
  };

  const MINI_PLAYER_WIDTH_KEY = 'jellytube.miniPlayerWidth';
  const DEFAULT_MINI_PLAYER_WIDTH = 400;
  const MIN_MINI_PLAYER_WIDTH = 280;
  const MAX_MINI_PLAYER_WIDTH = 720;
  const MINI_PLAYER_KEYBOARD_STEP = 24;
  const SEEK_STEP_SECONDS = 10;
  const BUFFERING_INDICATOR_DELAY_MS = 250;

  function recommendationKey(recommendation: ProjectedRecommendation) {
    return recommendation.kind === 'item'
      ? `item:${recommendation.item.Id}`
      : `show:${recommendation.seriesKey}`;
  }

  function recommendationPlayableItem(recommendation: ProjectedRecommendation): JellyfinItem | null {
    return recommendation.kind === 'item' ? recommendation.item : recommendation.progress.primaryItem;
  }

  let video: WebKitVideoElement;
  let playerShell: WebKitFullscreenElement;
  let watchLayout: HTMLElement;
  let miniPlayerWidth = savedMiniPlayerWidth();
  let miniResizeState: MiniPlayerResizeState | null = null;
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
  let bufferingTimer = 0;
  let started = false;
  let attempts: PlaybackAttempt[] = [];
  let attemptIndex = 0;
  let activeAttempt: PlaybackAttempt | null = null;
  let playRequested = false;
  let suppressMediaErrors = false;
  let hlsRecovered = false;
  let hlsNetworkRecovered = false;
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
  let audioOptions: PlaybackAudioOption[] = [];
  let selectedAudioId = '';
  let audioMenuOpen = false;
  let pendingAudioRollback: AudioSelectionRollback | null = null;
  let preserveBoundaryResume = false;
  let restartShouldResume = false;
  let subtitleOptions: SubtitleOption[] = [{ id: 'off', label: 'Off', detail: 'No captions', stream: null, index: null, delivery: 'off' }];
  let selectedSubtitleId = 'off';
  let subtitleMenuOpen = false;
  let activeTextTrackUrl = '';
  let aspectMode = initialPlayerAspectMode(
    localStorage.getItem(PLAYER_ASPECT_STORAGE_KEY),
    localStorage.getItem(LEGACY_ULTRAWIDE_CROP_STORAGE_KEY) === 'true'
  );
  let aspectMenuOpen = false;
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
  let episodeStrip: HTMLDivElement | null = null;
  let scrolledEpisodeKey = '';
  let episodeScrollFrame = 0;
  let playingNextAdvanceKey = '';

  $: currentEpisodeCode = episodeCode(detailedItem);
  $: progress = playbackProgress(detailedItem);
  $: durationSeconds = duration || ticksToSeconds(detailedItem.RunTimeTicks);
  $: progressPercent = durationSeconds > 0 ? Math.min(100, (currentTime / durationSeconds) * 100) : 0;
  $: seekMax = durationSeconds || 0;
  $: seekStyle = `--progress: ${progressPercent}%; --buffered: ${Math.max(bufferedPercent, progressPercent)}%;`;
  $: sourceLabel = activeAttempt?.label ?? 'Preparing';
  $: selectedQuality = playbackQualityById(qualityOptions, selectedQualityId);
  $: qualityButtonLabel = selectedQuality?.label ?? 'Auto';
  $: selectedAudio = playbackAudioById(audioOptions, selectedAudioId);
  $: audioButtonLabel = selectedAudio?.label ?? 'Default';
  $: selectedSubtitle = subtitleOptions.find((option) => option.id === selectedSubtitleId) ?? subtitleOptions[0];
  $: subtitleButtonLabel = selectedSubtitle?.label ?? 'Off';
  $: subtitleActive = Boolean(selectedSubtitle?.index !== null && selectedSubtitle?.index !== undefined);
  $: selectedAspect = playerAspectById(aspectMode) ?? PLAYER_ASPECT_OPTIONS[0];
  $: aspectButtonLabel = selectedAspect.label;
  $: queueIndex = queue.findIndex((queueItem) => queueItem.Id === item.Id);
  $: hasNextQueued = queueIndex >= 0 && queueIndex < queue.length - 1;
  $: upcomingQueue = queueIndex >= 0 ? queue.slice(queueIndex + 1) : queue;
  $: hasEpisodeShelf = episodeSeasons.length > 0;
  $: recommendationAutoplayEntry = recommendations.find((recommendation) => {
    const playableItem = recommendationPlayableItem(recommendation);
    return (
      playableItem !== null &&
      playableItem.Id !== item.Id &&
      !queue.some((queueItem) => queueItem.Id === playableItem.Id)
    );
  });
  $: showRecommendationAutoplayToggle = Boolean(
    recommendationAutoplayEntry && !hasEpisodeShelf && queue.length <= 1
  );
  $: isMovie = detailedItem.Type === 'Movie' || detailedItem.contentKind === 'movie';
  $: isMusicVideo = detailedItem.Type === 'MusicVideo' || detailedItem.contentKind === 'musicVideo';
  $: cast = detailedItem.Type === 'Movie' || detailedItem.Type === 'Episode' ? actorsForItem(detailedItem) : [];
  $: contextLabel = isMovie ? detailedItem.sourceLibraryName || 'YouTube Movies' : channelName(detailedItem);
  $: title = displayTitle(detailedItem, {
    context: detailedItem.Type === 'Episode' ? 'series' : isMovie ? 'feed' : 'channel',
    channel: contextLabel
  });
  $: selectedEpisodeItems =
    episodeSeasons.find((season) => season.season === selectedEpisodeSeason)?.items ??
    episodeSeasons[0]?.items ??
    [];
  $: nextEpisodeInSeason = episodePlayingNextItem(item, selectedEpisodeItems);
  $: episodePlayingNext = nextEpisodeInSeason ?? (hasNextQueued ? queue[queueIndex + 1] : null);
  $: playingNextCountdown = countdownSecondsRemaining(currentTime, durationSeconds);
  $: showPlayingNextOverlay = shouldShowPlayingNext({
    currentTime,
    duration: durationSeconds,
    nextItem: episodePlayingNext,
    autoplayNext: autoplayNext && !loopMusicVideo
  });
  $: playingNextProgress = Math.max(0, Math.min(1, playingNextCountdown / PLAYING_NEXT_COUNTDOWN_SECONDS));
  $: playingNextRingStyle = `--countdown-progress: ${playingNextProgress};`;
  $: playingNextTitle = episodePlayingNext
    ? displayTitle(episodePlayingNext, { context: 'series' })
    : '';
  $: playingNextCode = episodePlayingNext ? episodeCode(episodePlayingNext) : '';
  $: playingNextThumbnailUrl = episodePlayingNext ? client.getImageUrl(episodePlayingNext, 320) : '';
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

  $: if (minimized) {
    qualityMenuOpen = false;
    audioMenuOpen = false;
    subtitleMenuOpen = false;
    aspectMenuOpen = false;
    clearCinematicTimer();
  } else if (cinematicMode && isPlaying) {
    scheduleCinematicSample(0);
  }

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
    if (episodeScrollFrame) window.cancelAnimationFrame(episodeScrollFrame);
    void stopPlayback();
  });

  afterUpdate(() => {
    const episodeKey = `${item.Id}:${selectedEpisodeSeason}:${selectedEpisodeItems.length}`;
    if (!hasEpisodeShelf || scrolledEpisodeKey === episodeKey) return;
    void scrollActiveEpisodeIntoView(episodeKey);
  });

  async function scrollActiveEpisodeIntoView(episodeKey: string) {
    await tick();
    if (episodeScrollFrame) window.cancelAnimationFrame(episodeScrollFrame);
    episodeScrollFrame = window.requestAnimationFrame(() => {
      episodeScrollFrame = 0;
      if (!episodeStrip) return;
      const activeTile = episodeStrip.querySelector<HTMLElement>('.episode-tile.active');
      if (!activeTile) return;
      const maxScroll = Math.max(0, episodeStrip.scrollWidth - episodeStrip.clientWidth);
      const centeredLeft = activeTile.offsetLeft - (episodeStrip.clientWidth - activeTile.offsetWidth) / 2;
      episodeStrip.scrollTo({
        left: Math.max(0, Math.min(maxScroll, centeredLeft)),
        behavior: 'auto'
      });
      scrolledEpisodeKey = episodeKey;
    });
  }

  function handleEpisodeStripWheel(event: WheelEvent) {
    const strip = event.currentTarget as HTMLDivElement | null;
    if (!strip) return;
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    if (maxScroll <= 0) return;

    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
    const delta = (event.deltaX || event.deltaY) * deltaScale;
    if (!delta) return;

    const nextLeft = Math.max(0, Math.min(maxScroll, strip.scrollLeft + delta));
    if (nextLeft === strip.scrollLeft) return;
    event.preventDefault();
    strip.scrollLeft = nextLeft;
  }

  async function loadPlayback(autoPlay = false) {
    loading = true;
    clearBuffering();
    error = '';
    fallbackNotice = '';
    qualityMenuOpen = false;
    audioMenuOpen = false;
    aspectMenuOpen = false;
    pendingAudioRollback = null;
    preserveBoundaryResume = false;
    restartShouldResume = false;
    subtitleMenuOpen = false;
    activeTextTrackUrl = '';
    currentTime = 0;
    bufferedPercent = 0;
    duration = 0;
    playingNextAdvanceKey = '';
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
      const audioPreference = localStorage.getItem(
        playbackAudioPreferenceKey(client.serverUrl, client.userId ?? '')
      );
      const itemMediaSource = detailedItem.MediaSources?.[0];
      const itemAudioOptions = itemMediaSource ? playbackAudioOptions(itemMediaSource) : [];
      const itemAudioId = itemMediaSource
        ? initialPlaybackAudioId(itemMediaSource, itemAudioOptions, audioPreference)
        : '';
      const playbackInfo = await client.getPlaybackInfo(
        item.Id,
        startTicks,
        playbackAudioById(itemAudioOptions, itemAudioId)?.index
      );
      mediaSource = playbackInfo.MediaSources[0] ?? null;
      playSessionId = playbackInfo.PlaySessionId ?? '';
      if (!mediaSource) throw new Error('No playable media source was returned by Jellyfin.');

      audioOptions = playbackAudioOptions(mediaSource);
      selectedAudioId = initialPlaybackAudioId(mediaSource, audioOptions, audioPreference);
      qualityOptions = playbackQualityOptions(mediaSource, { directAvailable: Boolean(getDirectAttempt(mediaSource)) });
      selectedQualityId = playbackQualityById(qualityOptions, preferredQualityId)?.id ?? 'auto';
      subtitleOptions = buildSubtitleOptions(mediaSource);
      selectedSubtitleId = initialSubtitleId(mediaSource, subtitleOptions);
      activeTextTrackUrl = textTrackUrlForSelection();
      attempts = buildPlaybackAttempts(mediaSource, selectedQualityId);
      if (!attempts.length) {
        throw new Error('Jellyfin did not return a browser-compatible direct stream or HLS transcode option.');
      }

      await startAttempt(0, autoPlay);
    } catch (caught) {
      loading = false;
      clearBuffering();
      error = caught instanceof Error ? caught.message : 'Could not prepare playback.';
    }
  }

  function buildPlaybackAttempts(
    source: JellyfinMediaSource,
    qualityId: string | null | undefined = selectedQualityId,
    subtitleOption: SubtitleOption | undefined = selectedSubtitleOption()
  ) {
    const nextAttempts: PlaybackAttempt[] = [];
    const burnSubtitle = subtitleOption?.delivery === 'burn';
    const directAttempt = burnSubtitle ? null : getDirectAttempt(source);
    const quality = playbackQualityById(qualityOptions, qualityId);

    if (quality?.mode === 'direct') {
      if (directAttempt) nextAttempts.push(directAttempt);
      const fallbackHlsAttempt = getHlsAttempt(source, undefined, subtitleOption);
      if (fallbackHlsAttempt) nextAttempts.push(fallbackHlsAttempt);
      return nextAttempts;
    }

    if (quality?.mode === 'hls') {
      const hlsAttempt = getHlsAttempt(source, quality, subtitleOption);
      if (hlsAttempt) nextAttempts.push(hlsAttempt);
      return nextAttempts;
    }

    if (directAttempt) nextAttempts.push(directAttempt);
    const hlsAttempt = getHlsAttempt(source, undefined, subtitleOption);
    if (hlsAttempt) nextAttempts.push(hlsAttempt);
    return nextAttempts;
  }

  function getDirectAttempt(source: JellyfinMediaSource): PlaybackAttempt | null {
    if (selectedAudioOption()?.index !== containerDefaultAudioStream(source)?.Index) return null;
    if (source.SupportsDirectPlay === false) return null;
    const extension = directStreamExtension(source);
    if (!extension) return null;
    const playable = canDirectPlaySource(source, video, extension);
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

  function getHlsAttempt(
    source: JellyfinMediaSource,
    quality?: PlaybackQualityOption,
    subtitleOption: SubtitleOption | undefined = selectedSubtitleOption()
  ): PlaybackAttempt | null {
    if (source.SupportsTranscoding === false) return null;
    const preferredSize = preferredHlsSize();
    const maxWidth = quality?.maxWidth ?? preferredSize.maxWidth;
    const maxHeight = quality?.maxHeight ?? preferredSize.maxHeight;
    return {
      url: client.getHlsUrl(item.Id, source.Id, {
        startTicks: 0,
        playSessionId,
        audioStreamIndex: selectedAudioOption()?.index,
        subtitleStreamIndex: subtitleOption?.delivery === 'burn' ? subtitleOption.index ?? undefined : undefined,
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
    clearBuffering();
    error = '';
    seekApplied = false;
    hlsRecovered = false;
    hlsNetworkRecovered = false;

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
        if (data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR && hls && !hlsNetworkRecovered) {
          hlsNetworkRecovered = true;
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
    void syncTextTrackMode();
    if (autoPlay) void requestPlay();
    scheduleControls();
  }

  async function handlePlaybackFailure(detail = mediaErrorMessage()) {
    if (suppressMediaErrors) return;
    loading = false;
    clearBuffering();

    if (attemptIndex < attempts.length - 1) {
      const failedLabel = activeAttempt?.label ?? 'The stream';
      const nextAttempt = attempts[attemptIndex + 1];
      const nextLabel = nextAttempt?.label ?? 'Jellyfin HLS';
      fallbackNotice = `${failedLabel} was rejected by this browser. Switched to ${nextLabel}.`;
      if (nextAttempt) selectedQualityId = nextAttempt.qualityId;
      await startAttempt(attemptIndex + 1, playRequested);
      return;
    }

    const audioRollback = rollbackPendingAudioSelection();
    if (audioRollback && attempts.length) {
      try {
        await startAttempt(0, audioRollback.shouldResume);
        fallbackNotice = `${audioRollback.attemptedLabel} could not be selected. Restored the previous audio track.`;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : `Playback failed. ${detail}`;
        preserveBoundaryResume = false;
        restartShouldResume = false;
      }
      controlsVisible = true;
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
    clearBuffering();
    qualityMenuOpen = false;
    audioMenuOpen = false;
    subtitleMenuOpen = false;
    aspectMenuOpen = false;
    const activeVideo = video;
    const reporting = finishReporting();
    teardownHls();
    clearVideoSource(activeVideo);
    playRequested = false;
    isPlaying = false;
    clearCinematicTimer();
    await reporting;
  }

  function teardownHls() {
    hls?.destroy();
    hls = null;
  }

  function clearVideoSource(target: WebKitVideoElement | undefined = video) {
    if (!target) return;
    suppressMediaErrors = true;
    target.pause();
    target.removeAttribute('src');
    target.load();
    window.setTimeout(() => {
      suppressMediaErrors = false;
    }, 100);
  }

  function eventPayload(): PlaybackEventPayload {
    const position = Math.round((preserveBoundaryResume ? resumeSeconds : video?.currentTime ?? 0) * 10_000_000);
    return {
      ItemId: detailedItem.Id,
      MediaSourceId: mediaSource?.Id,
      PlaySessionId: playSessionId,
      PositionTicks: position,
      CanSeek: true,
      IsPaused: preserveBoundaryResume ? !restartShouldResume : video?.paused ?? true,
      IsMuted: video?.muted ?? false,
      VolumeLevel: Math.round((video?.volume ?? 1) * 100),
      PlayMethod: playMethod,
      RepeatMode: 'RepeatNone',
      PlaybackStartTimeTicks: detailedItem.UserData?.PlaybackPositionTicks ?? 0,
      AudioStreamIndex: selectedAudioOption()?.index,
      SubtitleStreamIndex: selectedSubtitleOption()?.index ?? undefined
    };
  }

  function streamOfType(source: JellyfinMediaSource, type: JellyfinMediaStream['Type']) {
    return source.MediaStreams?.find((stream) => stream.Type === type);
  }

  function selectedAudioOption() {
    return playbackAudioById(audioOptions, selectedAudioId);
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
    const audioStream = selectedAudioOption()?.stream ?? containerDefaultAudioStream(source);
    const resolution = videoStream?.Width && videoStream?.Height ? `${videoStream.Width}x${videoStream.Height}` : '';
    return [source.Container, videoStream?.Codec, audioStream?.Codec, resolution].filter(Boolean).join(' · ');
  }

  function buildSubtitleOptions(source: JellyfinMediaSource): SubtitleOption[] {
    const options: SubtitleOption[] = [{ id: 'off', label: 'Off', detail: 'No captions', stream: null, index: null, delivery: 'off' }];
    for (const stream of source.MediaStreams ?? []) {
      if (stream.Type !== 'Subtitle' || stream.Index === undefined) continue;
      const delivery = canUseTextTrack(stream) ? 'track' : 'burn';
      options.push({
        id: `subtitle-${stream.Index}`,
        label: subtitleLabel(stream),
        detail: subtitleDetail(stream, delivery),
        stream,
        index: stream.Index,
        delivery
      });
    }
    return options;
  }

  function initialSubtitleId(source: JellyfinMediaSource, options: SubtitleOption[]) {
    const preference = localStorage.getItem('jellytube.subtitlePreference') ?? 'default';
    if (preference === 'off') return 'off';

    if (preference.startsWith('lang:')) {
      const language = preference.slice(5);
      const languageMatch = options.find((option) => option.stream?.Language === language);
      if (languageMatch) return languageMatch.id;
    }

    const defaultIndex = source.DefaultSubtitleStreamIndex;
    const defaultOption = options.find((option) => option.index === defaultIndex);
    if (defaultOption) return defaultOption.id;

    const forcedOption = options.find((option) => option.stream?.IsForced || /forced/i.test(option.stream?.Title ?? option.stream?.DisplayTitle ?? ''));
    return forcedOption?.id ?? 'off';
  }

  function canUseTextTrack(stream: JellyfinMediaStream) {
    if (stream.DeliveryMethod === 'Encode') return false;
    if (stream.IsTextSubtitleStream === false) return false;
    const codec = normalizeSubtitleCodec(stream.Codec);
    return codec === 'subrip' || codec === 'srt' || codec === 'mov_text' || codec === 'vtt' || codec === 'webvtt' || codec === 'ass' || codec === 'ssa';
  }

  function selectedSubtitleOption() {
    return subtitleOptions.find((option) => option.id === selectedSubtitleId) ?? subtitleOptions[0];
  }

  function selectedSubtitleRequiresHls() {
    return selectedSubtitleOption()?.delivery === 'burn';
  }

  function textTrackUrlForSelection() {
    return textTrackUrlForOption(selectedSubtitleOption());
  }

  function textTrackUrlForOption(option: SubtitleOption | undefined) {
    if (!mediaSource || !option || option.delivery !== 'track' || option.index === null) return '';
    return client.getSubtitleStreamUrl(item.Id, mediaSource.Id, option.index, 'vtt');
  }

  function subtitleLabel(stream: JellyfinMediaStream) {
    const raw = stream.DisplayTitle || stream.Title || stream.Language || `Subtitle ${stream.Index}`;
    return raw.replace(/\s+-\s+SUBRIP$/i, '').replace(/\s+-\s+MOV_TEXT$/i, '').replace(/\s+-\s+PGSSUB$/i, '').replace(/\s+-\s+DVDSUB$/i, '');
  }

  function subtitleDetail(stream: JellyfinMediaStream, delivery: SubtitleOption['delivery']) {
    const parts = [
      stream.Language ? stream.Language.toUpperCase() : '',
      stream.IsDefault ? 'Default' : '',
      stream.IsForced || /forced/i.test(stream.Title ?? stream.DisplayTitle ?? '') ? 'Forced' : '',
      stream.IsExternal ? 'External' : 'Embedded',
      normalizeSubtitleCodec(stream.Codec).toUpperCase(),
      delivery === 'burn' ? 'Burn-in transcode' : 'Text track'
    ];
    return parts.filter(Boolean).join(' · ');
  }

  function normalizeSubtitleCodec(codec?: string) {
    return (codec ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  }

  async function syncTextTrackMode() {
    await tick();
    if (!video) return;
    const option = selectedSubtitleOption();
    for (let index = 0; index < video.textTracks.length; index += 1) {
      const track = video.textTracks[index];
      track.mode = activeTextTrackUrl && option?.delivery === 'track' ? 'showing' : 'disabled';
    }
  }

  async function handleSubtitleTrackError() {
    const currentOption = selectedSubtitleOption();
    if (!mediaSource || !currentOption || currentOption.delivery !== 'track' || currentOption.index === null) return;
    const failedOption = currentOption;
    const previousTime = video?.currentTime ?? currentTime;
    const shouldResume = Boolean(video && !video.paused && !video.ended) || playRequested;
    fallbackNotice = `${failedOption.label} could not load as text captions. Falling back to Jellyfin burn-in subtitles.`;
    const burnedOption: SubtitleOption = { ...failedOption, delivery: 'burn', detail: subtitleDetail(failedOption.stream!, 'burn') };
    subtitleOptions = subtitleOptions.map((option) => (option.id === failedOption.id ? burnedOption : option));
    activeTextTrackUrl = '';
    resumeSeconds = Number.isFinite(previousTime) ? previousTime : 0;
    currentTime = resumeSeconds;
    attempts = buildPlaybackAttempts(mediaSource, selectedQualityId, burnedOption);
    if (!attempts.length) return;
    try {
      await startAttempt(0, shouldResume);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not fall back to burned-in subtitles.';
      controlsVisible = true;
    }
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
    const shouldSeek = preserveBoundaryResume
      ? resumeSeconds > 0 && duration > 0
      : resumeSeconds > 1 && duration > 0 && resumeSeconds < duration - 1;
    if (!seekApplied && shouldSeek) {
      video.currentTime = preserveBoundaryResume
        ? Math.min(resumeSeconds, Math.max(0, duration - 0.05))
        : resumeSeconds;
      seekApplied = true;
    }
    syncPlaybackState();
    void syncTextTrackMode();
    loading = false;
    clearBuffering();
    if (cinematicMode) scheduleCinematicSample(180);
  }

  function clearBuffering() {
    if (bufferingTimer) window.clearTimeout(bufferingTimer);
    bufferingTimer = 0;
    buffering = false;
  }

  function handleWaiting() {
    if (!video || video.paused || buffering || bufferingTimer) return;
    clearCinematicTimer();
    bufferingTimer = window.setTimeout(() => {
      bufferingTimer = 0;
      if (!video || video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      buffering = true;
    }, BUFFERING_INDICATOR_DELAY_MS);
  }

  function handlePlay() {
    isPlaying = true;
    playRequested = true;
    clearBuffering();
    if (fallbackNotice.startsWith('Autoplay was blocked')) fallbackNotice = '';
    void reportStart();
    scheduleControls();
    scheduleCinematicSample(160);
  }

  function handlePause() {
    isPlaying = false;
    clearBuffering();
    controlsVisible = true;
    clearCinematicTimer();
    if (!suppressMediaErrors) {
      playRequested = false;
      void safeReport('progress');
    }
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
    if (recommendationAutoplayEntry) dispatch('recommendationSelect', recommendationAutoplayEntry);
  }

  function syncPlaybackState() {
    currentTime = video?.currentTime || 0;
    duration = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : durationSeconds;
    isMuted = video?.muted ?? false;
    volume = video?.volume ?? volume;
    syncBuffered();
    maybeAdvancePlayingNextBeforeEnd();
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
    if (minimized) {
      dispatch('restore');
      return;
    }
    if (qualityMenuOpen || subtitleMenuOpen || audioMenuOpen || aspectMenuOpen) {
      qualityMenuOpen = false;
      subtitleMenuOpen = false;
      audioMenuOpen = false;
      aspectMenuOpen = false;
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
    if (minimized) {
      dispatch('restore');
      return;
    }
    playerShell?.focus();
    void toggleFullscreen();
  }

  function toggleAutoplayNext() {
    autoplayNext = !autoplayNext;
    localStorage.setItem('jellytube.autoplayNext', String(autoplayNext));
  }

  function dismissPlayingNext() {
    autoplayNext = false;
    controlsVisible = true;
    localStorage.setItem('jellytube.autoplayNext', 'false');
  }

  function playNextEpisodeNow() {
    advanceToPlayingNext();
  }

  function maybeAdvancePlayingNextBeforeEnd() {
    if (
      !shouldAdvancePlayingNext({
        currentTime,
        duration: durationSeconds,
        nextItem: episodePlayingNext,
        autoplayNext: autoplayNext && !loopMusicVideo
      }) ||
      !episodePlayingNext
    ) {
      return;
    }

    const advanceKey = `${item.Id}:${episodePlayingNext.Id}`;
    if (playingNextAdvanceKey === advanceKey) return;
    playingNextAdvanceKey = advanceKey;
    dispatch('finished', detailedItem);
    advanceToPlayingNext();
  }

  function advanceToPlayingNext() {
    if (!episodePlayingNext) return;
    if (hasNextQueued && queue[queueIndex + 1]?.Id === episodePlayingNext.Id) {
      dispatch('next');
      return;
    }
    dispatch('episodeSelect', episodePlayingNext);
  }

  function toggleLoopMusicVideo() {
    loopMusicVideo = !loopMusicVideo;
    localStorage.setItem('jellytube.loopMusicVideo', String(loopMusicVideo));
  }

  function toggleAudioMenu(event: MouseEvent) {
    event.stopPropagation();
    audioMenuOpen = !audioMenuOpen;
    if (audioMenuOpen) {
      qualityMenuOpen = false;
      subtitleMenuOpen = false;
      aspectMenuOpen = false;
    }
    controlsVisible = true;
    if (!audioMenuOpen) scheduleControls();
  }

  async function selectAudio(event: MouseEvent, option: PlaybackAudioOption) {
    event.stopPropagation();
    audioMenuOpen = false;
    controlsVisible = true;
    if (!mediaSource || option.id === selectedAudioId) {
      scheduleControls();
      return;
    }

    const previousTime = video?.currentTime ?? currentTime;
    const shouldResume = Boolean(video && !video.paused && !video.ended) || playRequested;
    const preferenceKey = playbackAudioPreferenceKey(client.serverUrl, client.userId ?? '');
    pendingAudioRollback = {
      audioId: selectedAudioId,
      qualityOptions,
      qualityId: selectedQualityId,
      preferenceKey,
      preference: localStorage.getItem(preferenceKey),
      shouldResume,
      attemptedLabel: option.label
    };

    selectedAudioId = option.id;
    localStorage.setItem(preferenceKey, serializePlaybackAudioPreference(option));
    qualityOptions = playbackQualityOptions(mediaSource, { directAvailable: Boolean(getDirectAttempt(mediaSource)) });
    selectedQualityId = playbackQualityById(qualityOptions, preferredQualityId)?.id ?? 'auto';
    resumeSeconds = Number.isFinite(previousTime) ? previousTime : 0;
    currentTime = resumeSeconds;
    preserveBoundaryResume = true;
    restartShouldResume = shouldResume;
    attempts = buildPlaybackAttempts(mediaSource, selectedQualityId);

    if (!attempts.length) {
      rollbackPendingAudioSelection();
      fallbackNotice = `${option.label} is not available for this stream.`;
      preserveBoundaryResume = false;
      restartShouldResume = false;
      scheduleControls();
      return;
    }

    try {
      await startAttempt(0, shouldResume);
    } catch (caught) {
      const rollback = rollbackPendingAudioSelection();
      if (!rollback || !attempts.length) {
        error = caught instanceof Error ? caught.message : 'Could not switch audio tracks.';
        controlsVisible = true;
        preserveBoundaryResume = false;
        restartShouldResume = false;
        return;
      }
      try {
        await startAttempt(0, rollback.shouldResume);
        fallbackNotice = `${option.label} could not be selected. Restored the previous audio track.`;
      } catch (restoreCaught) {
        error = restoreCaught instanceof Error ? restoreCaught.message : 'Could not restore the previous audio track.';
        controlsVisible = true;
        preserveBoundaryResume = false;
        restartShouldResume = false;
      }
    }
  }

  function rollbackPendingAudioSelection() {
    const rollback = pendingAudioRollback;
    if (!rollback) return null;
    pendingAudioRollback = null;
    selectedAudioId = rollback.audioId;
    qualityOptions = rollback.qualityOptions;
    selectedQualityId = rollback.qualityId;
    restoreAudioPreference(rollback.preferenceKey, rollback.preference);
    attempts = mediaSource ? buildPlaybackAttempts(mediaSource, selectedQualityId) : [];
    return rollback;
  }

  function restoreAudioPreference(key: string, preference: string | null) {
    if (preference === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, preference);
    }
  }

  function toggleQualityMenu(event: MouseEvent) {
    event.stopPropagation();
    qualityMenuOpen = !qualityMenuOpen;
    if (qualityMenuOpen) {
      subtitleMenuOpen = false;
      audioMenuOpen = false;
      aspectMenuOpen = false;
    }
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

  function toggleSubtitleMenu(event: MouseEvent) {
    event.stopPropagation();
    subtitleMenuOpen = !subtitleMenuOpen;
    if (subtitleMenuOpen) {
      qualityMenuOpen = false;
      audioMenuOpen = false;
      aspectMenuOpen = false;
    }
    controlsVisible = true;
    if (!subtitleMenuOpen) scheduleControls();
  }

  async function selectSubtitle(event: MouseEvent, option: SubtitleOption) {
    event.stopPropagation();
    subtitleMenuOpen = false;
    controlsVisible = true;
    if (!mediaSource || option.id === selectedSubtitleId) {
      scheduleControls();
      return;
    }

    const previousSubtitleId = selectedSubtitleId;
    const previousTrackUrl = activeTextTrackUrl;
    const previousRequiresHls = selectedSubtitleRequiresHls();
    const previousTime = video?.currentTime ?? currentTime;
    const shouldResume = Boolean(video && !video.paused && !video.ended) || playRequested;

    selectedSubtitleId = option.id;
    activeTextTrackUrl = textTrackUrlForOption(option);
    if (option.index === null || option.index === undefined) {
      localStorage.setItem('jellytube.subtitlePreference', 'off');
    } else if (option.stream?.Language) {
      localStorage.setItem('jellytube.subtitlePreference', `lang:${option.stream.Language}`);
    } else {
      localStorage.setItem('jellytube.subtitlePreference', 'default');
    }

    const nextRequiresHls = option.delivery === 'burn';
    const mustRestartStream = previousRequiresHls || nextRequiresHls;

    if (!mustRestartStream) {
      await syncTextTrackMode();
      scheduleControls();
      return;
    }

    resumeSeconds = Number.isFinite(previousTime) ? previousTime : 0;
    currentTime = resumeSeconds;
    attempts = buildPlaybackAttempts(mediaSource, selectedQualityId, option);

    if (!attempts.length) {
      selectedSubtitleId = previousSubtitleId;
      activeTextTrackUrl = previousTrackUrl;
      fallbackNotice = `${option.label} is not available for this stream.`;
      scheduleControls();
      return;
    }

    try {
      await startAttempt(0, shouldResume);
    } catch (caught) {
      selectedSubtitleId = previousSubtitleId;
      activeTextTrackUrl = previousTrackUrl;
      error = caught instanceof Error ? caught.message : 'Could not switch subtitles.';
      controlsVisible = true;
    }
  }

  function toggleAspectMenu(event: MouseEvent) {
    event.stopPropagation();
    aspectMenuOpen = !aspectMenuOpen;
    if (aspectMenuOpen) {
      qualityMenuOpen = false;
      subtitleMenuOpen = false;
      audioMenuOpen = false;
    }
    controlsVisible = true;
    if (!aspectMenuOpen) scheduleControls();
  }

  function selectAspect(event: MouseEvent, option: PlayerAspectOption) {
    event.stopPropagation();
    aspectMode = option.id;
    aspectMenuOpen = false;
    controlsVisible = true;
    localStorage.setItem(PLAYER_ASPECT_STORAGE_KEY, aspectMode);
    localStorage.removeItem(LEGACY_ULTRAWIDE_CROP_STORAGE_KEY);
    scheduleControls();
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
    if (event.key === 'Escape' && (qualityMenuOpen || subtitleMenuOpen || audioMenuOpen || aspectMenuOpen)) {
      event.preventDefault();
      qualityMenuOpen = false;
      subtitleMenuOpen = false;
      audioMenuOpen = false;
      aspectMenuOpen = false;
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
      seekBy(-SEEK_STEP_SECONDS);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBy(SEEK_STEP_SECONDS);
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
    if (!isPlaying || qualityMenuOpen || subtitleMenuOpen || audioMenuOpen || aspectMenuOpen) return;
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
    if (minimized || !cinematicMode || cinematicBlocked || cinematicAvailability === 'unavailable' || error || loading || buffering) {
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

  function startMiniPlayerResize(event: PointerEvent, axis: MiniPlayerResizeAxis) {
    if (!minimized || event.button !== 0) return;
    const startWidth = watchLayout?.getBoundingClientRect().width ?? miniPlayerWidth;
    miniResizeState = {
      axis,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function resizeMiniPlayer(event: PointerEvent) {
    if (!miniResizeState || event.pointerId !== miniResizeState.pointerId) return;
    const horizontalDelta = miniResizeState.startX - event.clientX;
    const verticalDelta = (miniResizeState.startY - event.clientY) * (16 / 9);
    const resizeDelta =
      miniResizeState.axis === 'left'
        ? horizontalDelta
        : miniResizeState.axis === 'top'
          ? verticalDelta
          : Math.abs(horizontalDelta) >= Math.abs(verticalDelta)
            ? horizontalDelta
            : verticalDelta;
    miniPlayerWidth = clampedMiniPlayerWidth(miniResizeState.startWidth + resizeDelta);
    event.preventDefault();
  }

  function finishMiniPlayerResize(event: PointerEvent) {
    if (!miniResizeState || event.pointerId !== miniResizeState.pointerId) return;
    miniResizeState = null;
    persistMiniPlayerWidth();
  }

  function handleMiniPlayerResizeKeydown(event: KeyboardEvent, axis: MiniPlayerResizeAxis) {
    let delta = 0;
    if ((axis === 'left' || axis === 'corner') && event.key === 'ArrowLeft') delta = MINI_PLAYER_KEYBOARD_STEP;
    if ((axis === 'left' || axis === 'corner') && event.key === 'ArrowRight') delta = -MINI_PLAYER_KEYBOARD_STEP;
    if ((axis === 'top' || axis === 'corner') && event.key === 'ArrowUp') delta = MINI_PLAYER_KEYBOARD_STEP;
    if ((axis === 'top' || axis === 'corner') && event.key === 'ArrowDown') delta = -MINI_PLAYER_KEYBOARD_STEP;
    if (!delta) return;
    event.preventDefault();
    const renderedWidth = watchLayout?.getBoundingClientRect().width ?? miniPlayerWidth;
    miniPlayerWidth = clampedMiniPlayerWidth(renderedWidth + delta);
    persistMiniPlayerWidth();
  }

  function clampedMiniPlayerWidth(width: number) {
    const viewportMargin = window.innerWidth <= 900 ? 24 : 36;
    const maximum = Math.max(0, Math.min(MAX_MINI_PLAYER_WIDTH, window.innerWidth - viewportMargin));
    const minimum = Math.min(MIN_MINI_PLAYER_WIDTH, maximum);
    return Math.round(Math.min(maximum, Math.max(minimum, width)));
  }

  function persistMiniPlayerWidth() {
    localStorage.setItem(MINI_PLAYER_WIDTH_KEY, String(Math.round(miniPlayerWidth)));
  }

  function savedMiniPlayerWidth() {
    const stored = Number(localStorage.getItem(MINI_PLAYER_WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_MINI_PLAYER_WIDTH;
    return Math.round(Math.min(MAX_MINI_PLAYER_WIDTH, Math.max(MIN_MINI_PLAYER_WIDTH, stored)));
  }

  function savedQualityId(): PlaybackQualityId {
    const stored = localStorage.getItem('jellytube.playerQuality');
    return stored && (stored === 'auto' || stored === 'direct' || /^hls-\d+k$/.test(stored))
      ? (stored as PlaybackQualityId)
      : 'auto';
  }
</script>

<svelte:window
  on:pointermove={resizeMiniPlayer}
  on:pointerup={finishMiniPlayerResize}
  on:pointercancel={finishMiniPlayerResize}
/>

<section
  bind:this={watchLayout}
  class="watch-layout"
  class:minimized={minimized}
  class:resizing={Boolean(miniResizeState)}
  class:theater-mode={theaterMode && !minimized}
  class:cinematic-watch={cinematicMode && !minimized}
  style={minimized ? `--mini-player-width: ${miniPlayerWidth}px` : undefined}
  aria-label={minimized ? `Minimized video player for ${title}` : undefined}
>
  {#if minimized}
    <button
      class="mini-player-resize-handle mini-player-resize-top"
      aria-label="Resize minimized player from top edge"
      title="Drag to resize player"
      on:pointerdown={(event) => startMiniPlayerResize(event, 'top')}
      on:keydown={(event) => handleMiniPlayerResizeKeydown(event, 'top')}
    ></button>
    <button
      class="mini-player-resize-handle mini-player-resize-left"
      aria-label="Resize minimized player from left edge"
      title="Drag to resize player"
      on:pointerdown={(event) => startMiniPlayerResize(event, 'left')}
      on:keydown={(event) => handleMiniPlayerResizeKeydown(event, 'left')}
    ></button>
    <button
      class="mini-player-resize-handle mini-player-resize-corner"
      aria-label="Resize minimized player from top-left corner"
      title="Drag to resize player"
      on:pointerdown={(event) => startMiniPlayerResize(event, 'corner')}
      on:keydown={(event) => handleMiniPlayerResizeKeydown(event, 'corner')}
    ></button>
  {/if}

  <div class="watch-left">
    <div class="watch-player-area">
      <button class="back-button" on:click={() => dispatch('back')}>
      <ArrowLeft size={19} />
      <span>Back</span>
    </button>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="player-frame"
      class:cinematic={cinematicMode && !minimized}
      class:cinematic-ready={cinematicReady && !minimized}
      class:cinematic-unavailable={cinematicAvailability === 'unavailable' && !minimized}
      class:aspect-stretch={selectedAspect.behavior === 'stretch'}
      class:aspect-stretch-4-3={aspectMode === 'stretch-4-3'}
      class:aspect-stretch-16-9={aspectMode === 'stretch-16-9'}
      class:aspect-stretch-21-9={aspectMode === 'stretch-21-9'}
      class:ultrawide-crop={aspectMode === 'crop-21-9'}
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
        <div class="player-video-viewport">
          <video
            bind:this={video}
            crossorigin="anonymous"
            playsinline
            preload="metadata"
            poster={client.getImageUrl(detailedItem, 1280)}
            on:play={handlePlay}
            on:pause={handlePause}
            on:ended={handleEnded}
            on:loadedmetadata={handleLoadedMetadata}
            on:canplay={() => {
              preserveBoundaryResume = false;
              restartShouldResume = false;
              pendingAudioRollback = null;
              loading = false;
              clearBuffering();
              if (cinematicMode) scheduleCinematicSample(120);
            }}
            on:playing={() => {
              loading = false;
              clearBuffering();
              if (cinematicMode) scheduleCinematicSample(120);
            }}
            on:waiting={handleWaiting}
            on:timeupdate={syncPlaybackState}
            on:progress={syncBuffered}
            on:volumechange={handleVolumeChange}
            on:error={() => void handlePlaybackFailure()}
          >
            {#if activeTextTrackUrl && selectedSubtitle?.delivery === 'track'}
              {#key activeTextTrackUrl}
                <track
                  kind="subtitles"
                  src={activeTextTrackUrl}
                  srclang={selectedSubtitle.stream?.Language ?? 'und'}
                  label={selectedSubtitle.label}
                  default
                  on:load={() => void syncTextTrackMode()}
                  on:error={() => void handleSubtitleTrackError()}
                />
              {/key}
            {/if}
          </video>
        </div>

        {#if minimized}
          <div class="mini-player-actions" aria-label="Minimized player controls">
            <button
              class="mini-player-action"
              aria-label="Restore player"
              title="Restore player"
              on:click|stopPropagation={() => dispatch('restore')}
            >
              <Maximize size={19} />
            </button>
            <button
              class="mini-player-action"
              aria-label="Close player"
              title="Close player"
              on:click|stopPropagation={() => dispatch('close')}
            >
              <X size={20} />
            </button>
          </div>
        {/if}

        {#if !error}
          <button
            class="player-hit-target"
            aria-label={minimized ? 'Restore player' : isPlaying ? 'Pause' : 'Play'}
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

          {#if showPlayingNextOverlay && episodePlayingNext}
            <div class="playing-next-card" aria-live="polite">
              <div class="playing-next-info">
                <button
                  class="playing-next-thumb"
                  aria-label={`Play ${playingNextTitle || 'next episode'} now`}
                  on:click|stopPropagation={playNextEpisodeNow}
                >
                  {#if playingNextThumbnailUrl}
                    <img src={playingNextThumbnailUrl} alt="" loading="lazy" />
                  {:else}
                    <span>{playingNextTitle.slice(0, 1) || '▶'}</span>
                  {/if}
                </button>
                <div class="playing-next-copy">
                  <span class="playing-next-eyebrow">Playing next in</span>
                  <strong>{playingNextTitle}</strong>
                  <small>
                    {#if playingNextCode}
                      {playingNextCode} ·
                    {/if}
                    {episodeSeriesTitle || queueTitle || episodePlayingNext.SeriesName || 'Next episode'}
                  </small>
                </div>
              </div>
              <button
                class="playing-next-countdown"
                style={playingNextRingStyle}
                aria-label={`Play next episode now, ${playingNextCountdown} seconds remaining`}
                on:click|stopPropagation={playNextEpisodeNow}
              >
                <span>{playingNextCountdown}</span>
              </button>
              <button class="playing-next-now" on:click|stopPropagation={playNextEpisodeNow}>Play now</button>
              <button
                class="playing-next-dismiss"
                aria-label="Turn off autoplay"
                on:click|stopPropagation={dismissPlayingNext}
              >
                Not now
              </button>
            </div>
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
              <button
                class="player-control seek-step-control"
                aria-label="Back 10 seconds"
                title="Back 10 seconds"
                on:click={() => seekBy(-SEEK_STEP_SECONDS)}
              >
                <span class="seek-step-icon" aria-hidden="true">
                  <RotateCcw size={24} />
                  <span>10</span>
                </span>
              </button>
              <button
                class="player-control seek-step-control"
                aria-label="Forward 10 seconds"
                title="Forward 10 seconds"
                on:click={() => seekBy(SEEK_STEP_SECONDS)}
              >
                <span class="seek-step-icon" aria-hidden="true">
                  <RotateCw size={24} />
                  <span>10</span>
                </span>
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

              <div class="quality-control aspect-control">
                <button
                  class="player-control aspect-button"
                  class:active={aspectMode !== 'fit' || aspectMenuOpen}
                  aria-label={`Aspect ratio: ${aspectButtonLabel}`}
                  aria-expanded={aspectMenuOpen}
                  aria-haspopup="menu"
                  title={`Aspect ratio: ${aspectButtonLabel}`}
                  on:click={toggleAspectMenu}
                >
                  <Ratio size={21} />
                </button>

                {#if aspectMenuOpen}
                  <div class="quality-menu aspect-menu" role="menu" aria-label="Video aspect ratio">
                    <div class="quality-menu-heading">Aspect ratio</div>
                    {#each PLAYER_ASPECT_OPTIONS as option (option.id)}
                      <button
                        class:active={option.id === aspectMode}
                        class="quality-option aspect-option"
                        role="menuitemradio"
                        aria-checked={option.id === aspectMode}
                        on:click={(event) => selectAspect(event, option)}
                      >
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.detail}</small>
                        </span>
                        {#if option.id === aspectMode}
                          <Check size={16} />
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

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

              {#if audioOptions.length > 1}
                <div class="quality-control audio-control">
                  <button
                    class="player-control audio-button"
                    class:active={audioMenuOpen}
                    aria-label={`Audio track: ${audioButtonLabel}`}
                    aria-expanded={audioMenuOpen}
                    aria-haspopup="menu"
                    title={`Audio track: ${audioButtonLabel}`}
                    on:click={toggleAudioMenu}
                  >
                    <Languages size={21} />
                  </button>

                  {#if audioMenuOpen}
                    <div class="quality-menu subtitle-menu audio-menu" role="menu" aria-label="Audio tracks">
                      <div class="quality-menu-heading">Audio</div>
                      {#each audioOptions as option (option.id)}
                        <button
                          class:active={option.id === selectedAudioId}
                          class="quality-option audio-option"
                          role="menuitemradio"
                          aria-checked={option.id === selectedAudioId}
                          on:click={(event) => void selectAudio(event, option)}
                        >
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.detail}</small>
                          </span>
                          {#if option.id === selectedAudioId}
                            <Check size={16} />
                          {/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              {#if subtitleOptions.length > 1}
                <div class="quality-control subtitle-control">
                  <button
                    class="player-control subtitle-button"
                    class:active={subtitleActive || subtitleMenuOpen}
                    aria-label={`Captions: ${subtitleButtonLabel}`}
                    aria-expanded={subtitleMenuOpen}
                    aria-haspopup="menu"
                    title={`Captions: ${subtitleButtonLabel}`}
                    on:click={toggleSubtitleMenu}
                  >
                    <Captions size={21} />
                  </button>

                  {#if subtitleMenuOpen}
                    <div class="quality-menu subtitle-menu" role="menu" aria-label="Captions">
                      <div class="quality-menu-heading">Captions</div>
                      {#each subtitleOptions as option (option.id)}
                        <button
                          class:active={option.id === selectedSubtitleId}
                          class="quality-option subtitle-option"
                          role="menuitemradio"
                          aria-checked={option.id === selectedSubtitleId}
                          on:click={(event) => void selectSubtitle(event, option)}
                        >
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.detail}</small>
                          </span>
                          {#if option.id === selectedSubtitleId}
                            <Check size={16} />
                          {/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

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

        <div class="episode-strip" bind:this={episodeStrip} on:wheel|nonpassive={handleEpisodeStripWheel}>
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

    <ActorCast {client} actors={cast} on:select={(event) => dispatch('actor', event.detail.actor)} />
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
          {#each recommendations as recommendation (recommendationKey(recommendation))}
            {#if recommendation.kind === 'item'}
              <VideoCard
                {client}
                item={recommendation.item}
                recommendationReason={recommendation.item.reason}
                poster
                on:select={() => dispatch('recommendationSelect', recommendation)}
                on:channel={() => dispatch('movies')}
              />
            {:else}
              <ShowRecommendationCard
                {client}
                {recommendation}
                compact
                on:play={() => dispatch('recommendationSelect', recommendation)}
                on:show={(event) => dispatch('channel', event.detail)}
              />
            {/if}
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
          {#each recommendations as recommendation (recommendationKey(recommendation))}
            {#if recommendation.kind === 'item'}
              <VideoCard
                {client}
                item={recommendation.item}
                recommendationReason={recommendation.item.reason}
                compact
                titleContext={channelName(recommendation.item) === contextLabel ? 'channel' : 'feed'}
                titleChannel={contextLabel}
                on:select={() => dispatch('recommendationSelect', recommendation)}
                on:channel={(event) => dispatch('channel', event.detail)}
              />
            {:else}
              <ShowRecommendationCard
                {client}
                {recommendation}
                compact
                on:play={() => dispatch('recommendationSelect', recommendation)}
                on:show={(event) => dispatch('channel', event.detail)}
              />
            {/if}
          {/each}
        </section>
      {/if}
    {/if}
  </aside>
</section>
