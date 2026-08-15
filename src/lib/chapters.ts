import type { JellyfinItem } from './types';

export type WatchChapter = {
  index: number;
  start: number;
  end: number;
  name: string;
};

function ticksToSeconds(ticks?: number) {
  return ticks ? ticks / 10_000_000 : 0;
}

/**
 * Normalizes an item's optional in-file chapters into contiguous, ordered
 * sections for display (a YouTube-style chapter list and seek-bar markers).
 *
 * A single chapter is just the whole video, so chapters are only surfaced when
 * the item defines at least two distinct sections. Missing or invalid chapter
 * ends are derived from the next chapter boundary (or the runtime) so every
 * section is contiguous; over-long ends are clamped, zero-length and
 * out-of-range chapters are dropped.
 */
export function useWatchChapters(item: JellyfinItem, totalSeconds: number): WatchChapter[] {
  const raw = item.Chapters ?? [];
  if (raw.length < 2 || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return [];

  // Drop chapters at or past the runtime first, so an out-of-range chapter
  // can't leave its (dropped) position clamped onto the previous section's end.
  let list = raw
    .map((c, index) => ({
      index,
      start: ticksToSeconds(c.StartPositionTicks),
      end: ticksToSeconds(c.EndPositionTicks),
      name: c.Name?.trim() || `Chapter ${index + 1}`
    }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start < totalSeconds)
    .sort((a, b) => a.start - b.start);

  if (list.length < 2) return [];

  for (let i = 0; i < list.length; i++) {
    const nextStart = i + 1 < list.length ? list[i + 1].start : totalSeconds;
    list[i].end =
      Number.isFinite(list[i].end) && list[i].end > list[i].start
        ? Math.min(list[i].end, nextStart)
        : nextStart;
  }

  // Drop sections that collapsed to zero length (e.g. duplicate timestamps).
  return list.filter((c) => c.end > c.start);
}

/** Index of the chapter active at `timeSeconds` (the last chapter that has started), or -1. */
export function chapterIndexAt(list: WatchChapter[], timeSeconds: number): number {
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (timeSeconds >= list[i].start) idx = i;
  }
  return idx;
}
