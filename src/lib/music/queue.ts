export type RepeatMode = 'off' | 'all' | 'one';

/**
 * A music queue keeps a permutation of track indices (`order`) plus a `cursor`
 * position into that order. Shuffle rewrites the permutation; repeat only
 * changes how the cursor wraps at the ends. Tracks themselves are never
 * reordered, so `tracks` always holds the original playlist order.
 */
export type MusicQueue<T> = {
  tracks: T[];
  order: number[];
  cursor: number;
  shuffle: boolean;
  repeat: RepeatMode;
};

export function createQueue<T>(tracks: T[], startIndex = 0): MusicQueue<T> {
  const length = tracks.length;
  const start = length === 0 ? -1 : Math.max(0, Math.min(startIndex, length - 1));
  return {
    tracks,
    order: indices(length),
    cursor: start,
    shuffle: false,
    repeat: 'off'
  };
}

export function currentTrack<T>(queue: MusicQueue<T>): T | null {
  if (queue.tracks.length === 0 || queue.cursor < 0) return null;
  const index = queue.order[queue.cursor];
  return queue.tracks[index] ?? null;
}

/** Original (non-shuffled) index of the current track, or -1 when empty. */
export function currentPlaylistIndex<T>(queue: MusicQueue<T>): number {
  if (queue.cursor < 0 || queue.cursor >= queue.order.length) return -1;
  return queue.order[queue.cursor];
}

/** Where the user is in the queue, e.g. "3 of 12". */
export function queuePosition<T>(queue: MusicQueue<T>): number {
  return queue.tracks.length === 0 ? 0 : queue.cursor + 1;
}

export function queueLength<T>(queue: MusicQueue<T>): number {
  return queue.tracks.length;
}

/** Advance the cursor honoring repeat mode. Returns -1 when playback should stop. */
export function nextCursor<T>(queue: MusicQueue<T>): number {
  if (queue.tracks.length === 0) return -1;
  if (queue.cursor < queue.order.length - 1) return queue.cursor + 1;
  return queue.repeat === 'all' ? 0 : -1;
}

/** Step the cursor back honoring repeat mode. Never returns -1 for a non-empty queue. */
export function prevCursor<T>(queue: MusicQueue<T>): number {
  if (queue.tracks.length === 0) return -1;
  if (queue.cursor > 0) return queue.cursor - 1;
  return queue.repeat === 'all' ? queue.order.length - 1 : 0;
}

/** Position in `order` holding the given original playlist index, or -1. */
export function cursorForPlaylistIndex<T>(queue: MusicQueue<T>, playlistIndex: number): number {
  return queue.order.indexOf(playlistIndex);
}

export function cursorForTrackId<T extends { Id: string }>(queue: MusicQueue<T>, trackId: string): number {
  const playlistIndex = queue.tracks.findIndex((track) => track.Id === trackId);
  if (playlistIndex < 0) return -1;
  return cursorForPlaylistIndex(queue, playlistIndex);
}

/**
 * Jump to a track by id. Returns a new queue with the cursor moved to that
 * track, or null when the track is not in the queue.
 */
export function seekToTrackId<T extends { Id: string }>(queue: MusicQueue<T>, trackId: string): MusicQueue<T> | null {
  const cursor = cursorForTrackId(queue, trackId);
  if (cursor < 0) return null;
  return { ...queue, cursor };
}

export function toggleShuffle<T>(queue: MusicQueue<T>): MusicQueue<T> {
  if (queue.tracks.length === 0) return queue;
  const current = currentPlaylistIndex(queue);
  let order: number[];
  let cursor: number;
  if (queue.shuffle) {
    // Restore original playlist order, keeping the current track selected.
    order = indices(queue.tracks.length);
    cursor = current >= 0 ? order.indexOf(current) : 0;
  } else {
    // Shuffle but pin the current track first so playback does not jump.
    const rest = indices(queue.tracks.length).filter((index) => index !== current);
    shuffleInPlace(rest);
    order = current >= 0 ? [current, ...rest] : indices(queue.tracks.length);
    cursor = 0;
  }
  return { ...queue, shuffle: !queue.shuffle, order, cursor };
}

export function setRepeat<T>(queue: MusicQueue<T>, repeat: RepeatMode): MusicQueue<T> {
  return { ...queue, repeat };
}

function indices(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function shuffleInPlace(values: number[]) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}
