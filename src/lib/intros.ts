import type { JellyfinItem, JellyfinMediaSegment } from './types';

const INTRO_CHAPTER_PATTERN = /^intro$/i;
const INTRO_SEGMENT_TYPE = 'Intro';
const SKIP_GRACE_SECONDS = 2;

export type IntroWindow = {
  start: number;
  end: number;
};

/**
 * Converts the media segments response (Intro Skipper exposes its detections
 * through Jellyfin's MediaSegments API) into a window. Segment times are
 * ticks; only the "Intro" segment type is relevant here.
 */
export function introWindowFromSegments(
  segments: JellyfinMediaSegment[] | null | undefined
): IntroWindow | null {
  const intro = Array.isArray(segments)
    ? segments.find((segment) => segment.Type === INTRO_SEGMENT_TYPE)
    : null;
  if (!intro) return null;
  const start = ticksToSeconds(intro.StartTicks);
  const end = ticksToSeconds(intro.EndTicks);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Converts an item's Intro chapter into a [start, end] window in seconds, or
 * null. Jellyfin chapters carry only a start position, so the intro end is
 * inferred from the next chapter's start, falling back to the episode
 * runtime when the Intro chapter is the last one. An explicit end position
 * (if a server ever provides one) takes precedence.
 */
export function introWindowForItem(item: JellyfinItem): IntroWindow | null {
  const chapters = item.Chapters ?? [];
  const index = chapters.findIndex((candidate) =>
    INTRO_CHAPTER_PATTERN.test(candidate.Name?.trim() ?? '')
  );
  if (index === -1) return null;
  const chapter = chapters[index];
  const start = ticksToSeconds(chapter.StartPositionTicks);
  const explicitEnd = ticksToSeconds(chapter.EndPositionTicks);
  const nextStart = ticksToSeconds(chapters[index + 1]?.StartPositionTicks);
  const end =
    (Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : NaN) ||
    (Number.isFinite(nextStart) && nextStart > start ? nextStart : NaN) ||
    ticksToSeconds(item.RunTimeTicks);
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
