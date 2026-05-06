import type { JellyfinItem } from './types';
import { dateValue } from './dates';

export type EpisodeInfo = {
  seriesKey: string;
  seriesName: string;
  season: number;
  episode: number;
};

export type EpisodeSeason = {
  season: number;
  label: string;
  items: JellyfinItem[];
};

export type EpisodeCollection = {
  seriesKey: string;
  seriesName: string;
  currentSeason: number;
  allItems: JellyfinItem[];
  seasons: EpisodeSeason[];
};

const seasonEpisodePattern = /(?:^|[\s._-])S(\d{1,3})E(\d{1,4})(?=$|[\s._-])/i;
const trailingSeasonPattern = /\s+S\d{1,3}$/i;

export function episodeInfo(item: JellyfinItem): EpisodeInfo | null {
  const parsed = parseEpisodeName(item.Name);
  const season = item.ParentIndexNumber ?? parsed?.season;
  const episode = item.IndexNumber ?? parsed?.episode;
  if (!season || !episode) return null;

  const seriesName = cleanSeriesName(parsed?.seriesName || item.SeriesName || channelNameFallback(item));
  const seriesKey = item.SeriesId || normalizeSeriesKey(seriesName);
  if (!seriesKey || !seriesName) return null;

  return { seriesKey, seriesName, season, episode };
}

export function episodeCollectionForItem(
  currentItem: JellyfinItem,
  items: JellyfinItem[]
): EpisodeCollection | null {
  const currentInfo = episodeInfo(currentItem);
  if (!currentInfo) return null;

  const allItems = items
    .filter((item) => episodeInfo(item)?.seriesKey === currentInfo.seriesKey)
    .sort(compareEpisodes);

  if (allItems.length <= 1) return null;

  const seasons = new Map<number, JellyfinItem[]>();
  for (const item of allItems) {
    const info = episodeInfo(item);
    if (!info) continue;
    seasons.set(info.season, [...(seasons.get(info.season) ?? []), item]);
  }

  return {
    seriesKey: currentInfo.seriesKey,
    seriesName: currentInfo.seriesName,
    currentSeason: currentInfo.season,
    allItems,
    seasons: [...seasons.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, seasonItems]) => ({
        season,
        label: `Season ${season}`,
        items: seasonItems.sort(compareEpisodes)
      }))
  };
}

export function compareEpisodes(a: JellyfinItem, b: JellyfinItem) {
  const first = episodeInfo(a);
  const second = episodeInfo(b);
  if (!first || !second) return a.Name.localeCompare(b.Name);
  if (first.season !== second.season) return first.season - second.season;
  if (first.episode !== second.episode) return first.episode - second.episode;
  const premiered = dateValue(a.PremiereDate) - dateValue(b.PremiereDate);
  if (premiered !== 0) return premiered;
  const created = dateValue(a.DateCreated) - dateValue(b.DateCreated);
  if (created !== 0) return created;
  return a.Name.localeCompare(b.Name);
}

export function episodeCode(item: JellyfinItem) {
  const info = episodeInfo(item);
  if (!info) return '';
  return `S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`;
}

export function episodeTitle(item: JellyfinItem) {
  const match = seasonEpisodePattern.exec(item.Name);
  if (!match) return item.Name;
  const title = item.Name.slice(match.index + match[0].length)
    .replace(/^[\s._-]+/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title || item.Name;
}

export function sameEpisodeSeries(a: JellyfinItem, b: JellyfinItem) {
  const first = episodeInfo(a);
  const second = episodeInfo(b);
  return Boolean(first && second && first.seriesKey === second.seriesKey);
}

function parseEpisodeName(name: string) {
  const match = seasonEpisodePattern.exec(name);
  if (!match) return null;
  return {
    seriesName: name.slice(0, match.index).replace(/[._-]+/g, ' ').trim(),
    season: Number(match[1]),
    episode: Number(match[2])
  };
}

function cleanSeriesName(value: string) {
  return value.replace(/[._-]+/g, ' ').replace(trailingSeasonPattern, '').replace(/\s+/g, ' ').trim();
}

function normalizeSeriesKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function channelNameFallback(item: JellyfinItem) {
  const parsed = parseEpisodeName(item.Name);
  if (parsed?.seriesName) return parsed.seriesName;
  return item.SeriesName || item.Name;
}
