export type JellyfinUserPolicy = {
  IsAdministrator?: boolean;
  EnableMediaPlayback?: boolean;
};

export type JellyfinUser = {
  Id: string;
  Name: string;
  Policy?: JellyfinUserPolicy;
};

export type AuthResult = {
  User: JellyfinUser;
  AccessToken: string;
  ServerId: string;
};

export type PublicServerInfo = {
  LocalAddress?: string;
  ServerName?: string;
  Version?: string;
  ProductName?: string;
  Id?: string;
  StartupWizardCompleted?: boolean;
};

export type JellyfinPlugin = {
  Name: string;
  Version?: string;
  Status?: string;
};

export type JellyfinLibrary = {
  Id: string;
  Name: string;
  CollectionType?: string;
  Type?: string;
  ChildCount?: number;
  ImageTags?: Record<string, string>;
};

export type ContentKind = 'video' | 'movie' | 'musicVideo';

export type SelectedLibrary = {
  id: string;
  name: string;
  collectionType: string;
  itemTypes: string;
  contentKind: ContentKind;
};

export type JellyfinUserData = {
  PlaybackPositionTicks?: number;
  PlayCount?: number;
  IsFavorite?: boolean;
  LastPlayedDate?: string;
  Played?: boolean;
  PlayedPercentage?: number;
  ItemId?: string;
};

export type JellyfinMediaStream = {
  Type?: 'Video' | 'Audio' | 'Subtitle';
  Codec?: string;
  Width?: number;
  Height?: number;
  BitRate?: number;
  Index?: number;
  IsDefault?: boolean;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  IsExternal?: boolean;
  IsTextSubtitleStream?: boolean;
  SupportsExternalStream?: boolean;
  IsForced?: boolean;
  DeliveryMethod?: 'External' | 'Embed' | 'Encode' | string;
  DeliveryUrl?: string;
};

export type JellyfinMediaSource = {
  Id: string;
  Container?: string;
  Bitrate?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  RunTimeTicks?: number;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  MediaStreams?: JellyfinMediaStream[];
};

export type JellyfinItem = {
  Id: string;
  Name: string;
  Type: 'Video' | 'Episode' | string;
  DateCreated?: string;
  PremiereDate?: string;
  EndDate?: string;
  Overview?: string;
  Container?: string;
  RunTimeTicks?: number;
  ProductionYear?: number;
  OfficialRating?: string;
  CommunityRating?: number;
  Status?: string;
  ChildCount?: number;
  RecursiveItemCount?: number;
  ParentId?: string;
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Genres?: string[];
  Tags?: string[];
  Artists?: string[];
  ArtistItems?: Array<{ Id?: string; Name: string }>;
  Studios?: Array<{ Id?: string; Name: string }>;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  PrimaryImageAspectRatio?: number;
  UserData?: JellyfinUserData;
  MediaSources?: JellyfinMediaSource[];
  sourceLibraryId?: string;
  sourceLibraryName?: string;
  sourceCollectionType?: string;
  contentKind?: ContentKind;
};

export type ItemResponse = {
  Items: JellyfinItem[];
  TotalRecordCount: number;
  StartIndex?: number;
};

export type LibraryResponse = {
  Items: JellyfinLibrary[];
  TotalRecordCount: number;
};

export type PlaybackInfo = {
  MediaSources: JellyfinMediaSource[];
  PlaySessionId?: string;
};

export type PlaybackActivity = {
  latest_date?: string;
  user_id?: string;
  total_count?: number;
  total_time?: number;
  item_name?: string;
  client_name?: string;
  user_name?: string;
  total_play_time?: string;
};

export type AppSession = {
  serverUrl: string;
  serverName: string;
  serverVersion?: string;
  accessToken: string;
  userId: string;
  userName: string;
  selectedLibraries: SelectedLibrary[];
  themeMode?: 'system' | 'light' | 'dark';
  selectedLibraryId?: string;
  selectedLibraryName?: string;
  selectedLibraryType?: string;
};
