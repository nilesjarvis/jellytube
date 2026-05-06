import { contentDateValue } from './dates';
import { groupByChannel } from './recommendations';
import { normalizeSearch } from './search';
import type { JellyfinItem } from './types';

export type ChannelDirectoryKind = 'show' | 'music' | 'channel';

export type ChannelDirectoryEntry = {
  name: string;
  kind: ChannelDirectoryKind;
  itemCount: number;
  latestItem: JellyfinItem | null;
  sourceLibraryName: string;
  sortDate: number;
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
      latestItem: null,
      sourceLibraryName: show.sourceLibraryName ?? '',
      sortDate: contentDateValue(show)
    });
  }

  for (const group of groupByChannel(items.filter((item) => item.contentKind !== 'movie' && item.Type !== 'Movie'))) {
    const key = normalizeDirectoryName(group.name);
    if (!key || group.name === 'Jellyfin') continue;
    const existing = entries.get(key);
    const latestItem = newestItem(existing?.latestItem ?? null, group.items[0] ?? null);
    const kind = existing?.kind === 'show' ? 'show' : kindForItems(group.items);
    entries.set(key, {
      name: existing?.name ?? group.name,
      kind,
      itemCount: group.items.length,
      latestItem,
      sourceLibraryName: existing?.sourceLibraryName || group.items[0]?.sourceLibraryName || '',
      sortDate: Math.max(existing?.sortDate ?? 0, latestItem ? contentDateValue(latestItem) : 0)
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
