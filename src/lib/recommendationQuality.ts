import {
  channelName,
  hasMeaningfulResume,
  playbackProgress,
  rankRecommendations
} from './recommendations';
import {
  projectRecommendations,
  type ProjectedRecommendation
} from './showRecommendations';
import type { ContentKind, JellyfinItem, PlaybackActivity } from './types';

const DAY_MS = 86_400_000;
const RECENT_DAYS = 3;
const MAX_BACKTEST_EVENTS = 60;

type QualityContentKind = ContentKind | 'other';

type CoverageMetrics = {
  total: number;
  metadata: {
    any: number;
    genres: number;
    creators: number;
    series: number;
    date: number;
    duration: number;
  };
  history: {
    any: number;
    lastPlayed: number;
    completed: number;
    resume: number;
  };
};

type CatalogKindMetrics = CoverageMetrics & {
  legacyTotal: number;
  legacyCoverage: number;
};

type ListInvariantMetrics = {
  size: number;
  itemCards: number;
  showCards: number;
  uniqueItems: number;
  duplicateCount: number;
  hasDuplicates: boolean;
  channels: {
    unique: number;
    maximumCount: number;
    maximumShare: number;
  };
  series: {
    unique: number;
    maximumCount: number;
    maximumShare: number;
  };
  replayExposure: { count: number; rate: number };
  recentExposure: { count: number; rate: number };
  resumeLeakage: { count: number; rate: number; clear: boolean };
  completedLeakage: { count: number; rate: number; clear: boolean };
  reasons: { covered: number; coverage: number; complete: boolean };
  relatedSignals: { covered: number; coverage: number };
};

type BacktestFullMetrics = {
  targetPresent: number;
  targetAbsent: number;
  rankingMissAt12: number;
  rankingMissAt28: number;
  hitRateAt12: number;
  hitRateAt28: number;
  mrrAt28: number;
};

type BacktestLegacyMetrics = BacktestFullMetrics & {
  hitRateWhenPresentAt12: number;
  hitRateWhenPresentAt28: number;
  mrrWhenPresentAt28: number;
};

type BacktestSlice = {
  events: number;
  full: BacktestFullMetrics;
  legacy: BacktestLegacyMetrics;
};

type BacktestMetrics = BacktestSlice & {
  signalMode: 'local-only';
  byContentKind: Record<QualityContentKind, BacktestSlice>;
};

export type RecommendationQualityReport = {
  method: 'latest-play-proxy';
  catalog: {
    total: number;
    legacyTotal: number;
    legacyCoverage: number;
    byContentKind: Record<QualityContentKind, CatalogKindMetrics>;
    metadataCoverage: CoverageMetrics['metadata'];
    historyCoverage: CoverageMetrics['history'];
  };
  lists: {
    presentation: 'home-projected';
    top12: ListInvariantMetrics;
    top28: ListInvariantMetrics;
  };
  backtest: BacktestMetrics;
};

export type RecommendationQualityInput = {
  catalog: JellyfinItem[];
  legacyCatalog?: JellyfinItem[];
  seriesItems?: JellyfinItem[];
  activity?: PlaybackActivity[];
  relatedItemScores?: ReadonlyMap<string, number>;
  now?: number;
  seed?: string | number;
};

/**
 * Produces aggregate, deterministic diagnostics. The temporal evaluation is only a
 * latest-play proxy: Jellyfin exposes current aggregate UserData, not a complete
 * sequence of historical plays.
 */
export function recommendationQualityReport({
  catalog,
  legacyCatalog,
  seriesItems = [],
  activity = [],
  relatedItemScores,
  now = Date.now(),
  seed = 0
}: RecommendationQualityInput): RecommendationQualityReport {
  const currentCatalog = catalog.filter(
    (item) => !isCreatedAfter(item, now) && contentKind(item) !== 'movie'
  );
  const ranked = rankRecommendations(currentCatalog, {
    activity,
    mode: 'home',
    now,
    randomSeed: seed,
    relatedItemScores
  });
  const projected = projectRecommendations(ranked, catalog, seriesItems);
  const allCoverage = coverageMetrics(catalog);
  const comparedLegacyCatalog = legacyCatalog ?? catalog;
  const legacyIds = new Set(comparedLegacyCatalog.map((item) => item.Id));
  const legacyTotal = catalog.reduce((sum, item) => sum + Number(legacyIds.has(item.Id)), 0);

  return {
    method: 'latest-play-proxy',
    catalog: {
      total: catalog.length,
      legacyTotal,
      legacyCoverage: ratio(legacyTotal, catalog.length),
      byContentKind: {
        video: catalogKindMetrics(catalog, legacyIds, 'video'),
        movie: catalogKindMetrics(catalog, legacyIds, 'movie'),
        musicVideo: catalogKindMetrics(catalog, legacyIds, 'musicVideo'),
        other: catalogKindMetrics(catalog, legacyIds, 'other')
      },
      metadataCoverage: allCoverage.metadata,
      historyCoverage: allCoverage.history
    },
    lists: {
      presentation: 'home-projected',
      top12: listMetrics(projected, 12, now, relatedItemScores),
      top28: listMetrics(projected, 28, now, relatedItemScores)
    },
    backtest: temporalBacktest(catalog, comparedLegacyCatalog, activity, now, seed)
  };
}

function catalogKindMetrics(
  catalog: JellyfinItem[],
  legacyIds: ReadonlySet<string>,
  kind: QualityContentKind
): CatalogKindMetrics {
  const items = catalog.filter((item) => contentKind(item) === kind);
  const legacyTotal = items.reduce((sum, item) => sum + Number(legacyIds.has(item.Id)), 0);
  return {
    ...coverageMetrics(items),
    legacyTotal,
    legacyCoverage: ratio(legacyTotal, items.length)
  };
}

function coverageMetrics(items: JellyfinItem[]): CoverageMetrics {
  const total = items.length;
  const count = (predicate: (item: JellyfinItem) => boolean) =>
    ratio(items.reduce((sum, item) => sum + Number(predicate(item)), 0), total);

  return {
    total,
    metadata: {
      any: count(hasRecommendationMetadata),
      genres: count((item) => Boolean(item.Genres?.length || item.Tags?.length)),
      creators: count((item) =>
        Boolean(item.Artists?.length || item.ArtistItems?.length || item.Studios?.length)
      ),
      series: count((item) => Boolean(item.SeriesId || item.SeriesName)),
      date: count((item) => Boolean(validDate(item.PremiereDate) || validDate(item.DateCreated))),
      duration: count((item) => Boolean(item.RunTimeTicks && item.RunTimeTicks > 0))
    },
    history: {
      any: count(hasHistory),
      lastPlayed: count((item) => Boolean(validDate(item.UserData?.LastPlayedDate))),
      completed: count(isCompleted),
      resume: count(hasMeaningfulResume)
    }
  };
}

function hasRecommendationMetadata(item: JellyfinItem) {
  return Boolean(
    item.Genres?.length ||
      item.Tags?.length ||
      item.Artists?.length ||
      item.ArtistItems?.length ||
      item.Studios?.length ||
      item.SeriesId ||
      item.SeriesName ||
      validDate(item.PremiereDate) ||
      validDate(item.DateCreated) ||
      (item.RunTimeTicks ?? 0) > 0
  );
}

function hasHistory(item: JellyfinItem) {
  const data = item.UserData;
  return Boolean(
    data &&
      ((data.PlayCount ?? 0) > 0 ||
        (data.PlaybackPositionTicks ?? 0) > 0 ||
        data.Played ||
        validDate(data.LastPlayedDate))
  );
}

function listMetrics(
  recommendations: ProjectedRecommendation[],
  limit: 12 | 28,
  now: number,
  relatedItemScores?: ReadonlyMap<string, number>
): ListInvariantMetrics {
  const entries = recommendations.slice(0, limit).map((recommendation) =>
    recommendation.kind === 'item'
      ? {
          key: `item:${recommendation.item.Id}`,
          item: recommendation.item,
          reason: recommendation.item.reason,
          show: false
        }
      : {
          key: `show:${recommendation.seriesKey}`,
          item: recommendation.representative,
          reason: recommendation.reason,
          show: true
        }
  );
  const items = entries.map((entry) => entry.item);
  const uniqueItems = new Set(entries.map((entry) => entry.key)).size;
  const showCards = entries.reduce((sum, entry) => sum + Number(entry.show), 0);
  const channels = concentration(items.map((item) => channelName(item).toLowerCase()));
  const series = concentration(
    items
      .map((item) => item.SeriesId || item.SeriesName?.trim().toLowerCase() || '')
      .filter(Boolean)
  );
  const replayCount = items.reduce(
    (sum, item) => sum + Number(isCompleted(item) && isReplayable(item)),
    0
  );
  const recentCount = items.reduce((sum, item) => sum + Number(isRecent(item, now)), 0);
  const resumeCount = items.reduce((sum, item) => sum + Number(hasMeaningfulResume(item)), 0);
  const completedCount = items.reduce(
    (sum, item) => sum + Number(isCompleted(item) && !isReplayable(item)),
    0
  );
  const reasonCount = entries.reduce((sum, entry) => sum + Number(Boolean(entry.reason?.trim())), 0);
  const relatedSignalCount = items.reduce(
    (sum, item) => sum + Number((relatedItemScores?.get(item.Id) ?? 0) > 0),
    0
  );

  return {
    size: entries.length,
    itemCards: entries.length - showCards,
    showCards,
    uniqueItems,
    duplicateCount: entries.length - uniqueItems,
    hasDuplicates: uniqueItems !== entries.length,
    channels,
    series,
    replayExposure: {
      count: replayCount,
      rate: ratio(replayCount, entries.length)
    },
    recentExposure: {
      count: recentCount,
      rate: ratio(recentCount, entries.length)
    },
    resumeLeakage: {
      count: resumeCount,
      rate: ratio(resumeCount, entries.length),
      clear: resumeCount === 0
    },
    completedLeakage: {
      count: completedCount,
      rate: ratio(completedCount, entries.length),
      clear: completedCount === 0
    },
    reasons: {
      covered: reasonCount,
      coverage: ratio(reasonCount, entries.length),
      complete: reasonCount === entries.length
    },
    relatedSignals: {
      covered: relatedSignalCount,
      coverage: ratio(relatedSignalCount, entries.length)
    }
  };
}

function concentration(keys: string[]) {
  const counts = new Map<string, number>();
  let maximumCount = 0;
  for (const key of keys) {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    maximumCount = Math.max(maximumCount, next);
  }
  return {
    unique: counts.size,
    maximumCount,
    maximumShare: ratio(maximumCount, keys.length)
  };
}

function temporalBacktest(
  catalog: JellyfinItem[],
  legacyCatalog: JellyfinItem[],
  activity: PlaybackActivity[],
  now: number,
  seed: string | number
): BacktestMetrics {
  const events = catalog
    .map((item) => ({ item, playedAt: validDate(item.UserData?.LastPlayedDate) }))
    .filter(
      (event): event is { item: JellyfinItem; playedAt: number } =>
        event.playedAt !== undefined &&
        event.playedAt <= now &&
        !isCreatedAfter(event.item, event.playedAt)
    )
    .sort((a, b) => b.playedAt - a.playedAt || a.item.Id.localeCompare(b.item.Id))
    .slice(0, MAX_BACKTEST_EVENTS);

  const fullResults: EvaluationResult[] = [];
  const legacyResults: EvaluationResult[] = [];
  const resultsByKind: Record<
    QualityContentKind,
    { full: EvaluationResult[]; legacy: EvaluationResult[] }
  > = {
    video: { full: [], legacy: [] },
    movie: { full: [], legacy: [] },
    musicVideo: { full: [], legacy: [] },
    other: { full: [], legacy: [] }
  };

  for (const [eventIndex, event] of events.entries()) {
    const historicalActivity = activity.filter((row) => {
      const activityDate = validDate(row.latest_date);
      return activityDate !== undefined && activityDate < event.playedAt;
    });
    const eventSeed = `${seed}:event:${eventIndex}`;
    const fullResult = evaluateTarget(catalog, event.item.Id, event.playedAt, historicalActivity, eventSeed);
    const legacyResult = evaluateTarget(
      legacyCatalog,
      event.item.Id,
      event.playedAt,
      historicalActivity,
      eventSeed
    );
    fullResults.push(fullResult);
    legacyResults.push(legacyResult);
    const kindResults = resultsByKind[contentKind(event.item)];
    kindResults.full.push(fullResult);
    kindResults.legacy.push(legacyResult);
  }

  return {
    signalMode: 'local-only',
    ...summarizeBacktest(fullResults, legacyResults),
    byContentKind: {
      video: summarizeBacktest(resultsByKind.video.full, resultsByKind.video.legacy),
      movie: summarizeBacktest(resultsByKind.movie.full, resultsByKind.movie.legacy),
      musicVideo: summarizeBacktest(resultsByKind.musicVideo.full, resultsByKind.musicVideo.legacy),
      other: summarizeBacktest(resultsByKind.other.full, resultsByKind.other.legacy)
    }
  };
}

function summarizeBacktest(
  fullResults: EvaluationResult[],
  legacyResults: EvaluationResult[]
): BacktestSlice {
  return {
    events: fullResults.length,
    full: summarizeFull(fullResults),
    legacy: summarizeLegacy(legacyResults)
  };
}

function evaluateTarget(
  source: JellyfinItem[],
  targetId: string,
  cutoff: number,
  activity: PlaybackActivity[],
  seed: string
): EvaluationResult {
  const target = source.find((item) => item.Id === targetId);
  if (!target) return { targetPresent: false, rank: 0 };
  const targetKind = contentKind(target);
  let targetPresent = false;
  const snapshot: JellyfinItem[] = [];

  for (const item of source) {
    const itemKind = contentKind(item);
    if (targetKind === 'movie' && itemKind !== 'movie') continue;
    if (targetKind === 'musicVideo' && itemKind !== 'musicVideo') continue;
    if (targetKind === 'video' && itemKind === 'movie') continue;
    if (isCreatedAfter(item, cutoff)) continue;
    const isTarget = item.Id === targetId;
    if (isTarget) targetPresent = true;
    const playedAt = validDate(item.UserData?.LastPlayedDate);
    snapshot.push(isTarget || (playedAt !== undefined && playedAt >= cutoff) ? withoutUserData(item) : item);
  }
  const mode = targetKind === 'movie' ? 'movie' : targetKind === 'musicVideo' ? 'music' : 'home';
  const ranked = rankRecommendations(snapshot, {
    activity,
    mode,
    now: cutoff,
    randomSeed: seed
  });
  const rank = ranked.findIndex((item) => item.Id === targetId);
  return { targetPresent: true, rank: rank < 0 ? 0 : rank + 1 };
}

type EvaluationResult = { targetPresent: boolean; rank: number };

function summarizeFull(results: EvaluationResult[]): BacktestMetrics['full'] {
  const targetPresent = results.reduce((sum, result) => sum + Number(result.targetPresent), 0);
  return {
    targetPresent,
    targetAbsent: results.length - targetPresent,
    rankingMissAt12: results.reduce(
      (sum, result) => sum + Number(result.targetPresent && !isHit(result, 12)),
      0
    ),
    rankingMissAt28: results.reduce(
      (sum, result) => sum + Number(result.targetPresent && !isHit(result, 28)),
      0
    ),
    hitRateAt12: hitRate(results, 12),
    hitRateAt28: hitRate(results, 28),
    mrrAt28: reciprocalRank(results, results.length)
  };
}

function summarizeLegacy(results: EvaluationResult[]): BacktestMetrics['legacy'] {
  const targetPresent = results.reduce((sum, result) => sum + Number(result.targetPresent), 0);
  return {
    targetPresent,
    targetAbsent: results.length - targetPresent,
    rankingMissAt12: results.reduce(
      (sum, result) => sum + Number(result.targetPresent && !isHit(result, 12)),
      0
    ),
    rankingMissAt28: results.reduce(
      (sum, result) => sum + Number(result.targetPresent && !isHit(result, 28)),
      0
    ),
    hitRateAt12: hitRate(results, 12),
    hitRateAt28: hitRate(results, 28),
    hitRateWhenPresentAt12: hitRate(results, 12, targetPresent),
    hitRateWhenPresentAt28: hitRate(results, 28, targetPresent),
    mrrAt28: reciprocalRank(results, results.length),
    mrrWhenPresentAt28: reciprocalRank(results, targetPresent)
  };
}

function hitRate(results: EvaluationResult[], limit: 12 | 28, denominator = results.length) {
  const hits = results.reduce((sum, result) => sum + Number(isHit(result, limit)), 0);
  return ratio(hits, denominator);
}

function reciprocalRank(results: EvaluationResult[], denominator: number) {
  const reciprocalRanks = results.reduce(
    (sum, result) => sum + (result.rank > 0 && result.rank <= 28 ? 1 / result.rank : 0),
    0
  );
  return ratio(reciprocalRanks, denominator);
}

function isHit(result: EvaluationResult, limit: 12 | 28) {
  return result.targetPresent && result.rank > 0 && result.rank <= limit;
}

function withoutUserData(item: JellyfinItem): JellyfinItem {
  const clone = { ...item };
  delete clone.UserData;
  return clone;
}

function contentKind(item: JellyfinItem): QualityContentKind {
  if (item.contentKind) return item.contentKind;
  if (item.Type === 'Movie') return 'movie';
  if (item.Type === 'MusicVideo') return 'musicVideo';
  if (item.Type === 'Video' || item.Type === 'Episode') return 'video';
  return 'other';
}


function isRecent(item: JellyfinItem, now: number) {
  const playedAt = validDate(item.UserData?.LastPlayedDate);
  return playedAt !== undefined && playedAt <= now && now - playedAt <= RECENT_DAYS * DAY_MS;
}

function isCompleted(item: JellyfinItem) {
  return Boolean(item.UserData?.Played || playbackProgress(item) >= 95);
}

function isReplayable(item: JellyfinItem) {
  return item.contentKind === 'musicVideo' || item.Type === 'MusicVideo';
}

function isCreatedAfter(item: JellyfinItem, cutoff: number) {
  const createdAt = validDate(item.DateCreated);
  return createdAt !== undefined && createdAt > cutoff;
}

function validDate(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
