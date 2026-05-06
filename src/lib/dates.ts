import type { JellyfinItem } from './types';

export function dateValue(value?: string) {
  return value ? new Date(value).getTime() || 0 : 0;
}

export function contentDate(item: JellyfinItem) {
  return item.PremiereDate || item.DateCreated || '';
}

export function contentDateValue(item: JellyfinItem) {
  return dateValue(contentDate(item));
}

export function compareByContentDateDesc(a: JellyfinItem, b: JellyfinItem) {
  return contentDateValue(b) - contentDateValue(a);
}

export function relativeDate(value: string, now = Date.now()) {
  const timestamp = dateValue(value);
  if (!timestamp) return '';

  const diff = now - timestamp;
  const absDays = Math.floor(Math.abs(diff) / 86_400_000);
  const suffix = diff < 0 ? 'from now' : 'ago';

  if (absDays === 0) return diff < 0 ? 'later today' : 'today';
  if (absDays === 1) return diff < 0 ? 'tomorrow' : 'yesterday';
  if (absDays < 30) return `${absDays} days ${suffix}`;

  const months = Math.floor(absDays / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ${suffix}`;

  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? 'year' : 'years'} ${suffix}`;
}
