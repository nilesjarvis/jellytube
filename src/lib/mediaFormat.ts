import { sourceVideoRangeType } from './codecSupport';
import type { JellyfinClient } from './jellyfin';
import type {
  ItemResponse,
  JellyfinItem,
  JellyfinMediaSource,
  JellyfinMediaStream
} from './types';

export type SourceMediaFormatBadge = {
  kind: 'dolby-vision' | 'hdr10-plus' | 'hdr10' | 'hlg' | 'hdr';
  label: string;
  detail: string;
};

type MediaFormatClient = Pick<JellyfinClient, 'getItemsWithMediaStreams'>;
type FormatResolver = (format: SourceMediaFormatBadge | null) => void;
type FormatRequestState = {
  cache: Map<string, Promise<SourceMediaFormatBadge | null>>;
  pending: Map<string, FormatResolver>;
  timer: ReturnType<typeof setTimeout> | null;
};

const MEDIA_FORMAT_BATCH_SIZE = 40;
const MEDIA_FORMAT_BATCH_DELAY_MS = 16;
const requestStates = new WeakMap<object, FormatRequestState>();

function playableMediaItem(item: JellyfinItem) {
  return ['Video', 'Episode', 'Movie', 'MusicVideo'].includes(item.Type);
}

function videoStream(streams: JellyfinMediaStream[] | undefined) {
  return streams?.find((stream) => stream.Type === 'Video');
}

function mediaSourceForItem(item: JellyfinItem): JellyfinMediaSource | null {
  const nestedSource = item.MediaSources?.find((source) => videoStream(source.MediaStreams));
  if (nestedSource) return nestedSource;
  if (videoStream(item.MediaStreams)) {
    return { Id: item.Id, MediaStreams: item.MediaStreams };
  }
  return null;
}

export function hasMediaStreamMetadata(item: JellyfinItem) {
  return (
    item.MediaStreams !== undefined ||
    Boolean(item.MediaSources?.some((source) => source.MediaStreams !== undefined))
  );
}

export function sourceMediaFormatBadge(
  item: JellyfinItem
): SourceMediaFormatBadge | null {
  const source = mediaSourceForItem(item);
  const stream = source ? videoStream(source.MediaStreams) : undefined;
  if (!source || !stream) return null;

  const rangeType = sourceVideoRangeType(source);
  const normalized = rangeType.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.startsWith('DOVI')) {
    const profile = stream.DvProfile ? ` Profile ${stream.DvProfile}` : '';
    const compatibleBase =
      stream.DvBlSignalCompatibilityId === 1 || normalized.includes('DOVIWITHHDR10');
    const hdr10Plus = Boolean(stream.Hdr10PlusPresentFlag) || normalized.includes('HDR10PLUS');
    const compatibility = hdr10Plus
      ? ' with HDR10+ metadata'
      : compatibleBase
        ? ' with an HDR10-compatible base layer'
        : '';
    return {
      kind: 'dolby-vision',
      label: 'Dolby Vision',
      detail: `Dolby Vision${profile} source${compatibility}`
    };
  }
  if (normalized.includes('HDR10PLUS')) {
    return { kind: 'hdr10-plus', label: 'HDR10+', detail: 'HDR10+ source' };
  }
  if (normalized.includes('HDR10')) {
    return { kind: 'hdr10', label: 'HDR10', detail: 'HDR10 source' };
  }
  if (normalized.includes('HLG')) {
    return { kind: 'hlg', label: 'HLG', detail: 'HLG HDR source' };
  }
  if (normalized !== 'SDR') {
    return { kind: 'hdr', label: 'HDR', detail: 'HDR source' };
  }
  return null;
}

function requestState(client: MediaFormatClient) {
  let state = requestStates.get(client);
  if (!state) {
    state = { cache: new Map(), pending: new Map(), timer: null };
    requestStates.set(client, state);
  }
  return state;
}

async function resolveFormatBatch(
  client: MediaFormatClient,
  entries: Array<[string, FormatResolver]>
) {
  try {
    const response: ItemResponse = await client.getItemsWithMediaStreams(
      entries.map(([id]) => id)
    );
    const items = new Map((response.Items ?? []).map((item) => [item.Id, item]));
    for (const [id, resolve] of entries) {
      resolve(sourceMediaFormatBadge(items.get(id) ?? { Id: id, Name: '', Type: 'Video' }));
    }
  } catch {
    for (const [, resolve] of entries) resolve(null);
  }
}

async function flushFormatRequests(client: MediaFormatClient, state: FormatRequestState) {
  state.timer = null;
  const entries = [...state.pending.entries()];
  state.pending.clear();
  const batches: Array<Array<[string, FormatResolver]>> = [];
  for (let index = 0; index < entries.length; index += MEDIA_FORMAT_BATCH_SIZE) {
    batches.push(entries.slice(index, index + MEDIA_FORMAT_BATCH_SIZE));
  }
  await Promise.all(batches.map((batch) => resolveFormatBatch(client, batch)));
}

export function getCachedSourceMediaFormat(
  client: MediaFormatClient,
  item: JellyfinItem
): Promise<SourceMediaFormatBadge | null> {
  const inlineFormat = sourceMediaFormatBadge(item);
  if (inlineFormat || hasMediaStreamMetadata(item) || !playableMediaItem(item)) {
    return Promise.resolve(inlineFormat);
  }

  const state = requestState(client);
  const cached = state.cache.get(item.Id);
  if (cached) return cached;

  const request = new Promise<SourceMediaFormatBadge | null>((resolve) => {
    state.pending.set(item.Id, resolve);
    if (state.timer === null) {
      state.timer = setTimeout(() => {
        void flushFormatRequests(client, state);
      }, MEDIA_FORMAT_BATCH_DELAY_MS);
    }
  });
  state.cache.set(item.Id, request);
  return request;
}
