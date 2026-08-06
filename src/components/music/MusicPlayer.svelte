<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    ChevronDown,
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
    musicPlayerState,
    pause,
    play,
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
  let muted = false;
  let started = false;
  let reportTimer: number | undefined;
  let destroyed = false;

  $: queue = $state.queue;
  $: current = queue ? currentTrack(queue) : null;
  $: playing = $state.playing;
  $: position = queue ? queuePosition(queue) : 0;
  $: length = queue ? queueLength(queue) : 0;
  $: repeatMode = queue?.repeat ?? 'off';
  $: shuffle = queue?.shuffle ?? false;
  $: currentIndex = queue ? currentPlaylistIndex(queue) : -1;
  $: effectiveVolume = muted ? 0 : volume;

  $: if (audioEl && queue) {
    const ready = loadedId === current?.Id;
    if (ready && playing && audioEl.src && audioEl.paused) void audioEl.play().catch(() => undefined);
    else if (ready && !playing && !audioEl.paused) audioEl.pause();
  }

  $: if (audioEl) audioEl.volume = effectiveVolume;

  $: if (current) void loadIfNeeded(current);
  $: updateMediaSession(current, $state.playing);

  function loadIfNeeded(track: JellyfinItem) {
    if (!track || loadedId === track.Id || !audioEl) return Promise.resolve();
    loadedId = track.Id;
    error = '';
    const expected = track.Id;
    return client
      .getAudioPlaybackInfo(track.Id)
      .then((info: PlaybackInfo) => {
        const stream = musicStreamFor(client, track.Id, info);
        if (loadedId !== expected || destroyed) return;
        if (!stream) {
          error = 'This song cannot be streamed.';
          pause();
          return;
        }
        started = false;
        audioEl.src = stream.src;
        audioEl.currentTime = 0;
        if ($state.playing) void audioEl.play().catch(() => undefined);
      })
      .catch(() => {
        if (loadedId === expected && !destroyed) {
          loadedId = null;
          error = 'Could not load this song.';
          pause();
        }
      });
  }

  function onTimeUpdate() {
    currentSeconds = audioEl.currentTime || 0;
    if (Number.isFinite(audioEl.duration)) durationSeconds = audioEl.duration;
  }

  function onEnded() {
    if (queue?.repeat === 'one') {
      audioEl.currentTime = 0;
      void audioEl.play().catch(() => undefined);
      return;
    }
    void reportStop();
    advanceMusic();
  }

  function onPlay() {
    reportStart();
  }

  function onPause() {
    void reportStop();
  }

  function seekTo(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    audioEl.currentTime = seconds;
    currentSeconds = seconds;
  }

  function toggleMute() {
    muted = !muted;
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
    seekMusicTo(track.Id);
    showQueue = false;
  }

  function onQueueToggle() {
    showQueue = !showQueue;
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
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.Name,
            artist: track.AlbumArtist || track.Artists?.join(', ') || '',
            album: track.Album ?? '',
            artwork: [{ src: client.getImageUrl(track, 320), sizes: '320x320', type: 'image/jpeg' }]
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
    localStorage.setItem('jellytube.musicVolume', String(volume));
  }

  function close() {
    void reportStop();
    stopMusic();
  }

  onDestroy(() => {
    destroyed = true;
    reportStop();
  });
</script>

<audio
  bind:this={audioEl}
  on:timeupdate={onTimeUpdate}
  on:ended={onEnded}
  on:play={onPlay}
  on:pause={onPause}
  preload="metadata"
></audio>

{#if current}
  <div class="music-player" class:expanded={showQueue}>
    <button class="music-now" on:click={togglePlayPause} aria-label={playing ? 'Pause' : 'Play'} title={current.Name}>
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

    <div class="music-transport">
      <div class="music-button-row">
        <button class:active={shuffle} class="music-tbtn" title="Shuffle" aria-label="Shuffle" on:click={cycleShuffle}>
          <Shuffle size={18} />
        </button>
        <button class="music-tbtn" title="Previous" aria-label="Previous track" on:click={() => stepMusicBack()}>
          <SkipBack size={20} fill="currentColor" />
        </button>
        <button class="music-play-toggle" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} on:click={() => togglePlayPause()}>
          {#if playing}
            <Pause size={20} fill="currentColor" />
          {:else}
            <Play size={20} fill="currentColor" />
          {/if}
        </button>
        <button class="music-tbtn" title="Next" aria-label="Next track" on:click={() => advanceMusic()}>
          <SkipForward size={20} fill="currentColor" />
        </button>
        <button class:active={repeatMode !== 'off'} class="music-tbtn" title="Repeat" aria-label="Repeat" on:click={cycleRepeat}>
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
      <span class="music-position">{position} / {length}</span>
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
      <button class:active={showQueue} class="music-tbtn" title="Queue" aria-label="Queue" on:click={onQueueToggle}>
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
          <strong>Up next</strong>
          <button class="text-action" class:active={shuffle} on:click={cycleShuffle}>Shuffle</button>
        </div>
        <div class="music-queue-list">
          {#each queue.tracks as track (track.Id)}
            <MusicSongRow
              song={track}
              active={track.Id === current.Id}
              playingNow={track.Id === current.Id && playing}
              on:select={(event) => selectTrack(event.detail)}
            />
          {/each}
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
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    padding: 10px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 -6px 18px var(--shadow);
  }
  .music-now {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0;
    border: 0;
    color: var(--text);
    text-align: left;
    background: transparent;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    color: var(--bg);
    background: var(--text);
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
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .music-queue-list {
    overflow-y: auto;
    padding: 6px;
  }
  @media (max-width: 900px) {
    .music-player {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) auto;
      gap: 12px;
      padding: 8px 12px;
    }
    .music-volume,
    .music-position {
      display: none;
    }
    .music-close {
      display: none;
    }
  }
  @media (max-width: 640px) {
    .music-player {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .music-now-meta small {
      display: none;
    }
    .music-side {
      display: none;
    }
  }
</style>
