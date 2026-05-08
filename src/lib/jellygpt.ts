import { channelName, mergeItems, type RankedItem } from './recommendations';
import type { JellyfinItem, PlaybackActivity } from './types';

export type JellyGptRecommendationStatus = 'idle' | 'loading' | 'active' | 'fallback' | 'error';

export type JellyGptRecommendationItem = {
  item_id: string;
  score: number;
  reason?: string | null;
};

export type JellyGptRecommendationResponse = {
  algo: string;
  generated_at?: string | null;
  cache_age_seconds?: number | null;
  items: JellyGptRecommendationItem[];
  warning?: string | null;
};

export type JellyGptBingeContext = {
  channel?: string;
  series_id?: string;
  streak_count: number;
};

export type JellyGptRecommendationRequestOptions = {
  url: string;
  algorithm: string;
  userId?: string;
  candidates: JellyfinItem[];
  activity: PlaybackActivity[];
  recentItemIds: Iterable<string>;
  context?: 'home' | 'movie' | 'music' | 'watch';
  currentItem?: JellyfinItem | null;
  queueItems?: JellyfinItem[];
  limit?: number;
  timeoutMs?: number;
};

export type JellyGptIndexedRecommendationRequestOptions = {
  url: string;
  algorithm: string;
  userId?: string;
  activity?: PlaybackActivity[];
  recentItemIds?: Iterable<string>;
  context?: 'home' | 'movie' | 'music' | 'watch';
  currentItem?: JellyfinItem | null;
  queueItems?: JellyfinItem[];
  binge?: JellyGptBingeContext | null;
  limit?: number;
  timeoutMs?: number;
};

export async function fetchJellyGptRecommendations({
  url,
  algorithm,
  userId,
  candidates,
  activity,
  recentItemIds,
  context,
  currentItem,
  queueItems,
  limit = 50,
  timeoutMs = 3500
}: JellyGptRecommendationRequestOptions): Promise<JellyGptRecommendationResponse> {
  const normalizedUrl = url.trim().replace(/\/+$/, '');
  if (!normalizedUrl) throw new Error('jellyGPT URL is not configured.');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedUrl}/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        algo: algorithm,
        user_id: userId,
        limit,
        now: new Date().toISOString(),
        context,
        current_item: currentItem ? toRecommendationCandidate(currentItem) : undefined,
        candidates: candidates.map(toRecommendationCandidate),
        history: activity.map(toPlaybackHistoryEvent),
        queue_item_ids: queueItems?.map((item) => item.Id),
        recent_item_ids: [...recentItemIds]
      })
    });
    if (!response.ok) throw new Error(`jellyGPT recommendations failed: HTTP ${response.status}`);
    return (await response.json()) as JellyGptRecommendationResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchIndexedJellyGptRecommendations({
  url,
  algorithm,
  userId,
  activity = [],
  recentItemIds = [],
  context,
  currentItem,
  queueItems,
  binge,
  limit = 50,
  timeoutMs = 3500
}: JellyGptIndexedRecommendationRequestOptions): Promise<JellyGptRecommendationResponse> {
  const normalizedUrl = url.trim().replace(/\/+$/, '');
  if (!normalizedUrl) throw new Error('jellyGPT URL is not configured.');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizedUrl}/recommendations/indexed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        algo: algorithm,
        user_id: userId,
        limit,
        now: new Date().toISOString(),
        context,
        current_item_id: currentItem?.Id,
        current_item: currentItem ? toRecommendationCandidate(currentItem) : undefined,
        history: activity.map(toPlaybackHistoryEvent),
        queue_item_ids: queueItems?.map((item) => item.Id),
        recent_item_ids: [...recentItemIds],
        binge: binge ?? undefined
      })
    });
    if (!response.ok) throw new Error(`jellyGPT indexed recommendations failed: HTTP ${response.status}`);
    return (await response.json()) as JellyGptRecommendationResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function applyJellyGptRanking(
  response: JellyGptRecommendationResponse,
  candidates: JellyfinItem[],
  fallback: JellyfinItem[],
  limit: number
): RankedItem[] {
  if (!response.items.length) return fallback.slice(0, limit) as RankedItem[];

  const byId = new Map(candidates.map((item) => [item.Id, item]));
  const ranked: RankedItem[] = [];
  const seen = new Set<string>();

  for (const scored of response.items) {
    const item = byId.get(scored.item_id);
    if (!item || seen.has(item.Id)) continue;
    seen.add(item.Id);
    ranked.push({
      ...item,
      score: scored.score,
      reason: scored.reason ?? 'Recommended by jellyGPT',
      reasons: [scored.reason ?? 'Recommended by jellyGPT']
    });
  }

  for (const item of fallback) {
    if (ranked.length >= limit) break;
    if (seen.has(item.Id)) continue;
    seen.add(item.Id);
    ranked.push(item as RankedItem);
  }

  return ranked.slice(0, limit);
}

export function buildJellyGptCandidatePool(...groups: JellyfinItem[][]) {
  return mergeItems(...groups);
}

function toRecommendationCandidate(item: JellyfinItem) {
  return {
    item_id: item.Id,
    title: item.Name,
    type: item.Type,
    content_kind: item.contentKind,
    channel: channelName(item),
    series_id: item.SeriesId,
    parent_id: item.ParentId,
    genres: item.Genres ?? [],
    date_created: item.DateCreated,
    premiere_date: item.PremiereDate,
    last_played_date: item.UserData?.LastPlayedDate,
    run_time_ticks: item.RunTimeTicks,
    play_count: item.UserData?.PlayCount,
    played: item.UserData?.Played,
    playback_position_ticks: item.UserData?.PlaybackPositionTicks
  };
}

function toPlaybackHistoryEvent(event: PlaybackActivity) {
  return {
    item_name: event.item_name,
    total_count: event.total_count,
    total_time: event.total_time,
    latest_date: event.latest_date
  };
}
