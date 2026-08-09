import { dateValue } from './dates';
import type { JellyfinItem } from './types';

export type LatestAddedSectionId = 'shows' | 'movies' | 'music-videos' | 'videos';

export type LatestAddedSection = {
  id: LatestAddedSectionId;
  title: string;
  detail: string;
  items: JellyfinItem[];
};

const DEFAULT_CATEGORY_LIMIT = 24;
const sectionDefinitions: Array<Omit<LatestAddedSection, 'items'>> = [
  {
    id: 'shows',
    title: 'Latest added in shows',
    detail: 'Recently added shows'
  },
  {
    id: 'movies',
    title: 'Latest movies',
    detail: 'Recently added movies'
  },
  {
    id: 'music-videos',
    title: 'Latest music videos',
    detail: 'Recently added music videos'
  },
  {
    id: 'videos',
    title: 'Latest videos',
    detail: 'Recently added videos'
  }
];

export function latestAddedSectionId(item: JellyfinItem): LatestAddedSectionId {
  const type = item.Type.toLowerCase();
  const collectionType = (item.sourceCollectionType ?? '').toLowerCase();
  if (item.contentKind === 'movie' || type === 'movie' || collectionType === 'movies') {
    return 'movies';
  }
  if (
    item.contentKind === 'musicVideo' ||
    type === 'musicvideo' ||
    collectionType === 'musicvideos'
  ) {
    return 'music-videos';
  }
  if (collectionType === 'tvshows' || type === 'episode' || type === 'series') return 'shows';
  return 'videos';
}

/**
 * Stable identity key for grouping an item into a show (series). Episodes are
 * grouped by their SeriesId when available, falling back to their SeriesName,
 * and Series items group by their own Id.
 */
export function showSeriesKey(item: JellyfinItem): string {
  const seriesId = item.SeriesId?.trim();
  if (seriesId) return `series:${seriesId}`;
  const seriesName = item.SeriesName?.trim();
  if (seriesName) return `series:${seriesName.toLowerCase()}`;
  if (item.Type === 'Series' && item.Id.trim()) return `series:${item.Id}`;
  return '';
}

/**
 * Collapse a category's episode items into one representative item per show so
 * a show that was added as an entire library floods the feed with one card
 * instead of every episode. The newest representative episode is kept so the
 * feed still reflects what was recently added.
 */
export function dedupeShows(items: readonly JellyfinItem[]): JellyfinItem[] {
  const representatives = new Map<string, JellyfinItem>();
  for (const item of items) {
    const key = showSeriesKey(item);
    if (!key) continue;
    const existing = representatives.get(key);
    if (
      !existing ||
      (item.Type === 'Series' && existing.Type !== 'Series') ||
      dateValue(item.DateCreated) > dateValue(existing.DateCreated)
    ) {
      representatives.set(key, item);
    }
  }
  return [...items].filter(
    (item) => {
      const key = showSeriesKey(item);
      return !key || representatives.get(key) === item;
    }
  );
}

export function latestAddedSections(
  items: JellyfinItem[],
  categoryLimit = DEFAULT_CATEGORY_LIMIT
): LatestAddedSection[] {
  const limit = Number.isFinite(categoryLimit)
    ? Math.max(0, Math.floor(categoryLimit))
    : DEFAULT_CATEGORY_LIMIT;
  if (!limit) return [];

  const grouped = new Map<LatestAddedSectionId, JellyfinItem[]>();
  const newestFirst = [...items].sort(
    (a, b) => dateValue(b.DateCreated) - dateValue(a.DateCreated)
  );
  for (const item of newestFirst) {
    const id = latestAddedSectionId(item);
    const categoryItems = grouped.get(id) ?? [];
    // Shows are deduplicated later, so all episodes are collected first; other
    // categories stop collecting once their display limit is reached.
    if (categoryItems.length >= limit && id !== 'shows') continue;
    categoryItems.push(item);
    grouped.set(id, categoryItems);
  }

  return sectionDefinitions.flatMap((definition) => {
    const rawItems = grouped.get(definition.id) ?? [];
    if (!rawItems.length) return [];
    const items =
      definition.id === 'shows' ? dedupeShows(rawItems).slice(0, limit) : rawItems;
    return items.length ? [{ ...definition, items }] : [];
  });
}
