import type { JellyfinItem, PlaybackActivity } from './types';
import { episodeCode, episodeInfo, episodeTitle } from './episodes';
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
  now?: number;
  recentlyWatchedDays?: number;
  maxPerChannel?: number;
  maxPerSeries?: number;
  randomness?: number;
  randomSeed?: string | number;
};

const SHORT_FORM_RESUME_TICKS = 8 * 60 * 10_000_000;
const RECENTLY_WATCHED_DAYS = 3;

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
  const activity = options.activity;
  const watched = items.filter(
    (item) =>
      (item.UserData?.PlayCount ?? 0) > 0 ||
      (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ||
      item.UserData?.Played
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
    const weight = 1 + Math.min(item.UserData?.PlayCount ?? 0, 5);
    for (const token of itemTokens(item)) {
      historyTokens.set(token, (historyTokens.get(token) ?? 0) + weight);
    }
    if (item.SeriesId) watchedSeries.add(item.SeriesId);
    if (item.ParentId) watchedParents.add(item.ParentId);
    watchedChannels.add(channelName(item).toLowerCase());
    for (const genre of item.Genres ?? []) watchedGenres.add(genre.toLowerCase());
  }

  for (const row of activity) {
    for (const token of tokenize(row.item_name ?? '')) {
      historyTokens.set(token, (historyTokens.get(token) ?? 0) + 3);
    }
  }

  const ranked = items
    .filter((item) => isRecommendationCandidate(item, options))
    .map<RankedItem>((item) => {
      let score = 0;
      const reasons: string[] = [];
      const itemDate = contentDateValue(item);
      const ageDays = itemDate ? (now - itemDate) / 86_400_000 : 365;

      const completed = isCompleted(item);
      const rewatchable = isRewatchable(item, options);
      const recentlyPlayed =
        options.recentItemIds.has(item.Id) || wasRecentlyWatched(item, options.now, options.recentlyWatchedDays);

      score += completed ? 6 : 20;
      if (completed && rewatchable) score += Math.min((item.UserData?.PlayCount ?? 0) * 2, 8);
      if (recentlyPlayed) {
        score -= rewatchable ? 8 : 18;
        reasons.push('recently played');
      }
      if (ageDays < 14) {
        score += 12;
        reasons.push('new');
      } else if (ageDays < 60) {
        score += 6;
      }
      if (item.SeriesId && watchedSeries.has(item.SeriesId)) {
        score += options.mode === 'watch' ? 12 : 20;
        reasons.push('same series');
      }
      if (item.ParentId && watchedParents.has(item.ParentId)) score += 8;
      if ((item.Genres ?? []).some((genre) => watchedGenres.has(genre.toLowerCase()))) score += 6;
      const itemChannel = channelName(item).toLowerCase();
      if (currentChannel && itemChannel === currentChannel) {
        score += options.mode === 'watch' ? 24 : 18;
        reasons.push('same channel');
      } else if (watchedChannels.has(itemChannel)) {
        score += 10;
        reasons.push('from channels you watch');
      }

      const currentOverlap = overlapCount(currentTokens, itemSimilarityTokens(item));
      if (currentOverlap > 0) {
        score += Math.min(currentOverlap * 7, 42);
        reasons.push('similar title');
      }
      const genreOverlap = overlapCount(currentGenreSet, tokenSet(item.Genres ?? []));
      if (genreOverlap > 0) {
        score += Math.min(genreOverlap * 10, 30);
        reasons.push('similar genre');
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
        score += Math.min(creatorOverlap * 12, 24);
        reasons.push('similar creator');
      }
      score += durationAffinity(activeItem, item);
      score += contentKindAffinity(activeItem, item);

      for (const token of itemTokens(item)) {
        score += Math.min(historyTokens.get(token) ?? 0, 8);
      }

      score += recommendationRandomBoost(item, options);

      return {
        ...item,
        score,
        reason: reasons[0] ?? recommendationReason(item),
        reasons: reasons.length ? reasons : [recommendationReason(item)]
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || contentDateValue(b) - contentDateValue(a));

  return diversifyRecommendations(ranked, options);
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
): Required<Pick<RecommendationOptions, 'activity' | 'mode' | 'now' | 'recentlyWatchedDays' | 'randomness'>> &
  Omit<RecommendationOptions, 'activity' | 'mode' | 'now' | 'recentlyWatchedDays' | 'randomness'> & {
    recentItemIds: Set<string>;
    queueItemIds: Set<string>;
  } {
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

function recommendationRandomBoost(
  item: JellyfinItem,
  options: ReturnType<typeof recommendationOptions>
) {
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

function isRecommendationCandidate(
  item: JellyfinItem,
  options: ReturnType<typeof recommendationOptions>
) {
  if (item.Id === options.currentItem?.Id) return false;
  if (options.queueItemIds.has(item.Id)) return false;
  if (options.mode === 'replay') return true;
  if (hasMeaningfulResume(item)) return false;
  if (isCompleted(item) && !isRewatchable(item, options)) return false;
  return true;
}

function isCompleted(item: JellyfinItem) {
  return Boolean(item.UserData?.Played || playbackProgress(item) >= 95);
}

function isRewatchable(item: JellyfinItem, options: ReturnType<typeof recommendationOptions>) {
  return options.mode === 'music'
    ? item.contentKind === 'musicVideo' || item.Type === 'MusicVideo'
    : item.contentKind === 'musicVideo' || item.Type === 'MusicVideo';
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

function recommendationReason(item: JellyfinItem) {
  if ((item.UserData?.PlaybackPositionTicks ?? 0) > 0) return 'continue';
  if ((item.UserData?.PlayCount ?? 0) > 0) return 'from your history';
  return 'recommended';
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
