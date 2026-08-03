import type { JellyfinChapter, JellyfinItem, JellyfinMediaSegment } from './types';

const INTRO_CHAPTER_PATTERN = /^intro$/i;
const INTRO_SEGMENT_TYPE = 'Intro';
const SKIP_GRACE_SECONDS = 2;

export type IntroWindow = {
  start: number;
  end: number;
};

/** Finds the chapter that marks the opening sequence, if any. */
export function introChapter(item: JellyfinItem): JellyfinChapter | null {
  const chapter = item.Chapters?.find(
    (candidate) => INTRO_CHAPTER_PATTERN.test(candidate.Name?.trim() ?? '')
  );
  return chapter ?? null;
}

/**
 * Converts the media segments response (Intro Skipper exposes its detections
 * through Jellyfin's MediaSegments API) into a window. Segment times are
 * ticks; only the "Intro" segment type is relevant here.
 */
export function introWindowFromSegments(
  segments: JellyfinMediaSegment[] | null | undefined
): IntroWindow | null {
  const intro = segments?.find((segment) => segment.Type === INTRO_SEGMENT_TYPE);
  if (!intro) return null;
  const start = ticksToSeconds(intro.StartTicks);
  const end = ticksToSeconds(intro.EndTicks);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** Converts an item's Intro chapter into a [start, end] window in seconds, or null. */
export function introWindowForItem(item: JellyfinItem): IntroWindow | null {
  const chapter = introChapter(item);
  if (!chapter) return null;
  const start = ticksToSeconds(chapter.StartPositionTicks);
  const end = ticksToSeconds(chapter.EndPositionTicks) || ticksToSeconds(item.RunTimeTicks);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Resolves the effective intro window for playback: the server's detected
 * media segment first, falling back to embedded "Intro" chapters in the file.
 */
export function introWindowForPlayback(
  segments: JellyfinMediaSegment[] | null | undefined,
  item: JellyfinItem
): IntroWindow | null {
  return introWindowFromSegments(segments) ?? introWindowForItem(item);
}

/**
 * Whether the skip button should be visible for a playback position.
 * Hidden while dismissed, before the intro starts, and inside the last
 * grace seconds so it disappears just before the show resumes.
 */
export function shouldShowSkipIntro(
  currentSeconds: number,
  intro: IntroWindow | null,
  dismissed: boolean
): boolean {
  if (!intro || dismissed) return false;
  if (currentSeconds < intro.start) return false;
  return currentSeconds < intro.end - SKIP_GRACE_SECONDS;
}

function ticksToSeconds(ticks?: number): number {
  return typeof ticks === 'number' && Number.isFinite(ticks) ? ticks / 10_000_000 : NaN;
}
