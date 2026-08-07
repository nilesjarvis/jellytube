import { writable } from 'svelte/store';
import type { JellyfinItem } from '../types';
import {
  createQueue,
  currentTrack,
  nextCursor,
  prevCursor,
  seekToTrackId,
  setRepeat,
  toggleShuffle,
  type MusicQueue,
  type RepeatMode
} from './queue';

/**
 * Shared state for the music player. The audio element itself lives in
 * MusicPlayer.svelte (mounted persistently by JellyTube), but the queue and
 * transport state live here so any page can start a queue and the persistent
 * now-playing bar reflects it.
 */
export type MusicPlayerState = {
  queue: MusicQueue<JellyfinItem> | null;
  playing: boolean;
  /** Current track id, tracked separately so consumers can react to changes. */
  currentId: string | null;
  /**
   * Playback position of the track that was playing when the player was torn
   * down (e.g. a video was opened, which unmounts the audio element). Stored so
   * the same track can resume from where it left off when the player returns.
   */
  resume: { trackId: string; ticks: number } | null;
};

/**
 * The last played position is persisted separately (and frequently) so a page
 * refresh can restore the queue AND resume the current track where it left off,
 * instead of starting it over. The main queue JSON is only written when the
 * queue itself (or transport mode) actually changes, so we never churn a large
 * blob on every playback tick.
 */
const QUEUE_STORAGE_KEY = 'jellytube.musicQueue.v1';
const POSITION_STORAGE_KEY = 'jellytube.musicPosition.v1';

/**
 * Persist only the fields needed to render/play a track. Full JellyfinItem
 * payloads can be bulky, and a queue of a few hundred tracks would otherwise
 * blow past localStorage's quota and make every write synchronous and slow.
 */
function trimTrack(track: JellyfinItem): JellyfinItem {
  return {
    Id: track.Id,
    Name: track.Name,
    Type: track.Type,
    Album: track.Album,
    AlbumId: track.AlbumId,
    AlbumArtist: track.AlbumArtist,
    AlbumArtists: track.AlbumArtists,
    ArtistItems: track.ArtistItems,
    Artists: track.Artists,
    IndexNumber: track.IndexNumber,
    RunTimeTicks: track.RunTimeTicks,
    ImageTags: track.ImageTags,
    Overview: track.Overview,
    contentKind: track.contentKind,
    sourceLibraryId: track.sourceLibraryId
  };
}

function trimQueue(queue: MusicQueue<JellyfinItem> | null): MusicQueue<JellyfinItem> | null {
  if (!queue) return null;
  return {
    ...queue,
    tracks: queue.tracks.map(trimTrack)
  };
}

type Persisted = {
  queue: MusicQueue<JellyfinItem> | null;
  currentId: string | null;
  resume: { trackId: string; ticks: number } | null;
};

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function loadPersistedPosition(): { trackId: string; ticks: number } | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { trackId: string; ticks: number };
    if (!parsed || typeof parsed.trackId !== 'string' || !Number.isFinite(parsed.ticks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadPersisted(): MusicPlayerState | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !parsed.queue || !Array.isArray(parsed.queue.tracks) || parsed.queue.tracks.length === 0) {
      return null;
    }
    // A restored queue must not autoplay (browsers would block it without a
    // gesture); the user taps play. We do restore the current track + position.
    const position = loadPersistedPosition();
    const currentId = typeof parsed.currentId === 'string' ? parsed.currentId : parsed.queue.tracks[0].Id;
    const resume = position && position.trackId === currentId ? position : null;
    return { queue: parsed.queue, playing: false, currentId, resume };
  } catch {
    return null;
  }
}

function persistQueue(state: MusicPlayerState): void {
  if (!hasStorage()) return;
  try {
    if (!state.queue) {
      localStorage.removeItem(QUEUE_STORAGE_KEY);
      return;
    }
    const saved: Persisted = {
      queue: trimQueue(state.queue),
      currentId: state.currentId,
      resume: state.resume
    };
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Best-effort persistence; never block playback on storage quirks.
  }
}

/** Save (throttled by the caller) where the current track has reached. */
export function persistMusicPosition(trackId: string, ticks: number): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(
      POSITION_STORAGE_KEY,
      JSON.stringify({ trackId, ticks: Math.max(0, Math.floor(ticks)) })
    );
  } catch {
    // ignore
  }
}

function initialState(): MusicPlayerState {
  return (
    loadPersisted() ?? { queue: null, playing: false, currentId: null, resume: null }
  );
}

/** Remember where a track was when the player element is destroyed. */
export function saveMusicResume(trackId: string, ticks: number): void {
  musicPlayerState.update((state) => ({
    ...state,
    resume: { trackId, ticks: Math.max(0, Math.floor(ticks)) }
  }));
}

/** Discard any pending resume position (a fresh play intent). */
export function clearMusicResume(): void {
  musicPlayerState.update((state) => (state.resume ? { ...state, resume: null } : state));
}

export const musicPlayerState = writable<MusicPlayerState>(initialState());

// Persist the queue/transport whenever it changes (position is written
// separately & throttled, so this only fires on real state transitions).
musicPlayerState.subscribe((state) => persistQueue(state));

export function musicCurrentTrack(): JellyfinItem | null {
  let state: MusicPlayerState = initialState();
  musicPlayerState.subscribe((value) => (state = value))();
  return state.queue && state.currentId ? currentTrack(state.queue) : null;
}

/** Remove the persisted queue + position (on an explicit stop or a natural end). */
export function clearPersistedMusic(): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(QUEUE_STORAGE_KEY);
    localStorage.removeItem(POSITION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Start (or replace) a playlist starting at `startIndex`. */
export function playTracks(tracks: JellyfinItem[], startIndex = 0, autoplay = true): void {
  if (!tracks.length) {
    musicPlayerState.set(initialState());
    return;
  }
  const queue = createQueue(tracks, startIndex);
  clearMusicResume();
  musicPlayerState.update((state) => ({
    ...state,
    queue,
    currentId: currentTrack(queue)?.Id ?? null,
    playing: autoplay
  }));
}

export function togglePlayPause(): void {
  musicPlayerState.update((state) => ({ ...state, playing: !state.playing }));
}

export function play(): void {
  musicPlayerState.update((state) => ({ ...state, playing: true }));
}

export function pause(): void {
  musicPlayerState.update((state) => ({ ...state, playing: false }));
}

export function advanceMusic(): void {
  let ended = false;
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const next = nextCursor(state.queue);
    if (next < 0) ended = true;
    const queue = { ...state.queue, cursor: next };
    const current = currentTrack(queue);
    if (!current) return { ...state, queue, currentId: null, playing: false };
    return { ...state, queue, currentId: current.Id, playing: true };
  });
  clearMusicResume();
  // A finished playlist shouldn't come back from the dead on the next refresh.
  if (ended) clearPersistedMusic();
}

export function stepMusicBack(): void {
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const queue = { ...state.queue, cursor: prevCursor(state.queue) };
    const current = currentTrack(queue);
    if (!current) return state;
    return { ...state, queue, currentId: current.Id, playing: true };
  });
  clearMusicResume();
}

export function seekMusicTo(trackId: string): void {
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const queue = seekToTrackId(state.queue, trackId);
    if (!queue) return state;
    return { ...state, queue, currentId: trackId, playing: true };
  });
  clearMusicResume();
}

export function toggleMusicShuffle(): void {
  musicPlayerState.update((state) =>
    state.queue ? { ...state, queue: toggleShuffle(state.queue) } : state
  );
}

export function setMusicRepeat(mode: RepeatMode): void {
  musicPlayerState.update((state) =>
    state.queue ? { ...state, queue: setRepeat(state.queue, mode) } : state
  );
}

/** Stop playback and forget the saved queue so a refresh isn't resurrected. */
export function stopMusic(): void {
  // Use a literal empty state, not initialState(), so we don't re-read the
  // queue we're about to erase from storage.
  musicPlayerState.set({ queue: null, playing: false, currentId: null, resume: null });
  clearPersistedMusic();
}
