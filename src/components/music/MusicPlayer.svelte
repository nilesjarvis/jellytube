<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import {
    ChevronDown,
    Heart,
    ListMusic,
    Pause,
    Play,
    Repeat,
    Repeat1,
    Shuffle,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    X
  } from 'lucide-svelte';
  import type { JellyfinClient } from '../../lib/jellyfin';
  import {
    advanceMusic,
    clearMusicResume,
    musicPlayerState,
    pause,
    persistMusicPosition,
    play,
    saveMusicResume,
    seekMusicTo,
    setMusicRepeat,
    stepMusicBack,
    stopMusic,
    toggleMusicShuffle,
    togglePlayPause
  } from '../../lib/music/store';
  import {
    currentTrack,
    currentPlaylistIndex,
    queueLength,
    queuePosition,
    type RepeatMode
  } from '../../lib/music/queue';
  import { musicStreamFor } from '../../lib/music/stream';
  import { displayTitle } from '../../lib/recommendations';
  import type { JellyfinItem, PlaybackInfo } from '../../lib/types';
  import MusicSongRow from './MusicSongRow.svelte';

  export let client: JellyfinClient;

  const dispatch = createEventDispatcher<{
    openItem: { kind: 'album' | 'artist'; id: string };
  }>();

  function clampVolume(value: number): number {
    if (!Number.isFinite(value)) return 0.8;
    return Math.max(0, Math.min(1, value));
  }

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
    return `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  const state = musicPlayerState;
  let audioEl: HTMLAudioElement;
  let loadedId: string | null = null;
  let error = '';
  let showQueue = false;
  let currentSeconds = 0;
  let durationSeconds = 0;
  let volume = clampVolume(Number(localStorage.getItem('jellytube.musicVolume') ?? 0.8) || 0.8);
  let muted = localStorage.getItem('jellytube.musicMuted') === 'true';
  let started = false;
  let reportTimer: number | undefined;
  let destroyed = false;
  // True only once the <audio> src actually points at the current track, so the
  // transport/auto-play never act on a stale (previously loaded) source.
  let readyToPlay = false;
  // Track id currently being retried via a forced-transcode (AAC) stream (once per track).
  let transcodeRetryFor: string | null = null;
  // Consecutive tracks that failed to load; bounds the auto-skip loop.
  let consecutiveLoadFailures = 0;
  let errorTimer: number | undefined;
  // Shows a spinner on the transport while the current source is buffering.
  let buffering = false;
  // Optimistic favorite state; Jellyfin sends no per-item push, so we mirror it
  // locally and mutate the loaded track's UserData in place.
  let favorite = false;
  // Throttle the persisted-position write (localStorage is synchronous).
  let lastPositionWrite = 0;

  $: queue = $state.queue;
  $: current = queue ? currentTrack(queue) : null;
  $: playing = $state.playing;
  $: position = queue ? queuePosition(queue) : 0;
  $: length = queue ? queueLength(queue) : 0;
  $: repeatMode = queue?.repeat ?? 'off';
  $: shuffle = queue?.shuffle ?? false;
  $: currentIndex = queue ? currentPlaylistIndex(queue) : -1;
  $: effectiveVolume = muted ? 0 : volume;
  // Reset the heart whenever a different track becomes current.
  $: favorite = !!current?.UserData?.IsFavorite;

  // The queue in playback order (shuffle only rewrites the index permutation),
  // used to render a meaningful "queue" drawer with now/up-next/played groups.
  $: playbackTracks = queue ? queue.order.map((index) => queue!.tracks[index]).filter(Boolean) : [];
  $: playbackCursor = queue ? queue.cursor : -1;
  $: nowTrack = playbackCursor >= 0 ? playbackTracks[playbackCursor] : null;
  $: upNext = playbackCursor >= 0 ? playbackTracks.slice(playbackCursor + 1) : playbackTracks;
  $: played = playbackCursor > 0 ? playbackTracks.slice(0, playbackCursor) : [];

  $: shuffleTitle = shuffle ? 'Turn off shuffle' : 'Turn on shuffle';
  $: repeatTitle =
    repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one';

  // Where the now-playing art/title should navigate: the track's album, or its
  // first artist as a fallback. Returns null when there's nothing to open.
  function currentContext(): { kind: 'album' | 'artist'; id: string } | null {
    if (!current) return null;
    const albumId = current.AlbumId || current.AlbumArtists?.[0]?.Id;
    if (albumId) return { kind: 'album', id: albumId };
    const artistId = current.ArtistItems?.[0]?.Id;
    if (artistId) return { kind: 'artist', id: artistId };
    return null;
  }
  $: ctx = currentContext();

  $: if (audioEl && queue) {
    const ready = readyToPlay && loadedId === current?.Id;
    if (ready && playing && audioEl.paused) void audioEl.play().catch(() => undefined);
    else if (ready && !playing && !audioEl.paused) audioEl.pause();
  }

  $: if (audioEl) audioEl.volume = effectiveVolume;

  $: if (current) void loadIfNeeded(current);
  $: updateMediaSession(current, $state.playing);

  function showError(message: string) {
    error = message;
    if (errorTimer !== undefined) {
      window.clearTimeout(errorTimer);
      errorTimer = undefined;
    }
    errorTimer = window.setTimeout(() => {
      error = '';
      errorTimer = undefined;
    }, 6000);
  }

  function isRepeatOne(): boolean {
    return queue?.repeat === 'one';
  }

  function loadIfNeeded(track: JellyfinItem) {
    if (!track || loadedId === track.Id || !audioEl) return Promise.resolve();
    loadedId = track.Id;
    readyToPlay = false;
    buffering = true;
    error = '';
    const expected = track.Id;
    const forceTranscode = transcodeRetryFor === track.Id;
    return client
      .getAudioPlaybackInfo(track.Id, 0, forceTranscode)
      .then((info: PlaybackInfo) => {
        const stream = musicStreamFor(client, track.Id, info, { forceTranscode });
        if (loadedId !== expected || destroyed) return;
        if (!stream) {
          handleLoadError(track);
          return;
        }
        started = false;
        currentSeconds = 0;
        durationSeconds = 0;
        audioEl.src = stream.src;
        readyToPlay = true;
        // Resume where we left off if the player was torn down mid-track (e.g.
        // a video was opened) or restored after a page refresh.
        if ($state.resume?.trackId === track.Id) {
          const resumeSeconds = $state.resume.ticks / 10_000_000;
          if (Number.isFinite(resumeSeconds) && resumeSeconds > 0) {
            currentSeconds = resumeSeconds;
            audioEl.currentTime = resumeSeconds;
          }
          clearMusicResume();
        } else {
          audioEl.currentTime = 0;
        }
        if ($state.playing) void audioEl.play().catch(() => undefined);
      })
      .catch(() => {
        if (loadedId === expected && !destroyed) handleLoadError(track);
      });
  }

  /**
   * Recover from a track that refused to load. The direct stream is retried once
   * via a forced-transcode (AAC) stream; if that also fails the track is skipped
   * (linear/repeat-all play) or playback is stopped (single-track repeat, or too
   * many consecutive failures) so the player never hangs or loops forever.
   */
  function handleLoadError(track: JellyfinItem) {
    if (destroyed || !track || loadedId !== track.Id) return;

    if (transcodeRetryFor !== track.Id && !isRepeatOne()) {
      transcodeRetryFor = track.Id;
      loadedId = null;
      void loadIfNeeded(track);
      return;
    }

    consecutiveLoadFailures += 1;
    const failureLimit = Math.max(queue?.tracks.length ?? 0, 3) + 1;

    if (consecutiveLoadFailures >= failureLimit) {
      showError('Too many songs failed to load. Playback stopped.');
      loadedId = null;
      readyToPlay = false;
      buffering = false;
      pause();
      void reportStop();
      return;
    }

    showError(
      isRepeatOne()
        ? 'This song cannot be played.'
        : `Could not play “${displayTitle(track)}”.`
    );
    loadedId = null;
    readyToPlay = false;
    buffering = false;

    if (isRepeatOne()) {
      pause();
      void reportStop();
      return;
    }
    void reportStop();
    advanceMusic();
  }

  /** Media decode/fetch failures surfaced by the <audio> element. */
  function onAudioError() {
    if (destroyed || !current || loadedId !== current.Id || !readyToPlay) return;
    if (!audioEl.error) return;
    handleLoadError(current);
  }

  function onTimeUpdate() {
    currentSeconds = audioEl.currentTime || 0;
    if (Number.isFinite(audioEl.duration)) durationSeconds = audioEl.duration;
    // Persist roughly where we are ~every 8s so a refresh can resume mid-track.
    const now = Date.now();
    if (current && currentSeconds > 0 && now - lastPositionWrite > 8000) {
      lastPositionWrite = now;
      persistMusicPosition(current.Id, currentSeconds * 10_000_000);
    }
  }

  function onWaiting() {
    if (playing && current) buffering = true;
  }
  function onCanPlay() {
    buffering = false;
  }

  function onEnded() {
    if (current) persistMusicPosition(current.Id, 0);
    if (queue?.repeat === 'one') {
      audioEl.currentTime = 0;
      void audioEl.play().catch(() => undefined);
      return;
    }
    void reportStop();
    advanceMusic();
  }

  function onPlay() {
    buffering = false;
    // A successful start resets the failure bookkeeping and direct-play retry,
    // so a track revisited later can try direct play again.
    consecutiveLoadFailures = 0;
    transcodeRetryFor = null;
    reportStart();
  }

  function onPause() {
    if (current) persistMusicPosition(current.Id, (audioEl.currentTime || 0) * 10_000_000);
    void reportStop();
  }

  function seekTo(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    audioEl.currentTime = seconds;
    currentSeconds = seconds;
    if (current) persistMusicPosition(current.Id, seconds * 10_000_000);
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('jellytube.musicMuted', String(muted));
  }

  function cycleRepeat() {
    if (!queue) return;
    const order: RepeatMode[] = ['off', 'all', 'one'];
    const next = order[(order.indexOf(repeatMode) + 1) % order.length];
    setMusicRepeat(next);
  }

  function cycleShuffle() {
    toggleMusicShuffle();
  }

  function selectTrack(track: JellyfinItem) {
    // Clicking the already-current row pauses/resumes instead of restarting it.
    if (track.Id === current?.Id) {
      togglePlayPause();
    } else {
      seekMusicTo(track.Id);
    }
    showQueue = false;
  }

  function onQueueToggle() {
    showQueue = !showQueue;
  }

  function openCurrentContext() {
    const target = currentContext();
    if (!target) return;
    dispatch('openItem', target);
  }

  async function toggleFavorite() {
    if (!current) return;
    const next = !favorite;
    const previous = favorite;
    favorite = next;
    if (current.UserData) current.UserData.IsFavorite = next;
    try {
      await client.setFavorite(current.Id, next);
    } catch {
      // Revert the optimistic update on failure.
      favorite = previous;
      if (current.UserData) current.UserData.IsFavorite = previous;
    }
  }

  // ---- Jellyfin playback reporting (Scrobble-style progress) ----
  function reportStart() {
    if (started || !current) return;
    started = true;
    void safeReport('start');
    reportTimer = window.setInterval(() => void safeReport('progress'), 15_000);
  }

  function reportStop() {
    if (reportTimer !== undefined) {
      window.clearInterval(reportTimer);
      reportTimer = undefined;
    }
    if (started) void safeReport('stop');
    started = false;
  }

  async function safeReport(kind: 'start' | 'progress' | 'stop') {
    if (!current || !audioEl) return;
    try {
      const payload = {
        ItemId: current.Id,
        PositionTicks: Math.round((audioEl.currentTime || 0) * 10_000_000),
        IsPaused: audioEl.paused,
        IsMuted: muted,
        VolumeLevel: Math.round(effectiveVolume * 100),
        CanSeek: true,
        PlayMethod: 'DirectPlay' as const,
        RepeatMode: 'RepeatNone' as const
      };
      if (kind === 'start') await client.reportPlaybackStart(payload);
      else if (kind === 'progress') await client.reportPlaybackProgress(payload);
      else await client.reportPlaybackStopped(payload);
    } catch {
      // Reporting is best-effort.
    }
  }

  function updateMediaSession(track: JellyfinItem | null, isPlaying: boolean) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = track ? client.getImageUrl(track, 320) : '';
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.Name,
            artist: track.AlbumArtist || track.Artists?.join(', ') || '',
            album: track.Album ?? '',
            // Only attach artwork when an image actually exists so the OS
            // notification never shows a broken/blank tile.
            artwork: art ? [{ src: art, sizes: '320x320', type: 'image/jpeg' }] : []
          })
        : null;
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('previoustrack', () => stepMusicBack());
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (queue?.repeat === 'one') setMusicRepeat('off');
        advanceMusic();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) seekTo(details.seekTime);
      });
    } catch {
      // Media Session is optional.
    }
  }

  function saveVolume(value: number) {
    volume = clampVolume(value);
    if (muted && volume > 0) {
      muted = false;
      localStorage.setItem('jellytube.musicMuted', 'false');
    }
    localStorage.setItem('jellytube.musicVolume', String(volume));
  }

  function close() {
    void reportStop();
    stopMusic();
  }

  // ---- Keyboard shortcuts (only while this player is mounted & a track exists) ----
  function onGlobalKeydown(event: KeyboardEvent) {
    if (!current) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    // Don't steal keys while typing or when a control/button is focused
    // (otherwise space would re-trigger whatever button was last clicked).
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') {
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      togglePlayPause();
    } else if (key === 'm') {
      toggleMute();
    } else if (key === 'n' || key === '.') {
      advanceMusic();
    } else if (key === 'p' || key === ',') {
      stepMusicBack();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', onGlobalKeydown);
    return () => document.removeEventListener('keydown', onGlobalKeydown);
  });

  onDestroy(() => {
    destroyed = true;
    // Remember where the current track stopped so a video detour (which
    // unmounts the whole player) can resume on return.
    if (current && audioEl) saveMusicResume(current.Id, Math.round((audioEl.currentTime || 0) * 10_000_000));
    reportStop();
  });
</script>

<audio
  bind:this={audioEl}
  on:timeupdate={onTimeUpdate}
  on:ended={onEnded}
  on:play={onPlay}
  on:pause={onPause}
  on:error={onAudioError}
  on:waiting={onWaiting}
  on:canplay={onCanPlay}
  on:playing={onCanPlay}
  preload="metadata"
></audio>

{#if current}
  <div class="music-player" class:expanded={showQueue}>
    <div class="music-now">
      {#if ctx}
        <button class="music-now-main" on:click={openCurrentContext} title={"Open " + (ctx!.kind === 'album' ? 'album' : 'artist')}>
          <span class="music-now-art">
            {#if client.getImageUrl(current, 220)}
              <img src={client.getImageUrl(current, 220)} alt="" loading="lazy" />
            {:else}
              <span>{displayTitle(current).slice(0, 1)}</span>
            {/if}
          </span>
          <span class="music-now-meta">
            <strong>{displayTitle(current)}</strong>
            <small>{current.AlbumArtist || current.Artists?.join(', ') || current.Album}</small>
          </span>
        </button>
      {:else}
        <span class="music-now-main">
          <span class="music-now-art">
            {#if client.getImageUrl(current, 220)}
              <img src={client.getImageUrl(current, 220)} alt="" loading="lazy" />
            {:else}
              <span>{displayTitle(current).slice(0, 1)}</span>
            {/if}
          </span>
          <span class="music-now-meta">
            <strong>{displayTitle(current)}</strong>
            <small>{current.AlbumArtist || current.Artists?.join(', ') || current.Album}</small>
          </span>
        </span>
      {/if}
      {#if current.UserData}
        <button class="music-tbtn music-fav" class:active={favorite} title={favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={favorite} on:click={toggleFavorite}>
          <Heart size={18} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      {/if}
    </div>

    <div class="music-transport">
      <div class="music-button-row">
        <button class:active={shuffle} class="music-tbtn" title={shuffleTitle} aria-label={shuffleTitle} aria-pressed={shuffle} on:click={cycleShuffle}>
          <Shuffle size={18} />
        </button>
        <button class="music-tbtn" title="Previous" aria-label="Previous track" on:click={() => stepMusicBack()}>
          <SkipBack size={20} fill="currentColor" />
        </button>
        <button class="music-play-toggle" title={playing ? 'Pause' : 'Play'} aria-label={playing ? (buffering ? 'Buffering' : 'Pause') : 'Play'} on:click={() => togglePlayPause()}>
          {#if playing && buffering}
            <span class="music-spinner" aria-hidden="true"></span>
          {:else if playing}
            <Pause size={20} fill="currentColor" />
          {:else}
            <Play size={20} fill="currentColor" />
          {/if}
        </button>
        <button class="music-tbtn" title="Next" aria-label="Next track" on:click={() => advanceMusic()}>
          <SkipForward size={20} fill="currentColor" />
        </button>
        <button class:active={repeatMode !== 'off'} class="music-tbtn" title={repeatTitle} aria-label={repeatTitle} aria-pressed={repeatMode !== 'off'} on:click={cycleRepeat}>
          {#if repeatMode === 'one'}
            <Repeat1 size={18} />
          {:else}
            <Repeat size={18} />
          {/if}
        </button>
      </div>
      <div class="music-scrubber">
        <span class="music-time">{formatTime(currentSeconds)}</span>
        <input
          class="music-range"
          type="range"
          min="0"
          max={durationSeconds || 0}
          step="1"
          value={currentSeconds}
          aria-label="Seek"
          on:input={(event) => seekTo(Number((event.currentTarget as HTMLInputElement).value))}
          style="--pct: {durationSeconds ? (currentSeconds / durationSeconds) * 100 : 0}%"
        />
        <span class="music-time">{formatTime(durationSeconds)}</span>
      </div>
    </div>

    <div class="music-side">
      {#if length > 1}
        <span class="music-position" title="Your place in the queue">{position} / {length}</span>
      {/if}
      <button class="music-tbtn" title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} on:click={toggleMute}>
        {#if muted || volume === 0}
          <VolumeX size={18} />
        {:else}
          <Volume2 size={18} />
        {/if}
      </button>
      <input
        class="music-range music-volume"
        type="range"
        min="0"
        max="1"
        step="0.02"
        value={volume}
        aria-label="Volume"
        on:input={(event) => saveVolume(Number((event.currentTarget as HTMLInputElement).value))}
        style="--pct: {volume * 100}%"
      />
      <button class:active={showQueue} class="music-tbtn" title="Queue" aria-label="Queue" aria-pressed={showQueue} on:click={onQueueToggle}>
        {#if showQueue}
          <ChevronDown size={18} />
        {:else}
          <ListMusic size={18} />
        {/if}
      </button>
    </div>

    <button class="music-tbtn music-close" title="Close player" aria-label="Stop and close player" on:click={close}>
      <X size={16} />
    </button>

    {#if showQueue && queue}
      <div class="music-queue">
        <div class="music-queue-head">
          <strong>Queue</strong>
          {#if length > 1}<span class="music-queue-count">{length} tracks</span>{/if}
          <button class="text-action" class:active={shuffle} on:click={cycleShuffle} title={shuffleTitle}>{shuffle ? 'Shuffling' : 'Shuffle'}</button>
        </div>
        <div class="music-queue-list">
          {#if nowTrack}
            <div class="music-queue-group-label">Now playing</div>
            <MusicSongRow song={nowTrack} active={nowTrack.Id === current.Id} playingNow={nowTrack.Id === current.Id && playing} on:select={(event) => selectTrack(event.detail)} />
          {/if}
          {#if upNext.length}
            <div class="music-queue-group-label">Up next</div>
            {#each upNext as track (track.Id)}
              <MusicSongRow song={track} active={false} playingNow={false} on:select={(event) => selectTrack(event.detail)} />
            {/each}
          {/if}
          {#if played.length}
            <div class="music-queue-group-label">Played</div>
            {#each played as track (track.Id)}
              <MusicSongRow song={track} past active={false} playingNow={false} on:select={(event) => selectTrack(event.detail)} />
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    {#if error}
      <div class="music-error">{error}</div>
    {/if}
  </div>
{/if}

<style>
  .music-player {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: grid;
    grid-template-areas: "now transport side";
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    padding: 10px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 -6px 18px var(--shadow);
  }
  .music-now { grid-area: now; }
  .music-transport { grid-area: transport; }
  .music-side { grid-area: side; }
  .music-now {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .music-now-main {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0;
    border: 0;
    color: var(--text);
    text-align: left;
    background: transparent;
  }
  button.music-now-main {
    cursor: pointer;
    border-radius: 6px;
  }
  button.music-now-main:hover {
    background: var(--soft);
  }
  button.music-now-main:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .music-now-art {
    width: 52px;
    height: 52px;
    flex: none;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 6px;
    background: var(--soft);
    color: var(--muted);
    font-weight: 800;
  }
  .music-now-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .music-now-meta {
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .music-now-meta strong,
  .music-now-meta small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .music-now-meta strong {
    font-size: 0.95rem;
  }
  .music-now-meta small {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .music-fav.active {
    color: var(--brand);
  }
  .music-transport {
    display: grid;
    justify-items: center;
    gap: 6px;
  }
  .music-button-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .music-tbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 6px;
    color: var(--text);
    background: transparent;
  }
  .music-tbtn:hover {
    background: var(--soft);
  }
  .music-tbtn.active {
    color: var(--focus);
  }
  .music-play-toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    color: var(--bg);
    background: var(--text);
  }
  .music-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid color-mix(in srgb, var(--bg) 55%, transparent);
    border-top-color: var(--bg);
    border-radius: 50%;
    animation: musicSpin 0.8s linear infinite;
  }
  .music-scrubber {
    width: 100%;
    max-width: 560px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .music-time {
    color: var(--muted);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .music-range {
    -webkit-appearance: none;
    appearance: none;
    flex: 1;
    height: 4px;
    border-radius: 4px;
    background: linear-gradient(
      to right,
      var(--brand) 0 var(--pct),
      var(--border) var(--pct) 100%
    );
    outline: none;
  }
  .music-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--brand);
    border: 0;
    cursor: pointer;
  }
  .music-range::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--brand);
    border: 0;
    cursor: pointer;
  }
  .music-side {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .music-position {
    margin-right: 8px;
    color: var(--muted);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .music-volume {
    max-width: 88px;
  }
  .music-close {
    position: absolute;
    top: 8px;
    right: 8px;
  }
  .music-error {
    position: absolute;
    left: 50%;
    bottom: 66px;
    transform: translateX(-50%);
    padding: 8px 12px;
    border-radius: 6px;
    color: #fff;
    background: rgba(0, 0, 0, 0.75);
    font-size: 0.82rem;
  }
  .music-queue {
    position: absolute;
    right: 16px;
    bottom: calc(100% + 8px);
    width: min(420px, calc(100vw - 32px));
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
    box-shadow: 0 12px 34px var(--shadow);
  }
  .music-queue-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .music-queue-head strong {
    margin-right: auto;
  }
  .music-queue-count {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .music-queue-head .text-action.active {
    color: var(--focus);
  }
  .music-queue-list {
    overflow-y: auto;
    padding: 6px;
  }
  .music-queue-group-label {
    padding: 10px 12px 4px;
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  @media (max-width: 900px) {
    .music-player {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) auto;
      gap: 12px;
      padding: 8px 12px;
    }
    .music-position {
      display: none;
    }
    .music-volume {
      max-width: 64px;
    }
  }
  /* On phones, stack the player into rows so every control stays reachable:
     now-playing + close on top, transport below, then volume/queue. */
  @media (max-width: 640px) {
    .music-player {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "now close"
        "transport transport"
        "side side";
      row-gap: 8px;
      padding: 8px 12px 10px;
    }
    .music-close {
      position: static; /* keep the stop button visible on every screen */
      width: 34px;
      height: 34px;
    }
    .music-now-meta small {
      display: none;
    }
    .music-transport {
      justify-items: center;
    }
    .music-side {
      display: flex;
      justify-content: center;
    }
    .music-volume {
      display: block;
      max-width: 110px;
    }
  }
  @keyframes musicSpin {
    to { transform: rotate(360deg); }
  }
</style>
