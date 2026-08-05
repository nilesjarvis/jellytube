import { contentDateValue, dateValue } from './dates';
import { episodeInfo } from './episodes';
import { groupByChannel } from './recommendations';
import { normalizeSearch } from './search';
import { showProgressForEpisodes, type ShowProgress } from './showProgress';
import type { JellyfinItem } from './types';

export type ChannelDirectoryKind = 'show' | 'music' | 'channel';

export type ChannelDirectoryEntry = {
  name: string;
  kind: ChannelDirectoryKind;
  itemCount: number;
  seriesItem: JellyfinItem | null;
  latestItem: JellyfinItem | null;
  sourceLibraryName: string;
  sortDate: number;
  lastPlayedDate: number;
  episodic: boolean;
  progress: ShowProgress | null;
};

export function channelDirectoryEntries(items: JellyfinItem[], series: JellyfinItem[] = []) {
  const entries = new Map<string, ChannelDirectoryEntry>();

  for (const show of series) {
    const name = show.Name.trim();
    const key = normalizeDirectoryName(name);
    if (!key) continue;
    entries.set(key, {
      name,
      kind: 'show',
      itemCount: 0,
      seriesItem: show,
      latestItem: null,
      sourceLibraryName: show.sourceLibraryName ?? '',
      sortDate: contentDateValue(show),
      lastPlayedDate: 0,
      episodic: false,
      progress: null
    });
  }

  for (const group of groupByChannel(items.filter((item) => item.contentKind !== 'movie' && item.Type !== 'Movie'))) {
    const key = normalizeDirectoryName(group.name);
    if (!key || group.name === 'Jellyfin') continue;
    const existing = entries.get(key);
    const latestItem = newestItem(existing?.latestItem ?? null, group.items[0] ?? null);
    const kind = existing?.kind === 'show' ? 'show' : kindForItems(group.items);
    const progress = showProgressForEpisodes(group.items);
    entries.set(key, {
      name: existing?.name ?? group.name,
      kind,
      itemCount: group.items.length,
      seriesItem: existing?.seriesItem ?? null,
      latestItem,
      sourceLibraryName: existing?.sourceLibraryName || group.items[0]?.sourceLibraryName || '',
      sortDate: Math.max(existing?.sortDate ?? 0, latestItem ? contentDateValue(latestItem) : 0),
      lastPlayedDate: Math.max(existing?.lastPlayedDate ?? 0, maxLastPlayedDate(group.items)),
      episodic: Boolean(existing?.episodic) || isEpisodicGroup(group.items),
      progress: progress ?? existing?.progress ?? null
    });
  }

  return [...entries.values()].sort(compareDirectoryEntries);
}

export function filterChannelDirectory(entries: ChannelDirectoryEntry[], query: string) {
  const normalizedQuery = normalizeDirectoryName(query);
  if (!normalizedQuery) return entries;
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  return entries.filter((entry) => {
    const normalizedName = normalizeDirectoryName(entry.name);
    const normalizedSource = normalizeDirectoryName(entry.sourceLibraryName);
    return tokens.every((token) => normalizedName.includes(token) || normalizedSource.includes(token));
  });
}

function normalizeDirectoryName(value: string) {
  return normalizeSearch(value);
}

function kindForItems(items: JellyfinItem[]): ChannelDirectoryKind {
  if (items.some((item) => item.Type === 'Episode' || item.SeriesName)) return 'show';
  if (items.length && items.every((item) => item.contentKind === 'musicVideo' || item.Type === 'MusicVideo')) {
    return 'music';
  }
  return 'channel';
}

function newestItem(first: JellyfinItem | null, second: JellyfinItem | null) {
  if (!first) return second;
  if (!second) return first;
  return contentDateValue(second) > contentDateValue(first) ? second : first;
}

function compareDirectoryEntries(a: ChannelDirectoryEntry, b: ChannelDirectoryEntry) {
  const kindOrder = kindRank(a.kind) - kindRank(b.kind);
  if (kindOrder !== 0) return kindOrder;
  if (a.kind === 'show') return a.name.localeCompare(b.name);
  return b.itemCount - a.itemCount || b.sortDate - a.sortDate || a.name.localeCompare(b.name);
}

function kindRank(kind: ChannelDirectoryKind) {
  if (kind === 'show') return 0;
  if (kind === 'channel') return 1;
  return 2;
}

function isEpisodicGroup(items: JellyfinItem[]) {
  const episodicItems = items.filter((item) => episodeInfo(item) || item.Type === 'Episode');
  if (episodicItems.length < 2) return false;
  return episodicItems.length / items.length >= 0.6;
}

function maxLastPlayedDate(items: JellyfinItem[]) {
  let max = 0;
  for (const item of items) {
    const played = dateValue(item.UserData?.LastPlayedDate);
    if (played > max) max = played;
  }
  return max;
}
