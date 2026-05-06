import type { JellyfinItem, PlaybackActivity } from './types';
import { episodeCode, episodeInfo, episodeTitle } from './episodes';
import { contentDate, contentDateValue, dateValue, relativeDate } from './dates';

export type RankedItem = JellyfinItem & {
  score?: number;
  reason?: string;
};

export type DisplayTitleOptions = {
  context?: 'feed' | 'series' | 'channel' | 'recommendation';
  channel?: string;
};

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
    .filter((item) => (item.UserData?.PlaybackPositionTicks ?? 0) > 0 && !item.UserData?.Played)
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
  activity: PlaybackActivity[] = [],
  currentItem?: JellyfinItem | null
) {
  const watched = items.filter(
    (item) =>
      (item.UserData?.PlayCount ?? 0) > 0 ||
      (item.UserData?.PlaybackPositionTicks ?? 0) > 0 ||
      item.UserData?.Played
  );
  const currentTokens = currentItem ? itemTokens(currentItem) : new Set<string>();
  const currentChannel = currentItem ? channelName(currentItem).toLowerCase() : '';
  const historyTokens = new Map<string, number>();
  const watchedSeries = new Set<string>();
  const watchedParents = new Set<string>();
  const watchedGenres = new Set<string>();
  const watchedChannels = new Set<string>();
  const now = Date.now();

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

  return items
    .filter((item) => item.Id !== currentItem?.Id)
    .map<RankedItem>((item) => {
      let score = 0;
      const reasons: string[] = [];
      const itemDate = contentDateValue(item);
      const ageDays = itemDate ? (now - itemDate) / 86_400_000 : 365;
      const playCount = item.UserData?.PlayCount ?? 0;
      const progress = item.UserData?.PlayedPercentage ?? 0;

      if (!item.UserData?.Played) score += 20;
      if ((item.UserData?.PlaybackPositionTicks ?? 0) > 0 && !item.UserData?.Played) {
        score += 14;
        reasons.push('resume');
      }
      if (ageDays < 14) {
        score += 16;
        reasons.push('new');
      } else if (ageDays < 60) {
        score += 8;
      }
      if (playCount > 0 && !item.UserData?.Played) score += Math.min(playCount * 4, 16);
      if (item.SeriesId && watchedSeries.has(item.SeriesId)) {
        score += 20;
        reasons.push('same series');
      }
      if (item.ParentId && watchedParents.has(item.ParentId)) score += 8;
      if ((item.Genres ?? []).some((genre) => watchedGenres.has(genre.toLowerCase()))) score += 6;
      const itemChannel = channelName(item).toLowerCase();
      if (currentChannel && itemChannel === currentChannel) {
        score += 64;
        reasons.push('same channel');
      } else if (watchedChannels.has(itemChannel)) {
        score += 14;
        reasons.push('from channels you watch');
      }

      for (const token of itemTokens(item)) {
        score += Math.min(historyTokens.get(token) ?? 0, 10);
        if (currentTokens.has(token)) score += 2;
      }

      if (item.UserData?.Played) score -= 18;
      if (progress > 92) score -= 14;

      return {
        ...item,
        score,
        reason: reasons[0] ?? recommendationReason(item)
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
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
