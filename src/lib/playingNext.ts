import type { JellyfinItem } from './types';

export const PLAYING_NEXT_COUNTDOWN_SECONDS = 30;
export const PLAYING_NEXT_SKIP_END_SECONDS = 10;

export function episodePlayingNextItem(
  currentItem: JellyfinItem,
  orderedEpisodes: JellyfinItem[]
): JellyfinItem | null {
  const currentIndex = orderedEpisodes.findIndex((episode) => episode.Id === currentItem.Id);
  if (currentIndex < 0 || currentIndex >= orderedEpisodes.length - 1) return null;
  return orderedEpisodes[currentIndex + 1] ?? null;
}

export function countdownSecondsRemaining(currentTime: number, duration: number) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.ceil(duration - currentTime - PLAYING_NEXT_SKIP_END_SECONDS));
}

export function shouldShowPlayingNext({
  currentTime,
  duration,
  nextItem,
  autoplayNext
}: {
  currentTime: number;
  duration: number;
  nextItem: JellyfinItem | null | undefined;
  autoplayNext: boolean;
}) {
  if (!autoplayNext || !nextItem || !Number.isFinite(duration) || duration <= 0) return false;
  const countdown = countdownSecondsRemaining(currentTime, duration);
  return countdown > 0 && countdown <= PLAYING_NEXT_COUNTDOWN_SECONDS;
}

export function shouldAdvancePlayingNext({
  currentTime,
  duration,
  nextItem,
  autoplayNext
}: {
  currentTime: number;
  duration: number;
  nextItem: JellyfinItem | null | undefined;
  autoplayNext: boolean;
}) {
  if (!autoplayNext || !nextItem || !Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  const remaining = duration - currentTime;
  return remaining > 0 && remaining <= PLAYING_NEXT_SKIP_END_SECONDS;
}
