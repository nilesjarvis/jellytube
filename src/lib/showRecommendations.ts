import { compareEpisodes, episodeInfo, hasLeadingEpisodeCode } from './episodes';
import type { RankedItem } from './recommendations';
import { dateValue } from './dates';
import {
  isEpisodeInProgress,
  isEpisodeWatched,
  showProgressForEpisodes,
  type ShowProgress
} from './showProgress';
import type { JellyfinItem } from './types';

export type ShowRecommendation = {
  kind: 'show';
  seriesKey: string;
  seriesItem: JellyfinItem | null;
  episodes: JellyfinItem[];
  progress: ShowProgress;
  representative: RankedItem;
  reason: string | undefined;
  title: string;
};

export type ProjectedRecommendation =
  | { kind: 'item'; item: RankedItem }
  | ShowRecommendation;

export function isOrderedEpisodicSeries(
  episodes: readonly JellyfinItem[],
  seriesItem?: JellyfinItem | null
) {
  if (episodes.length < 2 || episodes.some((item) => item.Type !== 'Episode')) return false;

  const identityCounts = new Map<string, number>();
  let indexedCount = 0;
  let leadingCodeCount = 0;
  let duplicateSlotCount = 0;
  const indexedSlots = new Set<string>();

  for (const episode of episodes) {
    const seriesId = episode.SeriesId?.trim();
    const seriesName = episode.SeriesName?.trim();
    if (seriesId && seriesName) {
      const identity = `${seriesId}\u0000${seriesName}`;
      identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
    }

    const season = episode.ParentIndexNumber;
    const index = episode.IndexNumber;
    if (
      typeof season === 'number' &&
      Number.isFinite(season) &&
      season > 0 &&
      typeof index === 'number' &&
      Number.isFinite(index) &&
      index > 0
    ) {
      indexedCount += 1;
    }

    if (hasLeadingEpisodeCode(episode)) leadingCodeCount += 1;

    const info = episodeInfo(episode);
    if (
      info &&
      Number.isFinite(info.season) &&
      info.season > 0 &&
      Number.isFinite(info.episode) &&
      info.episode > 0
    ) {
      const slot = `${info.season}:${info.episode}`;
      if (indexedSlots.has(slot)) duplicateSlotCount += 1;
      else indexedSlots.add(slot);
    }
  }

  let consistentIdentityCount = 0;
  for (const count of identityCounts.values()) {
    if (count > consistentIdentityCount) consistentIdentityCount = count;
  }
  let hasStandardProviderId = false;
  const providerIds = seriesItem?.ProviderIds;
  if (providerIds) {
    for (const provider in providerIds) {
      const normalizedProvider = provider.toLowerCase();
      const id = providerIds[provider];
      if (
        (normalizedProvider === 'tvdb' ||
          normalizedProvider === 'tmdb' ||
          normalizedProvider === 'imdb') &&
        typeof id === 'string' &&
        id.trim().length > 0
      ) {
        hasStandardProviderId = true;
        break;
      }
    }
  }
  if (consistentIdentityCount / episodes.length < 0.8) return false;
  if (indexedCount / episodes.length < 0.8) return false;
  if (
    leadingCodeCount / episodes.length < 0.5 &&
    !hasStandardProviderId
  ) {
    return false;
  }
  if (duplicateSlotCount / episodes.length > 0.15) return false;

  const expectedCount = seriesItem?.RecursiveItemCount;
  if (
    typeof expectedCount === 'number' &&
    Number.isFinite(expectedCount) &&
    expectedCount > 0 &&
    episodes.length < expectedCount
  ) {
    return false;
  }

  return true;
}

export function projectRecommendations(
  ranked: readonly RankedItem[],
  catalog: readonly JellyfinItem[],
  seriesItems: readonly JellyfinItem[]
): ProjectedRecommendation[] {
  const seriesById = new Map<string, JellyfinItem>();
  for (const seriesItem of seriesItems) {
    const id = seriesItem.Id.trim();
    if (id) seriesById.set(id, seriesItem);
  }

  const episodesBySeriesId = new Map<string, JellyfinItem[]>();
  for (const item of catalog) {
    const seriesId = item.SeriesId?.trim();
    if (item.Type !== 'Episode' || !seriesId) continue;
    const episodes = episodesBySeriesId.get(seriesId);
    if (episodes) episodes.push(item);
    else episodesBySeriesId.set(seriesId, [item]);
  }

  const orderedSeries = new Map<string, JellyfinItem[]>();
  for (const [seriesId, episodes] of episodesBySeriesId) {
    if (!isOrderedEpisodicSeries(episodes, seriesById.get(seriesId))) continue;
    const episodeBySlot = new Map<string, JellyfinItem>();
    for (const episode of episodes) {
      const info = episodeInfo(episode);
      if (
        !info ||
        !Number.isFinite(info.season) ||
        info.season <= 0 ||
        !Number.isFinite(info.episode) ||
        info.episode <= 0
      ) {
        continue;
      }

      const slot = `${info.season}:${info.episode}`;
      const current = episodeBySlot.get(slot);
      if (!current) {
        episodeBySlot.set(slot, episode);
        continue;
      }

      const currentHistory = duplicateEpisodeHistoryRank(current);
      const candidateHistory = duplicateEpisodeHistoryRank(episode);
      const lastPlayedDifference =
        dateValue(episode.UserData?.LastPlayedDate) - dateValue(current.UserData?.LastPlayedDate);
      if (
        candidateHistory > currentHistory ||
        (candidateHistory === currentHistory &&
          (lastPlayedDifference > 0 ||
            (lastPlayedDifference === 0 && compareEpisodes(episode, current) < 0)))
      ) {
        episodeBySlot.set(slot, episode);
      }
    }
    const playableEpisodes = [...episodeBySlot.values()].sort(compareEpisodes);
    if (playableEpisodes.length) orderedSeries.set(seriesId, playableEpisodes);
  }

  const projected: ProjectedRecommendation[] = [];
  const emittedSeries = new Set<string>();
  for (const representative of ranked) {
    const seriesId = representative.SeriesId?.trim();
    const episodes =
      representative.Type === 'Episode' && seriesId ? orderedSeries.get(seriesId) : undefined;
    if (!seriesId || !episodes) {
      projected.push({ kind: 'item', item: representative });
      continue;
    }
    if (emittedSeries.has(seriesId)) continue;

    const progress = showProgressForEpisodes(episodes);
    if (!progress.primaryItem) {
      projected.push({ kind: 'item', item: representative });
      continue;
    }

    emittedSeries.add(seriesId);
    const seriesItem = seriesById.get(seriesId) ?? null;
    projected.push({
      kind: 'show',
      seriesKey: seriesId,
      seriesItem,
      episodes,
      progress,
      representative,
      reason: representative.reason,
      title: seriesItem?.Name || representative.SeriesName || episodeInfo(representative)?.seriesName || representative.Name
    });
  }

  return projected;
}

function duplicateEpisodeHistoryRank(item: JellyfinItem) {
  if (isEpisodeWatched(item)) return 3;
  if (isEpisodeInProgress(item)) return 2;
  if (
    (item.UserData?.PlayCount ?? 0) > 0 ||
    item.UserData?.LastPlayedDate ||
    (item.UserData?.PlayedPercentage ?? 0) > 0
  ) {
    return 1;
  }
  return 0;
}
