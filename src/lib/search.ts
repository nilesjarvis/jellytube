import { episodeInfo } from './episodes';
import { contentDateValue } from './dates';
import { channelName, displayTitle } from './recommendations';
import type { JellyfinItem } from './types';

export function searchLoadedItems(searchTerm: string, items: JellyfinItem[]) {
  return items.filter((item) => searchScore(item, searchTerm) > 0);
}

export function rankSearchResults(items: JellyfinItem[], searchTerm: string) {
  return [...items]
    .map((item) => ({ item, score: searchScore(item, searchTerm) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || contentDateValue(b.item) - contentDateValue(a.item))
    .map((result) => result.item);
}

export function searchScore(item: JellyfinItem, searchTerm: string) {
  const query = normalizeSearch(searchTerm);
  if (!query) return 0;
  const queryTokens = query.split(' ').filter(Boolean);
  const title = normalizeSearch(displayTitle(item));
  const name = normalizeSearch(item.Name);
  const series = normalizeSearch(item.SeriesName ?? (item.Type === 'Series' ? item.Name : ''));
  const channel = normalizeSearch(channelName(item));
  const tags = normalizeSearch(
    [
      ...(item.Tags ?? []),
      ...(item.Genres ?? []),
      ...(item.Artists ?? []),
      ...(item.Studios ?? []).map((studio) => studio.Name)
    ].join(' ')
  );
  const fields = [title, name, series, channel, tags].filter(Boolean);

  let score = 0;
  if (series === query) score += 260;
  if (channel === query) score += 220;
  if (title === query || name === query) score += 180;
  if (series.startsWith(query)) score += 150;
  if (channel.startsWith(query)) score += 130;
  if (title.startsWith(query) || name.startsWith(query)) score += 90;
  if (series.includes(query)) score += 110;
  if (channel.includes(query)) score += 90;
  if (title.includes(query) || name.includes(query)) score += 55;
  if (fields.some((field) => queryTokens.every((token) => field.includes(token)))) score += 40;
  if (item.Type === 'Episode' && episodeInfo(item)) score += 12;
  return score;
}

export function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
