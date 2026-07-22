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
    detail: 'Recently added episodes'
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
    if (categoryItems.length >= limit) continue;
    categoryItems.push(item);
    grouped.set(id, categoryItems);
  }

  return sectionDefinitions.flatMap((definition) => {
    const categoryItems = grouped.get(definition.id) ?? [];
    return categoryItems.length ? [{ ...definition, items: categoryItems }] : [];
  });
}
