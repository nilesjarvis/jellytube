import type { JellyfinItem, PlaybackActivity } from './types';
import { episodeCode, episodeInfo, episodeTitle, sameEpisodeSeries } from './episodes';
import { contentDate, contentDateValue, dateValue, relativeDate } from './dates';

export type RankedItem = JellyfinItem & {
  score?: number;
  reason?: string;
  reasons?: string[];
};

export type DisplayTitleOptions = {
  context?: 'feed' | 'series' | 'channel' | 'recommendation';
  channel?: string;
};

export type RecommendationMode = 'home' | 'watch' | 'movie' | 'music' | 'replay';

export type RecommendationOptions = {
  activity?: PlaybackActivity[];
  currentItem?: JellyfinItem | null;
  mode?: RecommendationMode;
  recentItemIds?: Iterable<string>;
  queueItems?: JellyfinItem[];
  relatedItemScores?: ReadonlyMap<string, number>;
  now?: number;
  recentlyWatchedDays?: number;
  maxPerChannel?: number;
  maxPerSeries?: number;
  randomness?: number;
  randomSeed?: string | number;
};
type ResolvedRecommendationOptions = Required<
  Pick<RecommendationOptions, 'activity' | 'mode' | 'now' | 'recentlyWatchedDays' | 'randomness'>
> &
  Omit<RecommendationOptions, 'activity' | 'mode' | 'now' | 'recentlyWatchedDays' | 'randomness'> & {
    recentItemIds: Set<string>;
    queueItemIds: Set<string>;
  };

const SHORT_FORM_RESUME_TICKS = 8 * 60 * 10_000_000;
const RECENTLY_WATCHED_DAYS = 3;

export function dailyRecommendationSeed(
  userId: string,
  mode: RecommendationMode,
  now: number = Date.now()
) {
  return `${userId}:${mode}:${new Date(now).toISOString().slice(0, 10)}`;
}
export function personalPlaybackActivity(
  rows: PlaybackActivity[],
  userId: string,
  userName: string
) {
  const normalizedUserId = userId.trim().toLowerCase();
  const normalizedUserName = userName.trim().toLowerCase();
  return rows.filter((row) => {
    const rowUserId = row.user_id?.trim().toLowerCase() ?? '';
    const rowUserName = row.user_name?.trim().toLowerCase() ?? '';
    if (!rowUserId && !rowUserName) return true;
    return (
      (Boolean(normalizedUserId) && rowUserId === normalizedUserId) ||
      (Boolean(normalizedUserName) && rowUserName === normalizedUserName)
    );
  });
}


export function mergeItems(...groups: JellyfinItem[][]) {
  const seen = new Map<string, JellyfinItem>();
  for (const group of groups) {
    for (const item of group) {
      seen.set(item.Id, { ...seen.get(item.Id), ...item });
    }
  }
  return [...seen.values()];
}

export function continueWatching(items: JellyfinItem[]) {
  return items
    .filter(hasMeaningfulResume)
    .sort((a, b) => dateValue(b.UserData?.LastPlayedDate) - dateValue(a.UserData?.LastPlayedDate));
}

export function popularItems(items: JellyfinItem[]) {
  return [...items]
    .filter((item) => (item.UserData?.PlayCount ?? 0) > 0)
    .sort((a, b) => {
      const plays = (b.UserData?.PlayCount ?? 0) - (a.UserData?.PlayCount ?? 0);
      if (plays !== 0) return plays;
      return dateValue(b.UserData?.LastPlayedDate) - dateValue(a.UserData?.LastPlayedDate);
    });
}

export function rankRecommendations(
  items: JellyfinItem[],
  input: PlaybackActivity[] | RecommendationOptions = [],
  currentItem?: JellyfinItem | null
) {
  const options = recommendationOptions(input, currentItem);
  const watched = items.filter(
    (item) =>
      (item.UserData?.PlayCount ?? 0) > 0 ||
      (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ||
      item.UserData?.Played ||
      item.UserData?.IsFavorite
  );
  const activeItem = options.currentItem ?? null;
  const currentTokens = activeItem ? itemSimilarityTokens(activeItem) : new Set<string>();
  const currentChannel = activeItem ? channelName(activeItem).toLowerCase() : '';
  const currentGenreSet = tokenSet(activeItem?.Genres ?? []);
  const currentArtistSet = tokenSet([
    ...(activeItem?.Artists ?? []),
    ...(activeItem?.ArtistItems ?? []).map((artist) => artist.Name),
    ...(activeItem?.Studios ?? []).map((studio) => studio.Name)
  ]);
  const historyTokens = new Map<string, number>();
  const watchedSeries = new Set<string>();
  const watchedParents = new Set<string>();
  const watchedGenres = new Set<string>();
  const watchedChannels = new Set<string>();
  const now = options.now;

  for (const item of watched) {
    const weight =
      1 + Math.min(Math.max(item.UserData?.PlayCount ?? 0, 0), 5) + (item.UserData?.IsFavorite ? 5 : 0);
    for (const token of itemTokens(item)) {
      historyTokens.set(token, (historyTokens.get(token) ?? 0) + weight);
    }
    if (item.SeriesId) watchedSeries.add(item.SeriesId);
    if (item.ParentId) watchedParents.add(item.ParentId);
    watchedChannels.add(channelName(item).toLowerCase());
    for (const genre of item.Genres ?? []) watchedGenres.add(genre.toLowerCase());
  }

  for (const row of options.activity) {
    const weight = playbackActivityWeight(row, now);
    for (const token of tokenize(row.item_name ?? '')) {
      historyTokens.set(token, (historyTokens.get(token) ?? 0) + weight);
    }
  }

  const ranked = items
    .filter((item) => isRecommendationCandidate(item, options))
    .map<RankedItem>((item) => {
      let score = 0;
      const reasons: string[] = [];
      let strongestReason = '';
      let strongestEvidence = 0;
      const addEvidence = (strength: number, reason: string) => {
        if (strength <= 0) return;
        score += strength;
        reasons.push(reason);
        if (
          strength > strongestEvidence ||
          (strength === strongestEvidence && (!strongestReason || reason < strongestReason))
        ) {
          strongestEvidence = strength;
          strongestReason = reason;
        }
      };
      const itemDate = contentDateValue(item);
      const ageDays = itemDate ? (now - itemDate) / 86_400_000 : 365;

      const completed = isCompleted(item);
      const rewatchable = isRewatchable(item);
      const recentlyPlayed =
        options.recentItemIds.has(item.Id) ||
        wasRecentlyWatched(item, options.now, options.recentlyWatchedDays);

      score += completed ? 6 : 20;
      if (completed && rewatchable) {
        addEvidence(Math.min(Math.max(item.UserData?.PlayCount ?? 0, 0) * 2, 8), 'ready to replay');
      }
      if (recentlyPlayed) score -= rewatchable ? 8 : 18;
      if (ageDays < 14) {
        addEvidence(12, 'new in your library');
      } else if (ageDays < 60) {
        addEvidence(6, 'recently added');
      }
      if (item.UserData?.IsFavorite) addEvidence(10, 'one of your favorites');
      if (item.SeriesId && watchedSeries.has(item.SeriesId)) {
        addEvidence(options.mode === 'watch' ? 12 : 20, 'more from a series you watch');
      }
      if (item.ParentId && watchedParents.has(item.ParentId)) {
        addEvidence(8, 'more from a collection you watch');
      }
      if ((item.Genres ?? []).some((genre) => watchedGenres.has(genre.toLowerCase()))) {
        addEvidence(6, 'from genres you watch');
      }
      const itemChannel = channelName(item).toLowerCase();
      if (currentChannel && itemChannel === currentChannel) {
        addEvidence(options.mode === 'watch' ? 24 : 18, 'more from this channel');
      } else if (watchedChannels.has(itemChannel)) {
        addEvidence(10, 'from channels you watch');
      }

      const currentOverlap = overlapCount(currentTokens, itemSimilarityTokens(item));
      if (currentOverlap > 0) {
        addEvidence(Math.min(currentOverlap * 7, 42), 'similar to what you are watching');
      }
      const genreOverlap = overlapCount(currentGenreSet, tokenSet(item.Genres ?? []));
      if (genreOverlap > 0) {
        addEvidence(Math.min(genreOverlap * 10, 30), 'similar genre');
      }
      const creatorOverlap = overlapCount(
        currentArtistSet,
        tokenSet([
          ...(item.Artists ?? []),
          ...(item.ArtistItems ?? []).map((artist) => artist.Name),
          ...(item.Studios ?? []).map((studio) => studio.Name)
        ])
      );
      if (creatorOverlap > 0) {
        addEvidence(Math.min(creatorOverlap * 12, 24), 'similar creator');
      }
      const durationScore = durationAffinity(activeItem, item);
      if (durationScore > 0) addEvidence(durationScore, 'similar length');
      else score += durationScore;
      const kindScore = contentKindAffinity(activeItem, item);
      if (kindScore > 0) addEvidence(kindScore, 'same kind of video');
      else score += kindScore;

      let historyScore = 0;
      for (const token of itemTokens(item)) {
        historyScore += Math.min(historyTokens.get(token) ?? 0, 8);
      }
      addEvidence(Math.min(historyScore, 36), 'based on your watch history');

      const relatedScore = options.relatedItemScores?.get(item.Id);
      if (relatedScore !== undefined && Number.isFinite(relatedScore)) {
        addEvidence(
          Math.min(Math.max(relatedScore, 0), 1) * 36,
          activeItem ? 'similar to what you are watching' : 'matches what you watch'
        );
      }

      score += recommendationRandomBoost(item, options);
      const fallback = recommendationReason(item, ageDays);

      return {
        ...item,
        score,
        reason: strongestReason || fallback,
        reasons: reasons.length ? reasons : [fallback]
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || contentDateValue(b) - contentDateValue(a));

  return diversifyRecommendations(ranked, options);
}
export function watchRecommendationCandidates(
  ranked: RankedItem[],
  currentItem: JellyfinItem | null
): RankedItem[] {
  if (!currentItem || (currentItem.Type !== 'Episode' && !episodeInfo(currentItem))) return ranked;
  return ranked.filter((candidate) => {
    if (currentItem.SeriesId && candidate.SeriesId === currentItem.SeriesId) return false;
    return !sameEpisodeSeries(candidate, currentItem);
  });
}


export function displayTitle(item: JellyfinItem, options: DisplayTitleOptions = {}) {
  const inEpisodeContext =
    options.context === 'series' ||
    options.context === 'channel' ||
    options.context === 'recommendation';
  const parsedEpisode = episodeInfo(item);
  if (parsedEpisode) {
    if (inEpisodeContext) return episodeTitle(item);
    return `${parsedEpisode.seriesName} ${episodeCode(item)} - ${episodeTitle(item)}`;
  }
  if (item.Type === 'Episode' && item.SeriesName) {
    if (inEpisodeContext) return item.Name;
    const season = item.ParentIndexNumber ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : '';
    const episode = item.IndexNumber ? `E${String(item.IndexNumber).padStart(2, '0')}` : '';
    const code = season || episode ? ` ${season}${episode}` : '';
    return `${item.SeriesName}${code} - ${item.Name}`;
  }
  if ((options.context === 'channel' || options.context === 'recommendation') && options.channel) {
    return titleWithoutRedundantChannel(item.Name, options.channel);
  }
  return item.Name;
}

export function channelName(item: JellyfinItem) {
  if (item.Type === 'Movie' || item.contentKind === 'movie') {
    return item.sourceLibraryName || 'YouTube Movies';
  }
  const parsedEpisode = episodeInfo(item);
  if (parsedEpisode) return parsedEpisode.seriesName;
  if (item.SeriesName) return item.SeriesName;
  if (item.ArtistItems?.[0]?.Name) return item.ArtistItems[0].Name;
  if (item.Artists?.[0]) return item.Artists[0];
  if (item.Studios?.[0]?.Name) return item.Studios[0].Name;
  const title = stripYoutubeId(item.Name);
  if (item.Type === 'MusicVideo' || item.contentKind === 'musicVideo') {
    const artist = firstSegment(title, [' - ', ' – ', ' — ', ': ', '：']);
    if (artist) return artist;
  }
  const channel = lastSegment(title, [' | ', ' ｜ ', ' - ', ' – ', ' — ']);
  if (channel) return channel;
  return 'Jellyfin';
}

export function compactMeta(item: JellyfinItem) {
  const parts: string[] = [];
  const plays = item.UserData?.PlayCount ?? 0;
  if (plays > 0) parts.push(`${plays} ${plays === 1 ? 'view' : 'views'}`);
  if (item.contentKind === 'movie' && item.ProductionYear) parts.push(String(item.ProductionYear));
  const displayDate = contentDate(item);
  if (displayDate) parts.push(relativeDate(displayDate));
  return parts.join(' • ');
}

export function channelMatches(item: JellyfinItem, channel: string) {
  return channelName(item).toLowerCase() === channel.toLowerCase();
}

export function groupByChannel(items: JellyfinItem[]) {
  const groups = new Map<string, JellyfinItem[]>();
  for (const item of items) {
    const channel = channelName(item);
    groups.set(channel, [...(groups.get(channel) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      items: group.sort((a, b) => contentDateValue(b) - contentDateValue(a))
    }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

export function formatDuration(ticks?: number) {
  if (!ticks) return '';
  const totalSeconds = Math.max(0, Math.round(ticks / 10_000_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function playbackProgress(item: JellyfinItem) {
  const pct = item.UserData?.PlayedPercentage;
  if (pct !== undefined) return Math.min(Math.max(pct, 0), 100);
  const position = item.UserData?.PlaybackPositionTicks ?? 0;
  if (!position || !item.RunTimeTicks) return 0;
  return Math.min(Math.max((position / item.RunTimeTicks) * 100, 0), 100);
}

export function isShortForm(item: JellyfinItem) {
  return Boolean(item.RunTimeTicks && item.RunTimeTicks < SHORT_FORM_RESUME_TICKS);
}

export function shouldStartFromBeginning(item: JellyfinItem) {
  return (
    isShortForm(item) &&
    (item.UserData?.PlaybackPositionTicks ?? 0) > 0 &&
    !item.UserData?.Played &&
    playbackProgress(item) < 95
  );
}

export function hasMeaningfulResume(item: JellyfinItem) {
  return (
    (item.UserData?.PlaybackPositionTicks ?? 0) > 0 &&
    !item.UserData?.Played &&
    playbackProgress(item) < 95 &&
    !shouldStartFromBeginning(item)
  );
}

function itemTokens(item: JellyfinItem) {
  return new Set([
    ...tokenize(item.Name),
    ...tokenize(item.SeriesName ?? ''),
    ...tokenize(channelName(item)),
    ...(item.Artists ?? []).flatMap(tokenize),
    ...(item.ArtistItems ?? []).flatMap((artist) => tokenize(artist.Name)),
    ...(item.Studios ?? []).flatMap((studio) => tokenize(studio.Name)),
    ...(item.Genres ?? []).flatMap(tokenize),
    ...(item.Tags ?? []).flatMap(tokenize)
  ]);
}

function itemSimilarityTokens(item: JellyfinItem) {
  const channel = channelName(item);
  return new Set([
    ...tokenize(displayTitle(item, { context: 'recommendation', channel })),
    ...tokenize(item.SeriesName ?? ''),
    ...(item.Genres ?? []).flatMap(tokenize),
    ...(item.Tags ?? []).flatMap(tokenize)
  ]);
}

function recommendationOptions(
  input: PlaybackActivity[] | RecommendationOptions,
  currentItem?: JellyfinItem | null
): ResolvedRecommendationOptions {
  const options = Array.isArray(input) ? { activity: input, currentItem } : input;
  const mode = options.mode ?? (options.currentItem ?? currentItem ? 'watch' : 'home');
  return {
    ...options,
    activity: options.activity ?? [],
    currentItem: options.currentItem ?? currentItem ?? null,
    mode,
    recentItemIds: new Set(options.recentItemIds ?? []),
    queueItemIds: new Set((options.queueItems ?? []).map((item) => item.Id)),
    now: options.now ?? Date.now(),
    recentlyWatchedDays: options.recentlyWatchedDays ?? RECENTLY_WATCHED_DAYS,
    randomness: options.randomness ?? defaultRecommendationRandomness(mode)
  };
}

function defaultRecommendationRandomness(mode: RecommendationMode) {
  if (mode === 'music') return 22;
  if (mode === 'home') return 18;
  if (mode === 'movie') return 14;
  if (mode === 'watch') return 12;
  return 10;
}

function recommendationRandomBoost(item: JellyfinItem, options: ResolvedRecommendationOptions) {
  if (options.randomness <= 0) return 0;
  const random =
    options.randomSeed === undefined
      ? Math.random()
      : seededFraction(`${options.randomSeed}:${options.mode}:${item.Id}`);
  return random * options.randomness;
}

function seededFraction(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function isRecommendationCandidate(item: JellyfinItem, options: ResolvedRecommendationOptions) {
  if (item.Id === options.currentItem?.Id) return false;
  if (options.queueItemIds.has(item.Id)) return false;
  if (options.mode === 'replay') return true;
  if (hasMeaningfulResume(item)) return false;
  if (isCompleted(item) && !isRewatchable(item)) return false;
  return true;
}

function isCompleted(item: JellyfinItem) {
  return Boolean(item.UserData?.Played || playbackProgress(item) >= 95);
}

function isRewatchable(item: JellyfinItem) {
  return item.contentKind === 'musicVideo' || item.Type === 'MusicVideo';
}

function playbackActivityWeight(row: PlaybackActivity, now: number) {
  const totalCount = Number.isFinite(row.total_count) ? Math.max(row.total_count ?? 0, 0) : 0;
  const frequencyWeight = 1 + Math.min(Math.log2(totalCount + 1), 4);
  const latestDate = dateValue(row.latest_date);
  if (!latestDate) return frequencyWeight;
  const ageDays = (now - latestDate) / 86_400_000;
  if (ageDays < 0) return frequencyWeight;
  const recencyWeight = 4 * (1 - Math.min(ageDays / 90, 1));
  return frequencyWeight + recencyWeight;
}

function wasRecentlyWatched(item: JellyfinItem, now: number, days: number) {
  const lastPlayed = dateValue(item.UserData?.LastPlayedDate);
  if (!lastPlayed) return false;
  const ageDays = (now - lastPlayed) / 86_400_000;
  if (ageDays < 0 || ageDays > days) return false;
  return Boolean(item.UserData?.Played || playbackProgress(item) >= 92 || (item.UserData?.PlayCount ?? 0) > 0);
}

function contentKindAffinity(currentItem: JellyfinItem | null, item: JellyfinItem) {
  if (!currentItem) return 0;
  const currentKind = currentItem.contentKind ?? currentItem.Type;
  const itemKind = item.contentKind ?? item.Type;
  if (currentKind === itemKind) return 12;
  if (currentKind === 'movie' || itemKind === 'movie') return -18;
  return -6;
}

function durationAffinity(currentItem: JellyfinItem | null, item: JellyfinItem) {
  if (!currentItem?.RunTimeTicks || !item.RunTimeTicks) return 0;
  const currentDuration = currentItem.RunTimeTicks;
  const candidateDuration = item.RunTimeTicks;
  const ratio = Math.min(currentDuration, candidateDuration) / Math.max(currentDuration, candidateDuration);
  if (isShortForm(currentItem) && isShortForm(item)) return 8;
  if (isShortForm(currentItem) !== isShortForm(item)) return -8;
  if (ratio > 0.75) return 8;
  if (ratio > 0.5) return 4;
  return 0;
}

function diversifyRecommendations(items: RankedItem[], options: ReturnType<typeof recommendationOptions>) {
  const maxPerChannel = options.maxPerChannel ?? (options.mode === 'watch' ? 4 : 6);
  const maxPerSeries = options.maxPerSeries ?? (options.mode === 'watch' ? 3 : 5);
  const channelCounts = new Map<string, number>();
  const seriesCounts = new Map<string, number>();
  const selected: RankedItem[] = [];
  const skipped: RankedItem[] = [];

  for (const item of items) {
    const channel = channelName(item).toLowerCase();
    const series = recommendationSeriesKey(item);
    const channelCount = channelCounts.get(channel) ?? 0;
    const seriesCount = series ? seriesCounts.get(series) ?? 0 : 0;
    if (channelCount >= maxPerChannel || (series && seriesCount >= maxPerSeries)) {
      skipped.push(item);
      continue;
    }
    selected.push(item);
    channelCounts.set(channel, channelCount + 1);
    if (series) seriesCounts.set(series, seriesCount + 1);
  }

  return [...selected, ...skipped];
}

function recommendationSeriesKey(item: JellyfinItem) {
  return episodeInfo(item)?.seriesKey ?? item.SeriesId ?? normalizeTitleSegment(item.SeriesName ?? '');
}

function tokenSet(values: string[]) {
  return new Set(values.flatMap(tokenize));
}

function overlapCount(first: Set<string>, second: Set<string>) {
  let count = 0;
  for (const value of first) {
    if (second.has(value)) count += 1;
  }
  return count;
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 2 && !stopWords.has(part));
}

function stripYoutubeId(value: string) {
  return value.replace(/\s*\[[a-zA-Z0-9_-]{6,}\]\s*$/, '').trim();
}

function titleWithoutRedundantChannel(value: string, channel: string) {
  const title = stripYoutubeId(value);
  const normalizedChannel = normalizeTitleSegment(channel);
  if (!title || !normalizedChannel) return title || value;

  const separators = [' | ', ' ｜ ', ' - ', ' – ', ' — ', ': ', '：'];
  for (const separator of separators) {
    const index = title.lastIndexOf(separator);
    if (index <= 0) continue;
    const prefix = title.slice(0, index).trim();
    const suffix = title.slice(index + separator.length).trim();
    if (prefix && normalizeTitleSegment(suffix) === normalizedChannel) return prefix;
  }

  for (const separator of separators) {
    const index = title.indexOf(separator);
    if (index <= 0) continue;
    const prefix = title.slice(0, index).trim();
    const suffix = title.slice(index + separator.length).trim();
    if (suffix && normalizeTitleSegment(prefix) === normalizedChannel) return suffix;
  }

  return title;
}

function normalizeTitleSegment(value: string) {
  return stripYoutubeId(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function firstSegment(value: string, separators: string[]) {
  const match = separators
    .map((separator) => ({ separator, index: value.indexOf(separator) }))
    .filter((candidate) => candidate.index > 0)
    .sort((a, b) => a.index - b.index)[0];
  return match ? cleanChannelSegment(value.slice(0, match.index)) : '';
}

function lastSegment(value: string, separators: string[]) {
  const match = separators
    .map((separator) => ({ separator, index: value.lastIndexOf(separator) }))
    .filter((candidate) => candidate.index > 0)
    .sort((a, b) => b.index - a.index)[0];
  return match ? cleanChannelSegment(value.slice(match.index + match.separator.length)) : '';
}

function cleanChannelSegment(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function recommendationReason(item: JellyfinItem, ageDays: number) {
  if ((item.UserData?.PlaybackPositionTicks ?? 0) > 0) return 'pick up from your history';
  if ((item.UserData?.PlayCount ?? 0) > 0 || item.UserData?.Played) return 'replay from your history';
  if (ageDays < 60) return 'new in your library';
  return 'library discovery';
}

const stopWords = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'you',
  'your',
  'are',
  'was',
  'were',
  'have',
  'has',
  'official',
  'video'
]);
