import type { SearchSuggestion } from './jellyfin';

export const SEARCH_SUGGESTION_DEBOUNCE_MS = 180;

export type SearchSuggestionRoute = string;

export type SearchSuggestionRequest<T> = (query: string, signal: AbortSignal) => Promise<T[]>;

export type SearchSuggestionScheduleOptions<T> = {
  query: string;
  route: SearchSuggestionRoute;
  request: SearchSuggestionRequest<T>;
  onResults: (items: T[]) => void;
  onClear: () => void;
  delayMs?: number;
};

export function shouldFetchSearchSuggestions(query: string, route: SearchSuggestionRoute) {
  const trimmed = query.trim();
  return trimmed.length >= 2 && (route === 'home' || route === 'search' || route === 'watch');
}

export function suggestionNameLabel(suggestion: Pick<SearchSuggestion, 'name' | 'type' | 'seriesName'>) {
  const parts: string[] = [];
  if (suggestion.seriesName && suggestion.type === 'Episode') {
    parts.push(suggestion.seriesName);
  }
  parts.push(suggestion.name);
  return parts.join(' — ');
}

export function createSearchSuggestionScheduler<T>() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let sequence = 0;

  function cancelPending() {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
    sequence += 1;
  }

  return {
    schedule({ query, route, request, onResults, onClear, delayMs = SEARCH_SUGGESTION_DEBOUNCE_MS }: SearchSuggestionScheduleOptions<T>) {
      const trimmed = query.trim();
      if (!shouldFetchSearchSuggestions(trimmed, route)) {
        cancelPending();
        onClear();
        return;
      }

      cancelPending();
      const requestSequence = sequence;
      controller = new AbortController();
      const signal = controller.signal;

      timer = setTimeout(async () => {
        timer = undefined;
        try {
          const items = await request(trimmed, signal);
          if (!signal.aborted && requestSequence === sequence) {
            onResults(items);
          }
        } catch {
          if (!signal.aborted && requestSequence === sequence) {
            onResults([]);
          }
        }
      }, delayMs);
    },

    cancel() {
      cancelPending();
    }
  };
}
