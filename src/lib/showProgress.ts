import { compareEpisodes, episodeCode, episodeInfo } from './episodes';
import { dateValue } from './dates';
import { playbackProgress } from './recommendations';
import type { JellyfinItem } from './types';

export type ShowPlaybackKind = 'resume' | 'next' | 'start' | 'replay';

export type ShowProgress = {
  primaryItem: JellyfinItem | null;
  kind: ShowPlaybackKind;
  watchedCount: number;
  totalCount: number;
  progressPercent: number;
  label: string;
};

export function showProgressForEpisodes(episodes: JellyfinItem[]): ShowProgress {
  const ordered = episodes.filter((item) => episodeInfo(item)).sort(compareEpisodes);
  const totalCount = ordered.length;
  if (!totalCount) {
    return {
      primaryItem: null,
      kind: 'start',
      watchedCount: 0,
      totalCount: 0,
      progressPercent: 0,
      label: 'No episodes'
    };
  }

  const watchedCount = ordered.filter(isEpisodeWatched).length;
  const inProgress = ordered
    .filter((item) => isEpisodeInProgress(item))
    .sort((a, b) => dateValue(b.UserData?.LastPlayedDate) - dateValue(a.UserData?.LastPlayedDate))[0];

  const latestWatchedIndex = ordered.reduce(
    (latest, item, index) => (isEpisodeWatched(item) ? index : latest),
    -1
  );
  const nextAfterWatched = ordered.slice(latestWatchedIndex + 1).find((item) => !isEpisodeWatched(item));
  const firstUnwatched = ordered.find((item) => !isEpisodeWatched(item));
  const primaryItem = inProgress ?? nextAfterWatched ?? firstUnwatched ?? ordered[0];
  const kind: ShowPlaybackKind = inProgress
    ? 'resume'
    : firstUnwatched
      ? latestWatchedIndex >= 0
        ? 'next'
        : 'start'
      : 'replay';

  return {
    primaryItem,
    kind,
    watchedCount,
    totalCount,
    progressPercent: Math.round((watchedCount / totalCount) * 100),
    label: showProgressLabel(kind, primaryItem)
  };
}

export function isEpisodeWatched(item: JellyfinItem) {
  return Boolean(item.UserData?.Played || playbackProgress(item) >= 95);
}

export function isEpisodeInProgress(item: JellyfinItem) {
  const progress = playbackProgress(item);
  return progress > 0 && progress < 95 && !item.UserData?.Played;
}

function showProgressLabel(kind: ShowPlaybackKind, item: JellyfinItem | null) {
  const code = item ? episodeCode(item) : '';
  if (kind === 'resume') return code ? `Resume ${code}` : 'Resume episode';
  if (kind === 'next') return code ? `Next ${code}` : 'Next episode';
  if (kind === 'replay') return code ? `Replay ${code}` : 'Replay show';
  return code ? `Start ${code}` : 'Start show';
}
