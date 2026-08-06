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
};

function initialState(): MusicPlayerState {
  return { queue: null, playing: false, currentId: null };
}

export const musicPlayerState = writable<MusicPlayerState>(initialState());

export function musicCurrentTrack(): JellyfinItem | null {
  let state: MusicPlayerState = initialState();
  musicPlayerState.subscribe((value) => (state = value))();
  return state.queue && state.currentId ? currentTrack(state.queue) : null;
}

/** Start (or replace) a playlist starting at `startIndex`. */
export function playTracks(tracks: JellyfinItem[], startIndex = 0, autoplay = true): void {
  if (!tracks.length) {
    musicPlayerState.set(initialState());
    return;
  }
  const queue = createQueue(tracks, startIndex);
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
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const next = nextCursor(state.queue);
    const queue = { ...state.queue, cursor: next };
    const current = currentTrack(queue);
    if (!current) return { ...state, queue, currentId: null, playing: false };
    return { ...state, queue, currentId: current.Id, playing: true };
  });
}

export function stepMusicBack(): void {
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const queue = { ...state.queue, cursor: prevCursor(state.queue) };
    const current = currentTrack(queue);
    if (!current) return state;
    return { ...state, queue, currentId: current.Id, playing: true };
  });
}

export function seekMusicTo(trackId: string): void {
  musicPlayerState.update((state) => {
    if (!state.queue) return state;
    const queue = seekToTrackId(state.queue, trackId);
    if (!queue) return state;
    return { ...state, queue, currentId: trackId, playing: true };
  });
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

export function stopMusic(): void {
  musicPlayerState.set(initialState());
}
