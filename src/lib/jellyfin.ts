import type {
  AuthResult,
  ItemResponse,
  JellyfinItem,
  JellyfinPerson,
  JellyfinLibrary,
  JellyfinMediaSource,
  JellyfinUser,
  LibraryResponse,
  PlaybackActivity,
  PlaybackInfo,
  PublicServerInfo
} from './types';
import type { ContentKind, SelectedLibrary } from './types';
import { detectDirectPlayCodecs, type DirectPlayCodecs } from './codecSupport';

const CLIENT_NAME = 'JellyTube';
const CLIENT_VERSION = '0.1.0';
const DEVICE_ID_KEY = 'jellytube.deviceId.v1';

export class JellyfinError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JellyfinError';
    this.status = status;
  }
}

export function normalizeServerUrl(input: string) {
  const withProtocol = /^https?:\/\//i.test(input.trim())
    ? input.trim()
    : `http://${input.trim()}`;
  return withProtocol.replace(/\/+$/, '');
}

export function assertUserCanPlayMedia(user: JellyfinUser) {
  if (user.Policy?.EnableMediaPlayback === false) {
    throw new JellyfinError('This Jellyfin account is not allowed to play media.');
  }
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      // Fallback for non-HTTPS local network access where crypto.randomUUID is unavailable
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function isEligibleLibrary(library: JellyfinLibrary) {
  return Boolean(libraryToSelectedSource(library));
}

export function libraryKindLabel(collectionType?: string) {
  if (collectionType === 'tvshows') return 'Shows';
  if (collectionType === 'homevideos') return 'Home Videos & Photos';
  if (collectionType === 'movies') return 'Movies';
  if (collectionType === 'musicvideos') return 'Music Videos';
  return 'Library';
}

export function libraryToSelectedSource(library: JellyfinLibrary): SelectedLibrary | null {
  const collectionType = library.CollectionType ?? '';
  const contentKind = contentKindForCollection(collectionType);
  if (!contentKind) return null;
  return {
    id: library.Id,
    name: library.Name,
    collectionType,
    contentKind,
    itemTypes: itemTypesForCollection(collectionType)
  };
}

export function contentKindForCollection(collectionType?: string): ContentKind | null {
  if (collectionType === 'tvshows' || collectionType === 'homevideos') return 'video';
  if (collectionType === 'movies') return 'movie';
  if (collectionType === 'musicvideos') return 'musicVideo';
  return null;
}

export function itemTypesForCollection(collectionType?: string) {
  if (collectionType === 'movies') return 'Movie';
  if (collectionType === 'musicvideos') return 'MusicVideo';
  return 'Video,Episode';
}

export function annotateItems(items: JellyfinItem[], source: SelectedLibrary) {
  return items.map((item) => ({
    ...item,
    sourceLibraryId: source.id,
    sourceLibraryName: source.name,
    sourceCollectionType: source.collectionType,
    contentKind: source.contentKind
  }));
}

const itemFields = [
  'PrimaryImageAspectRatio',
  'BackdropImageTags',
  'Overview',
  'DateCreated',
  'PremiereDate',
  'EndDate',
  'Genres',
  'Tags',
  'Studios',
  'ProviderIds',
  'Artists',
  'ArtistItems',
  'SeriesName',
  'SeriesId',
  'SeasonName',
  'SeasonId',
  'IndexNumber',
  'ParentIndexNumber',
  'ParentId',
  'UserData',
  'RunTimeTicks',
  'ProductionYear',
  'OfficialRating',
  'CommunityRating',
  'Status',
  'ChildCount',
  'RecursiveItemCount',
  'Container'
].join(',');

export type ItemQuery = {
  parentId: string;
  itemTypes?: string;
  limit?: number;
  startIndex?: number;
  sortBy?: string;
  sortOrder?: 'Ascending' | 'Descending';
  searchTerm?: string;
  filters?: string;
  personIds?: string;
};

export type SearchSuggestion = {
  id: string;
  name: string;
  type: string;
  seriesName?: string;
  imageTag?: string;
  productionYear?: number;
  parentId: string;
  sourceId?: string;
  sourceName?: string;
};

export type HlsStreamOptions = {
  startTicks?: number;
  playSessionId?: string;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  maxWidth?: number;
  maxHeight?: number;
  videoBitrate?: number;
  audioBitrate?: number;
};

export class JellyfinClient {
  serverUrl: string;
  accessToken?: string;
  userId?: string;
  deviceId = getDeviceId();

  constructor(serverUrl: string, accessToken?: string, userId?: string) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.accessToken = accessToken;
    this.userId = userId;
  }

  withAuth(accessToken: string, userId: string) {
    return new JellyfinClient(this.serverUrl, accessToken, userId);
  }

  async getPublicInfo() {
    return this.get<PublicServerInfo>('/System/Info/Public', undefined, false);
  }

  async authenticate(username: string, password: string) {
    return this.post<AuthResult>(
      '/Users/AuthenticateByName',
      {
        Username: username,
        Pw: password
      },
      undefined,
      false
    );
  }

  async getViews(userId: string) {
    return this.get<LibraryResponse>(`/Users/${userId}/Views`);
  }

  async getItems(query: ItemQuery) {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    return this.get<ItemResponse>(`/Users/${this.userId}/Items`, {
      ParentId: query.parentId,
      Recursive: 'true',
      IncludeItemTypes: query.itemTypes ?? 'Video,Episode',
      Fields: itemFields,
      SortBy: query.sortBy ?? 'DateCreated',
      SortOrder: query.sortOrder ?? 'Descending',
      Limit: String(query.limit ?? 60),
      StartIndex: String(query.startIndex ?? 0),
      ...(query.searchTerm ? { SearchTerm: query.searchTerm } : {}),
      ...(query.filters ? { Filters: query.filters } : {}),
      ...(query.personIds ? { PersonIds: query.personIds } : {})
    });
  }

  async getSearchSuggestions(
    sources: { id: string; itemTypes: string; name?: string; contentKind?: string }[],
    searchTerm: string,
    limit = 8,
    signal?: AbortSignal
  ): Promise<SearchSuggestion[]> {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    if (!searchTerm || searchTerm.length < 2) return [];

    const suggestionFields = [
      'SeriesName',
      'ProductionYear',
      'ImageTags'
    ].join(',');

    const responses = await Promise.allSettled(
      sources.map((source) =>
        this.get<ItemResponse>(`/Users/${this.userId}/Items`, {
          ParentId: source.id,
          Recursive: 'true',
          IncludeItemTypes: source.itemTypes,
          Fields: suggestionFields,
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          Limit: String(limit),
          SearchTerm: searchTerm
        }, true, signal)
      )
    );

    const seen = new Set<string>();
    const suggestions: SearchSuggestion[] = [];

    for (let i = 0; i < responses.length; i += 1) {
      const result = responses[i];
      if (result.status !== 'fulfilled') continue;
      const source = sources[i];
      for (const item of result.value.Items ?? []) {
        const key = normalizeSuggestionKey(item.Name, item.SeriesName, item.Type);
        if (suggestions.length >= limit * 2) break;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({
          id: item.Id,
          name: item.Name,
          type: item.Type,
          seriesName: item.SeriesName,
          imageTag: item.ImageTags?.Primary,
          productionYear: item.ProductionYear,
          parentId: item.ParentId ?? '',
          sourceId: source.id,
          sourceName: source.name
        });
      }
    }

    return suggestions.slice(0, limit);
  }

  async getItem(itemId: string) {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    return this.get<JellyfinItem>(`/Users/${this.userId}/Items/${itemId}`, {
      Fields: `${itemFields},People,MediaSources`
    });
  }

  async getSimilarItems(itemId: string, limit = 48): Promise<ItemResponse> {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    return this.get<ItemResponse>(`/Items/${itemId}/Similar`, {
      userId: this.userId,
      Fields: itemFields,
      Limit: String(limit)
    });
  }

  async getSeriesEpisodes(seriesId: string) {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    return this.get<ItemResponse>(`/Shows/${seriesId}/Episodes`, {
      userId: this.userId,
      Fields: itemFields
    });
  }

  async getPlaybackInfo(itemId: string, positionTicks = 0, audioStreamIndex?: number) {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    return this.post<PlaybackInfo>(
      `/Items/${itemId}/PlaybackInfo`,
      {
        DeviceProfile: browserDeviceProfile(),
        MaxStreamingBitrate: 140_000_000,
        ...(audioStreamIndex !== undefined && audioStreamIndex >= 0
          ? { AudioStreamIndex: audioStreamIndex }
          : {})
      },
      {
        userId: this.userId,
        StartTimeTicks: String(positionTicks),
        IsPlayback: 'true',
        AutoOpenLiveStream: 'true',
        MaxStreamingBitrate: '140000000'
      }
    );
  }

  async getPreviewPlaybackInfo(itemId: string) {
    if (!this.userId) throw new JellyfinError('Missing Jellyfin user id');
    const previewBitrate = 3_000_000;
    return this.post<PlaybackInfo>(
      `/Items/${itemId}/PlaybackInfo`,
      {
        DeviceProfile: browserDeviceProfile(previewBitrate),
        MaxStreamingBitrate: previewBitrate
      },
      {
        userId: this.userId,
        StartTimeTicks: '0',
        IsPlayback: 'false',
        AutoOpenLiveStream: 'false',
        MaxStreamingBitrate: String(previewBitrate)
      }
    );
  }

  async getPlaybackActivity(days = 365) {
    const timezoneOffset = new Date().getTimezoneOffset();
    return this.get<PlaybackActivity[]>('/user_usage_stats/user_activity', {
      days: String(days),
      timezoneOffset: String(timezoneOffset)
    });
  }

  async reportPlaybackStart(payload: PlaybackEventPayload) {
    return this.post<void>('/Sessions/Playing', payload);
  }

  async reportPlaybackProgress(payload: PlaybackEventPayload & { EventName?: string }) {
    return this.post<void>('/Sessions/Playing/Progress', payload);
  }

  async reportPlaybackStopped(payload: PlaybackEventPayload) {
    return this.post<void>('/Sessions/Playing/Stopped', payload);
  }

  getImageUrl(item: Pick<JellyfinItem, 'Id' | 'ImageTags'>, width = 640) {
    if (!item.ImageTags?.Primary) return '';
    return this.url('/Items/' + item.Id + '/Images/Primary', {
      fillWidth: String(width),
      quality: '90',
      api_key: this.accessToken ?? ''
    });
  }

  getPersonImageUrl(person: JellyfinPerson, width = 640) {
    if (!person.Id || !person.PrimaryImageTag) return '';
    return this.url('/Items/' + person.Id + '/Images/Primary', {
      fillWidth: String(width),
      quality: '90',
      api_key: this.accessToken ?? ''
    });
  }

  getBackdropUrl(item: Pick<JellyfinItem, 'Id' | 'BackdropImageTags'>, width = 1280) {
    if (!item.BackdropImageTags?.length) return '';
    return this.url('/Items/' + item.Id + '/Images/Backdrop/0', {
      fillWidth: String(width),
      quality: '88',
      api_key: this.accessToken ?? ''
    });
  }

  getStreamUrl(itemId: string, mediaSourceId: string, container = 'mp4') {
    const extension = container.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    return this.url(`/Videos/${itemId}/stream.${extension}`, {
      static: 'true',
      mediaSourceId,
      api_key: this.accessToken ?? ''
    });
  }

  getSubtitleStreamUrl(itemId: string, mediaSourceId: string, streamIndex: number, format = 'vtt') {
    const extension = format.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'vtt';
    return this.url(`/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/0/Stream.${extension}`, {
      api_key: this.accessToken ?? ''
    });
  }

  getHlsUrl(itemId: string, mediaSourceId: string, options: HlsStreamOptions = {}) {
    return this.url(`/Videos/${itemId}/master.m3u8`, {
      MediaSourceId: mediaSourceId,
      PlaySessionId: options.playSessionId ?? '',
      StartTimeTicks: options.startTicks ? String(options.startTicks) : '',
      AudioStreamIndex:
        options.audioStreamIndex !== undefined && options.audioStreamIndex >= 0
          ? String(options.audioStreamIndex)
          : '',
      SubtitleStreamIndex:
        options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex >= 0
          ? String(options.subtitleStreamIndex)
          : '',
      api_key: this.accessToken ?? '',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      VideoBitrate: String(options.videoBitrate ?? 12_000_000),
      AudioBitrate: String(options.audioBitrate ?? 192_000),
      MaxWidth: options.maxWidth ? String(options.maxWidth) : '',
      MaxHeight: options.maxHeight ? String(options.maxHeight) : '',
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '2',
      BreakOnNonKeyFrames: 'True'
    });
  }

  private async get<T>(
    path: string,
    params?: Record<string, string>,
    authenticated = true,
    signal?: AbortSignal
  ) {
    return this.request<T>('GET', path, undefined, params, authenticated, signal);
  }

  private async post<T>(
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    authenticated = true,
    signal?: AbortSignal
  ) {
    return this.request<T>('POST', path, body, params, authenticated, signal);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    authenticated = true,
    signal?: AbortSignal
  ) {
    const response = await fetch(this.url(path, params), {
      method,
      headers: this.headers(authenticated),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new JellyfinError(
        text || `${method} ${path} failed with ${response.status}`,
        response.status
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private headers(authenticated: boolean) {
    const auth = `MediaBrowser Client="${CLIENT_NAME}", Device="Browser", DeviceId="${this.deviceId}", Version="${CLIENT_VERSION}"`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': auth
    };
    if (authenticated && this.accessToken) {
      headers['X-Emby-Token'] = this.accessToken;
    }
    return headers;
  }

  private url(path: string, params?: Record<string, string>) {
    const url = new URL(path, this.serverUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== '') url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

export type PlaybackEventPayload = {
  ItemId: string;
  MediaSourceId?: string;
  PlaySessionId?: string;
  PositionTicks: number;
  CanSeek: boolean;
  IsPaused: boolean;
  IsMuted: boolean;
  VolumeLevel: number;
  PlayMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
  RepeatMode: 'RepeatNone';
  PlaybackStartTimeTicks?: number;
  AudioStreamIndex?: number;
  SubtitleStreamIndex?: number;
};

function directPlayProfilesFor(codecs: DirectPlayCodecs) {
  const profiles: Array<{ Container: string; Type: 'Video'; VideoCodec: string; AudioCodec: string }> = [];

  const mp4Codecs = [codecs.h264 ? 'h264' : '', codecs.hevc ? 'hevc' : ''].filter(Boolean).join(',');
  if (mp4Codecs) {
    profiles.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: mp4Codecs, AudioCodec: 'aac,mp3' });
  }
  // AV1 in mp4 may carry opus/flac audio in addition to the usual aac/mp3.
  if (codecs.av1) {
    profiles.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'av1', AudioCodec: 'aac,mp3,opus,flac' });
  }

  const webmCodecs = [codecs.vp8 ? 'vp8' : '', codecs.vp9 ? 'vp9' : '', codecs.av1 ? 'av1' : '']
    .filter(Boolean)
    .join(',');
  if (webmCodecs) {
    profiles.push({ Container: 'webm', Type: 'Video', VideoCodec: webmCodecs, AudioCodec: 'vorbis,opus' });
  }

  // If capability detection yields nothing (e.g. no DOM), fall back to the historically
  // safe baseline so playback still works via direct play or the transcode profile.
  if (profiles.length === 0) {
    profiles.push(
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9', AudioCodec: 'vorbis,opus' }
    );
  }

  return profiles;
}

export function browserDeviceProfile(
  maxStreamingBitrate = 140_000_000,
  codecs: DirectPlayCodecs = detectDirectPlayCodecs()
) {
  return {
    MaxStreamingBitrate: maxStreamingBitrate,
    DirectPlayProfiles: directPlayProfilesFor(codecs),
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        AudioCodec: 'aac,mp3',
        VideoCodec: 'h264',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: '2',
        BreakOnNonKeyFrames: true
      }
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }]
  };
}

function normalizeSuggestionKey(name: string, seriesName?: string, type?: string) {
  return [
    (name ?? '').toLowerCase().replace(/\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(),
    (seriesName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    type ?? ''
  ].filter(Boolean).join('||');
}
