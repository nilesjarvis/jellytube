<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import {
    Clapperboard,
    Home,
    Library,
    ListVideo,
    LogOut,
    Menu,
    Moon,
    Music2,
    Play,
    RotateCcw,
    Search,
    Server,
    SlidersHorizontal,
    Sun,
    UserCircle
  } from 'lucide-svelte';
  import { channelDirectoryEntries, filterChannelDirectory } from '../lib/channelDirectory';
  import {
    annotateItems,
    contentKindForCollection,
    isEligibleLibrary,
    JellyfinClient,
    libraryKindLabel,
    libraryToSelectedSource
  } from '../lib/jellyfin';
  import {
    episodeCode,
    episodeCollectionForItem,
    episodeInfo,
    sameEpisodeSeries,
    type EpisodeSeason
  } from '../lib/episodes';
  import { compareByContentDateDesc, contentDate, contentDateValue, dateValue, relativeDate } from '../lib/dates';
  import {
    fetchIndexedJellyGptRecommendations,
    type JellyGptBingeContext,
    type JellyGptRecommendationResponse,
    type JellyGptRecommendationStatus
  } from '../lib/jellygpt';
  import {
    channelMatches,
    channelName,
    compactMeta,
    continueWatching,
    displayTitle,
    formatDuration,
    groupByChannel,
    mergeItems,
    popularItems,
    playbackProgress,
    rankRecommendations,
    type RankedItem
  } from '../lib/recommendations';
  import { normalizeSearch, rankSearchResults, searchLoadedItems } from '../lib/search';
  import { saveSession } from '../lib/session';
  import { showProgressForEpisodes, type ShowProgress } from '../lib/showProgress';
  import type {
    AppSession,
    ContentKind,
    JellyfinItem,
    PlaybackActivity,
    SelectedLibrary
  } from '../lib/types';
  import SkeletonLibraryGrid from './SkeletonLibraryGrid.svelte';
  import SkeletonRoute from './SkeletonRoute.svelte';
  import VideoCard from './VideoCard.svelte';
  import WatchPage from './WatchPage.svelte';

  export let session: AppSession;

  type Route = 'home' | 'watch' | 'search' | 'movies' | 'music' | 'subscriptions' | 'channel' | 'libraries';
  type ThemeMode = 'system' | 'light' | 'dark';
  type EffectiveTheme = 'light' | 'dark';
  type UrlRoute =
    | { view: 'home' }
    | { view: 'movies' }
    | { view: 'music' }
    | { view: 'subscriptions' }
    | { view: 'libraries' }
    | { view: 'search'; query: string }
    | { view: 'channel'; channel: string }
    | { view: 'watch'; itemId: string; list?: 'mix'; channel?: string };
  type HistoryMode = 'push' | 'replace' | 'none';
  type JellyGptAlgorithm = {
    id: string;
    name: string;
    available: boolean;
    reason?: string | null;
  };

  const FALLBACK_JELLYGPT_ALGORITHMS: JellyGptAlgorithm[] = [
    { id: 'existing_logic_like', name: 'Existing JellyTube', available: true },
    { id: 'recency_popularity', name: 'Recency / Popularity', available: true },
    { id: 'label_profile', name: 'Label Profile', available: true },
    { id: 'blended', name: 'Blended', available: true },
    { id: 'llm_rerank', name: 'AI Rerank', available: false, reason: 'Requires Ollama reranking in jellyGPT.' }
  ];
  const WATCH_RECOMMENDATION_LIMIT = 28;

  const dispatch = createEventDispatcher<{ logout: void }>();
  const client = new JellyfinClient(session.serverUrl, session.accessToken, session.userId);

  let loading = true;
  let error = '';
  let menuOpen = false;
  let route: Route = 'home';
  let query = '';
  let searchedFor = '';
  let selectedItem: JellyfinItem | null = null;
  let selectedQueue: JellyfinItem[] = [];
  let selectedQueueName = '';
  let selectedEpisodeSeason = 0;
  let selectedChannelSeason = 0;
  let shouldAutoplay = false;
  let selectedChannel = '';
  let channelDirectoryQuery = '';
  let availableLibraries: SelectedLibrary[] = [];
  let librarySelectionIds: string[] = [];
  let librarySettingsLoading = false;
  let librarySettingsError = '';
  let routeHistoryIndex = Number(window.history.state?.jellytubeIndex ?? 0) || 0;
  let themeMode: ThemeMode =
    (localStorage.getItem('jellytube.theme') as ThemeMode | null) ?? session.themeMode ?? 'system';
  let effectiveTheme: EffectiveTheme = resolveEffectiveTheme(themeMode);
  let jellyGptPanelOpen = false;
  let jellyGptUrl = localStorage.getItem('jellytube.jellygpt.url') ?? 'http://127.0.0.1:8787';
  let jellyGptEnabled = localStorage.getItem('jellytube.jellygpt.enabled') === 'true';
  let jellyGptStatus: 'unconfigured' | 'checking' | 'connected' | 'error' = jellyGptEnabled
    ? 'checking'
    : 'unconfigured';
  let jellyGptStatusMessage = jellyGptEnabled ? 'Checking jellyGPT…' : 'Connect jellyGPT for cached AI recommendations.';
  let jellyGptVersion = '';
  let jellyGptAlgorithms: JellyGptAlgorithm[] = FALLBACK_JELLYGPT_ALGORITHMS;
  let jellyGptSelectedAlgorithm = localStorage.getItem('jellytube.jellygpt.algorithm') ?? 'blended';
  let jellyGptAlgorithmsLoading = false;
  let jellyGptRecommendationStatus: JellyGptRecommendationStatus = 'idle';
  let jellyGptRecommendationMessage = 'Built-in recommendations active.';
  let jellyGptLastRecommendationAt = '';

  let recent: JellyfinItem[] = [];
  let resume: JellyfinItem[] = [];
  let latestAdded: JellyfinItem[] = [];
  let recommended: JellyfinItem[] = [];
  let popular: JellyfinItem[] = [];
  let movies: JellyfinItem[] = [];
  let movieResume: JellyfinItem[] = [];
  let moviePopular: JellyfinItem[] = [];
  let musicVideos: JellyfinItem[] = [];
  let musicRecommended: JellyfinItem[] = [];
  let searchResults: JellyfinItem[] = [];
  let libraryPool: JellyfinItem[] = [];
  let videoPool: JellyfinItem[] = [];
  let moviePool: JellyfinItem[] = [];
  let musicPool: JellyfinItem[] = [];
  let seriesPool: JellyfinItem[] = [];
  let seriesEpisodeCache: Record<string, JellyfinItem[]> = {};
  let channelLoading = false;
  let activity: PlaybackActivity[] = [];
  let recentPlaybackIds: string[] = [];
  let watchRecommendations: JellyfinItem[] = [];
  let watchRecommendationContextKey = '';
  let watchRecommendationRequestId = 0;
  let indexedRecommendationCache: Record<string, JellyfinItem> = {};

  function displayChannelSeasons(seasons: EpisodeSeason[]) {
    if (seasons.length < 10) return seasons;
    const positiveSeasons = seasons.filter((season) => season.season > 0);
    const maxSeason = Math.max(...positiveSeasons.map((season) => season.season));
    const outlierThreshold = positiveSeasons.length + 20;
    if (maxSeason <= outlierThreshold) return seasons;
    const filtered = seasons.filter((season) => season.season <= outlierThreshold);
    return filtered.length ? filtered : seasons;
  }

  $: videoSources = session.selectedLibraries.filter((source) => source.contentKind === 'video');
  $: movieSources = session.selectedLibraries.filter((source) => source.contentKind === 'movie');
  $: musicSources = session.selectedLibraries.filter((source) => source.contentKind === 'musicVideo');
  $: channelItems = selectedChannel ? searchPool.filter((item) => channelMatches(item, selectedChannel)) : [];
  $: channelLatest = [...channelItems].sort(
    (a, b) => contentDateValue(b) - contentDateValue(a)
  );
  $: channelPopular = popularItems(channelLatest);
  $: channelEpisodeCollection = selectedChannel ? episodeCollectionForChannel(selectedChannel, searchPool) : null;
  $: channelMixItems = channelEpisodeCollection?.allItems ?? channelLatest;
  $: channelSeries = findChannelSeries(selectedChannel, channelEpisodeCollection?.seriesKey ?? '');
  $: channelDisplaySeasons = displayChannelSeasons(channelEpisodeCollection?.seasons ?? []);
  $: channelBrowsableEpisodes = channelDisplaySeasons.flatMap((season) => season.items);
  $: channelShowProgress = channelEpisodeCollection
    ? showProgressForEpisodes(channelBrowsableEpisodes.length ? channelBrowsableEpisodes : channelEpisodeCollection.allItems)
    : null;
  $: channelFirstEpisode = channelBrowsableEpisodes[0] ?? channelEpisodeCollection?.allItems[0] ?? null;
  $: channelLatestEpisode = latestShowEpisode(
    channelBrowsableEpisodes,
    channelEpisodeCollection?.allItems ?? []
  );
  $: channelHeroItem = channelSeries ?? channelShowProgress?.primaryItem ?? channelLatestEpisode ?? channelItems[0] ?? null;
  $: channelHeroMeta = showHeroMeta(
    channelSeries,
    channelEpisodeCollection?.allItems.length ?? channelItems.length,
    channelEpisodeCollection?.seasons.length ?? 0
  );
  $: channelHeroTags = showHeroTags(channelSeries);
  $: channelHeroBackdropStyle = showBackdropStyle(channelSeries ?? channelLatestEpisode ?? channelItems[0] ?? null);
  $: channelProgressStyle = `--show-progress: ${channelShowProgress?.progressPercent ?? 0}%;`;
  $: activeChannelSeason =
    (channelDisplaySeasons.some((season) => season.season === selectedChannelSeason)
      ? selectedChannelSeason
      : 0) ||
    channelDisplaySeasons[channelDisplaySeasons.length - 1]?.season ||
    0;
  $: channelSeasonItems =
    channelDisplaySeasons.find((season) => season.season === activeChannelSeason)?.items ?? [];
  $: musicMixes = groupByChannel(musicPool).filter((mix) => mix.items.length > 1).slice(0, 8);
  $: episodePool = mergeItems(videoPool, ...Object.values(seriesEpisodeCache));
  $: searchPool = mergeItems(libraryPool, ...Object.values(seriesEpisodeCache));
  $: channelDirectoryPool = searchPool.filter((item) => item.contentKind !== 'movie' && item.Type !== 'Movie');
  $: channelDirectory = channelDirectoryEntries(channelDirectoryPool, seriesPool);
  $: filteredChannelDirectory = filterChannelDirectory(channelDirectory, channelDirectoryQuery);
  $: channelDirectoryFilterActive = channelDirectoryQuery.trim().length > 0;
  $: showDirectory = filteredChannelDirectory.filter((entry) => entry.kind === 'show').slice(0, 180);
  $: creatorDirectory = filteredChannelDirectory.filter((entry) => entry.kind !== 'show').slice(0, 180);
  $: latestDirectoryVideos = [...channelDirectoryPool].sort(compareByContentDateDesc).slice(0, 48);
  $: episodeCollection = selectedItem ? episodeCollectionForItem(selectedItem, episodePool) : null;
  $: watchQueue = episodeCollection ? episodeCollection.allItems : selectedQueue;
  $: watchQueueTitle = episodeCollection ? episodeCollection.seriesName : selectedQueueName;
  $: activeEpisodeSeason =
    episodeCollection && selectedEpisodeSeason
      ? selectedEpisodeSeason
      : episodeCollection?.currentSeason ?? 0;
  $: featuredMovie = movieResume[0] ?? moviePopular[0] ?? movies[0] ?? null;
  $: {
    const item = selectedItem;
    const queue = watchQueue;
    const contextKey = [
      route,
      item?.Id ?? '',
      itemIdsKey(queue),
      itemIdsKey(videoPool),
      itemIdsKey(moviePool),
      itemIdsKey(musicPool),
      playbackActivityKey(activity),
      recentPlaybackIds.join(','),
      jellyGptEnabled ? 'enabled' : 'disabled',
      jellyGptStatus,
      jellyGptSelectedAlgorithm,
      jellyGptUrl
    ].join('|');
    syncWatchRecommendations(route, item, queue, contextKey);
  }

  $: {
    if (route === 'watch' && selectedItem) {
      document.title = `${displayTitle(selectedItem)} - JellyTube`;
    } else if (route === 'channel' && selectedChannel) {
      document.title = `${selectedChannel} - JellyTube`;
    } else if (route === 'search' && searchedFor) {
      document.title = `${searchedFor} - JellyTube`;
    } else if (route === 'movies') {
      document.title = 'Movies - JellyTube';
    } else if (route === 'music') {
      document.title = 'Music - JellyTube';
    } else if (route === 'subscriptions') {
      document.title = 'Subscriptions - JellyTube';
    } else if (route === 'home') {
      document.title = 'Home - JellyTube';
    } else {
      document.title = 'JellyTube';
    }
  }

  onMount(() => {
    applyTheme();
    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      if (themeMode === 'system') applyTheme();
    };
    colorSchemeQuery.addEventListener('change', handleSystemThemeChange);
    window.addEventListener('popstate', handlePopState);
    document.addEventListener('pointerdown', handleJellyGptOutsidePointerDown);
    void initializeApp();
    if (jellyGptEnabled) void checkJellyGptConnection();
    void loadJellyGptAlgorithms();
    return () => {
      colorSchemeQuery.removeEventListener('change', handleSystemThemeChange);
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('pointerdown', handleJellyGptOutsidePointerDown);
    };
  });

  async function initializeApp() {
    const initialRoute = readUrlRoute();
    await loadAll();
    if (!error) {
      await navigateTo(initialRoute, { history: 'replace', scroll: false });
    }
  }

  async function loadAll() {
    loading = true;
    error = '';
    try {
      const [
        videoRecentByRelease,
        videoRecentByAdded,
        videoResume,
        videoFullByRelease,
        videoFullByAdded,
        videoSeries,
        movieRecent,
        movieResumeItems,
        movieFull,
        musicRecentByRelease,
        musicRecentByAdded,
        musicFull,
        activityResponse
      ] =
        await Promise.all([
          fetchSources(videoSources, { limit: 80, sortBy: 'PremiereDate', sortOrder: 'Descending' }),
          fetchSources(videoSources, { limit: 80, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          fetchSources(videoSources, { limit: 48, sortBy: 'DatePlayed', sortOrder: 'Descending', filters: 'IsResumable' }),
          fetchSources(videoSources, { limit: 320, sortBy: 'PremiereDate', sortOrder: 'Descending' }),
          fetchSources(videoSources, { limit: 260, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          fetchSeriesSources(videoSources),
          fetchSources(movieSources, { limit: 80, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          fetchSources(movieSources, { limit: 48, sortBy: 'DatePlayed', sortOrder: 'Descending', filters: 'IsResumable' }),
          fetchSources(movieSources, { limit: 220, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          fetchSources(musicSources, { limit: 100, sortBy: 'PremiereDate', sortOrder: 'Descending' }),
          fetchSources(musicSources, { limit: 100, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          fetchSources(musicSources, { limit: 260, sortBy: 'DateCreated', sortOrder: 'Descending' }),
          client.getPlaybackActivity(365).catch(() => [])
        ]);

      activity = activityResponse;
      seriesPool = videoSeries;
      videoPool = mergeItems(videoRecentByRelease, videoRecentByAdded, videoResume, videoFullByRelease, videoFullByAdded);
      moviePool = mergeItems(movieRecent, movieResumeItems, movieFull);
      musicPool = mergeItems(musicRecentByRelease, musicRecentByAdded, musicFull);
      libraryPool = mergeItems(videoPool, moviePool, musicPool);

      recent = mergeItems(videoRecentByRelease, videoRecentByAdded).sort(compareByContentDateDesc).slice(0, 80);
      if (!recent.length) recent = mergeItems(musicRecentByRelease, musicRecentByAdded).sort(compareByContentDateDesc).slice(0, 80);
      latestAdded = mergeItems(videoFullByAdded, movieFull, musicFull)
        .sort((a, b) => dateValue(b.DateCreated) - dateValue(a.DateCreated))
        .slice(0, 48);
      resume = continueWatching(mergeItems(videoResume, videoPool, musicPool)).slice(0, 24);
      recommended = rankRecommendations(mergeItems(videoPool, musicPool), {
        activity,
        mode: 'home',
        recentItemIds: recentPlaybackIds
      }).slice(0, 48);
      popular = popularItems(mergeItems(videoPool, musicPool)).slice(0, 24);
      movies = movieRecent;
      movieResume = continueWatching(mergeItems(movieResumeItems, moviePool)).slice(0, 18);
      moviePopular = rankRecommendations(moviePool, {
        activity,
        mode: 'movie',
        recentItemIds: recentPlaybackIds
      }).slice(0, 36);
      musicVideos = mergeItems(musicRecentByRelease, musicRecentByAdded).sort(compareByContentDateDesc).slice(0, 100);
      musicRecommended = rankRecommendations(musicPool, {
        activity,
        mode: 'music',
        recentItemIds: recentPlaybackIds
      }).slice(0, 36);
      void refreshJellyGptRecommendations();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not load Jellyfin libraries.';
    } finally {
      loading = false;
    }
  }

  async function fetchSources(
    sources: SelectedLibrary[],
    queryOptions: {
      limit: number;
      sortBy: string;
      sortOrder: 'Ascending' | 'Descending';
      itemTypes?: string;
      filters?: string;
      searchTerm?: string;
      startIndex?: number;
    }
  ) {
    const responses = await Promise.all(
      sources.map((source) => {
        const { itemTypes, ...itemQueryOptions } = queryOptions;
        return client
          .getItems({
            parentId: source.id,
            ...itemQueryOptions,
            itemTypes: itemTypes ?? source.itemTypes
          })
          .then((response) => annotateItems(response.Items, source))
          .catch(() => []);
      })
    );
    return mergeItems(...responses).sort((a, b) => {
      if (queryOptions.sortBy === 'SortName') return a.Name.localeCompare(b.Name);
      if (queryOptions.sortBy === 'DatePlayed') {
        return dateValue(b.UserData?.LastPlayedDate) - dateValue(a.UserData?.LastPlayedDate);
      }
      if (queryOptions.sortBy === 'DateCreated') {
        return dateValue(b.DateCreated) - dateValue(a.DateCreated);
      }
      return contentDateValue(b) - contentDateValue(a);
    });
  }

  async function fetchSeriesSources(sources: SelectedLibrary[]) {
    const groups = await Promise.all(sources.map((source) => fetchSeriesSource(source)));
    return mergeItems(...groups).sort((a, b) => a.Name.localeCompare(b.Name));
  }

  async function fetchSeriesSource(source: SelectedLibrary) {
    const pageSize = 200;
    const maxSeries = 1200;
    const items: JellyfinItem[] = [];
    for (let startIndex = 0; startIndex < maxSeries; startIndex += pageSize) {
      try {
        const response = await client.getItems({
          parentId: source.id,
          itemTypes: 'Series',
          limit: pageSize,
          startIndex,
          sortBy: 'SortName',
          sortOrder: 'Ascending'
        });
        items.push(...annotateItems(response.Items ?? [], source));
        const total = response.TotalRecordCount ?? items.length;
        if (items.length >= total || (response.Items ?? []).length === 0) break;
      } catch {
        break;
      }
    }
    return items;
  }

  function handlePopState() {
    const stateIndex = Number(window.history.state?.jellytubeIndex);
    if (Number.isFinite(stateIndex)) routeHistoryIndex = stateIndex;
    void navigateTo(readUrlRoute(), { history: 'none', scroll: true });
  }

  async function navigateTo(
    nextRoute: UrlRoute,
    options: { history?: HistoryMode; scroll?: boolean; autoplay?: boolean } = {}
  ) {
    const appliedRoute = await applyRoute(nextRoute, {
      scroll: options.scroll ?? true,
      autoplay: options.autoplay ?? false
    });
    if (options.history !== 'none') {
      writeUrl(appliedRoute, options.history ?? 'push');
    }
  }

  async function applyRoute(
    nextRoute: UrlRoute,
    options: { scroll: boolean; autoplay: boolean }
  ): Promise<UrlRoute> {
    menuOpen = false;

    if (nextRoute.view === 'home') {
      showHome();
      scrollToTop(options.scroll);
      return { view: 'home' };
    }

    if (nextRoute.view === 'movies' || nextRoute.view === 'music' || nextRoute.view === 'subscriptions') {
      showSimpleRoute(nextRoute.view);
      scrollToTop(options.scroll);
      return nextRoute;
    }

    if (nextRoute.view === 'libraries') {
      await showLibrarySettings();
      scrollToTop(options.scroll);
      return nextRoute;
    }

    if (nextRoute.view === 'channel') {
      const channel = nextRoute.channel.trim();
      if (!channel) {
        showHome();
        scrollToTop(options.scroll);
        return { view: 'home' };
      }
      await showChannel(channel);
      scrollToTop(options.scroll);
      return { view: 'channel', channel };
    }

    if (nextRoute.view === 'search') {
      const trimmed = nextRoute.query.trim();
      if (!trimmed) {
        showHome();
        scrollToTop(options.scroll);
        return { view: 'home' };
      }
      await showSearch(trimmed);
      scrollToTop(options.scroll);
      return { view: 'search', query: trimmed };
    }

    const item = await resolveRoutedItem(nextRoute.itemId);
    if (!item) {
      showHome();
      scrollToTop(options.scroll);
      return { view: 'home' };
    }

    await ensureSeriesEpisodes(item);
    const mixChannel = nextRoute.list === 'mix' ? nextRoute.channel?.trim() ?? '' : '';
    const queue = mixChannel ? mixQueueFor(mixChannel, item) : [];
    setWatchItem(item, queue, mixChannel ? `${mixChannel} Mix` : '', true, options.autoplay);
    scrollToTop(options.scroll);
    return {
      view: 'watch',
      itemId: item.Id,
      ...(mixChannel ? { list: 'mix', channel: mixChannel } : {})
    };
  }

  async function submitSearch() {
    const trimmed = query.trim();
    if (!trimmed) {
      await navigateTo({ view: 'home' });
      return;
    }
    await navigateTo({ view: 'search', query: trimmed });
  }

  async function showSearch(trimmed: string) {
    selectedItem = null;
    selectedQueue = [];
    selectedQueueName = '';
    selectedEpisodeSeason = 0;
    selectedChannelSeason = 0;
    shouldAutoplay = false;
    selectedChannel = '';
    route = 'search';
    query = trimmed;
    searchedFor = trimmed;
    loading = true;
    error = '';
    try {
      const [remoteResults, seriesResults] = await Promise.all([
        fetchSources(session.selectedLibraries, {
          searchTerm: trimmed,
          limit: 80,
          sortBy: 'SortName',
          sortOrder: 'Ascending'
        }),
        fetchSeriesSearch(trimmed)
      ]);
      const localResults = searchLoadedItems(trimmed, searchPool);
      searchResults = rankSearchResults(mergeItems(seriesResults, localResults, remoteResults), trimmed).slice(0, 160);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Search failed.';
    } finally {
      loading = false;
    }
  }

  function openItem(item: JellyfinItem, queue: JellyfinItem[] = [], queueName = '', preserveQueueOrder = false) {
    setWatchItem(item, queue, queueName, preserveQueueOrder, true);
    writeUrl(watchRouteFor(item, queueName), 'push');
    scrollToTop(true);
    void ensureSeriesEpisodes(item);
  }

  function setWatchItem(
    item: JellyfinItem,
    queue: JellyfinItem[] = [],
    queueName = '',
    preserveQueueOrder = false,
    autoplay = false
  ) {
    const collection = queue.length ? null : episodeCollectionForItem(item, episodePool);
    selectedItem = item;
    selectedQueue = collection
      ? collection.allItems
      : queue.length
        ? preserveQueueOrder
          ? queue
          : ensureQueueStartsWith(queue, item)
        : [];
    selectedQueueName = collection ? collection.seriesName : queueName;
    selectedEpisodeSeason = episodeInfo(item)?.season ?? 0;
    selectedChannelSeason = 0;
    shouldAutoplay = autoplay;
    selectedChannel = '';
    route = 'watch';
  }

  function openChannel(channel: string) {
    if (isMovieCollectionChannel(channel)) {
      void navigateTo({ view: 'movies' });
      return;
    }
    void navigateTo({ view: 'channel', channel });
  }

  async function showChannel(channel: string) {
    selectedChannel = channel;
    selectedItem = null;
    selectedQueue = [];
    selectedQueueName = '';
    selectedEpisodeSeason = 0;
    selectedChannelSeason = 0;
    shouldAutoplay = false;
    route = 'channel';
    await ensureChannelSeries(channel);
  }

  function openMix(mix: { name: string; items: JellyfinItem[] }) {
    const queue = [...mix.items].sort(compareByContentDateDesc);
    const first = queue[0];
    if (!first) return;
    openItem(first, queue, `${mix.name} Mix`, true);
  }

  function playChannelMix() {
    if (!selectedChannel || !channelMixItems.length) return;
    openMix({ name: selectedChannel, items: channelMixItems });
  }

  function playNextQueued() {
    const queue = watchQueue;
    if (!selectedItem || queue.length === 0) return;
    const currentIndex = queue.findIndex((queueItem) => queueItem.Id === selectedItem?.Id);
    const nextItem = currentIndex >= 0 ? queue[currentIndex + 1] : queue[0];
    if (nextItem) openItem(nextItem, queue, watchQueueTitle, true);
  }

  function goHome() {
    void navigateTo({ view: 'home' });
  }

  function goBackOrHome() {
    if (routeHistoryIndex > 0) {
      window.history.back();
    } else {
      goHome();
    }
  }

  function showHome() {
    route = 'home';
    selectedItem = null;
    selectedQueue = [];
    selectedQueueName = '';
    selectedEpisodeSeason = 0;
    selectedChannelSeason = 0;
    shouldAutoplay = false;
    selectedChannel = '';
    query = '';
  }

  function goRoute(nextRoute: Route) {
    if (nextRoute === 'home') {
      goHome();
      return;
    }
    if (
      nextRoute === 'movies' ||
      nextRoute === 'music' ||
      nextRoute === 'subscriptions' ||
      nextRoute === 'libraries'
    ) {
      void navigateTo({ view: nextRoute });
      return;
    }
    if (nextRoute === 'channel' && selectedChannel) {
      void navigateTo({ view: 'channel', channel: selectedChannel });
    }
  }

  function showSimpleRoute(nextRoute: 'movies' | 'music' | 'subscriptions') {
    route = nextRoute;
    selectedItem = null;
    selectedQueue = [];
    selectedQueueName = '';
    selectedEpisodeSeason = 0;
    selectedChannelSeason = 0;
    shouldAutoplay = false;
    selectedChannel = '';
  }

  async function openLibrarySettings() {
    await navigateTo({ view: 'libraries' });
  }

  async function showLibrarySettings() {
    route = 'libraries';
    selectedItem = null;
    selectedQueue = [];
    selectedQueueName = '';
    selectedEpisodeSeason = 0;
    selectedChannelSeason = 0;
    shouldAutoplay = false;
    selectedChannel = '';
    librarySettingsError = '';
    librarySelectionIds = session.selectedLibraries.map((source) => source.id);
    if (availableLibraries.length > 0) return;

    librarySettingsLoading = true;
    try {
      const views = await client.getViews(session.userId);
      availableLibraries = views.Items
        .filter(isEligibleLibrary)
        .map(libraryToSelectedSource)
        .filter((library) => library !== null);
    } catch (caught) {
      librarySettingsError = caught instanceof Error ? caught.message : 'Could not load Jellyfin libraries.';
    } finally {
      librarySettingsLoading = false;
    }
  }

  function toggleSource(source: SelectedLibrary) {
    if (librarySelectionIds.includes(source.id)) {
      librarySelectionIds = librarySelectionIds.filter((id) => id !== source.id);
    } else {
      librarySelectionIds = [...librarySelectionIds, source.id];
    }
  }

  async function saveLibraries() {
    const selectedLibraries = availableLibraries.filter((source) => librarySelectionIds.includes(source.id));
    if (selectedLibraries.length === 0) {
      librarySettingsError = 'Select at least one library.';
      return;
    }
    session = { ...session, selectedLibraries };
    seriesEpisodeCache = {};
    seriesPool = [];
    saveSession(session);
    await loadAll();
    await navigateTo({ view: 'home' });
  }

  async function ensureSeriesEpisodes(item: JellyfinItem) {
    const info = episodeInfo(item);
    if (!info || !item.SeriesId || seriesEpisodeCache[info.seriesKey]) return;

    try {
      const response = await client.getSeriesEpisodes(item.SeriesId);
      const episodes = normalizeSeriesEpisodes(response.Items ?? [], item);
      if (!episodes.length) return;
      seriesEpisodeCache = {
        ...seriesEpisodeCache,
        [info.seriesKey]: mergeItems(seriesEpisodeCache[info.seriesKey] ?? [], episodes)
      };
    } catch {
      // The initial library pool still gives a usable queue if Jellyfin cannot return the full series.
    }
  }

  async function ensureChannelSeries(channel: string) {
    const normalizedChannel = normalizeSearch(channel);
    if (!normalizedChannel || !videoSources.length) return;

    const exactSeries = seriesPool.filter((series) => normalizeSearch(series.Name) === normalizedChannel);
    const loadedSeries = exactSeries.filter((series) => !seriesEpisodeCache[series.Id]);
    if (!loadedSeries.length && exactSeries.length) return;

    channelLoading = true;
    try {
      if (loadedSeries.length) {
        await Promise.all(loadedSeries.map((series) => fetchSeriesEpisodes(series, sourceForItem(series))));
        return;
      }

      await fetchSeriesSearch(channel, true);
    } finally {
      channelLoading = false;
    }
  }

  async function fetchSeriesSearch(searchTerm: string, exactOnly = false) {
    const normalizedTerm = normalizeSearch(searchTerm);
    const responses = await Promise.all(
      videoSources.map((source) =>
        client
          .getItems({
            parentId: source.id,
            itemTypes: 'Series',
            searchTerm,
            limit: 12,
            sortBy: 'SortName',
            sortOrder: 'Ascending'
          })
          .then(async (response) => {
            const seriesItems = annotateItems(
              (response.Items ?? []).filter((series) => !exactOnly || normalizeSearch(series.Name) === normalizedTerm),
              source
            );
            const episodeGroups = await Promise.all(seriesItems.map((series) => fetchSeriesEpisodes(series, source)));
            return {
              series: seriesItems,
              episodes: mergeItems(...episodeGroups)
            };
          })
          .catch(() => ({ series: [], episodes: [] }))
      )
    );
    const foundSeries = mergeItems(...responses.map((response) => response.series));
    if (foundSeries.length) {
      seriesPool = mergeItems(seriesPool, foundSeries).sort((a, b) => a.Name.localeCompare(b.Name));
    }
    return mergeItems(...responses.map((response) => response.episodes));
  }

  async function fetchSeriesEpisodes(series: JellyfinItem, source: SelectedLibrary | undefined) {
    const response = await client.getSeriesEpisodes(series.Id);
    const episodes = (response.Items ?? []).map((episode) => ({
      ...episode,
      sourceLibraryId: source?.id,
      sourceLibraryName: source?.name,
      sourceCollectionType: source?.collectionType,
      contentKind: source?.contentKind ?? 'video'
    }));
    const firstInfo = episodes.map(episodeInfo).find((info) => info !== null);
    if (firstInfo) {
      seriesEpisodeCache = {
        ...seriesEpisodeCache,
        [firstInfo.seriesKey]: mergeItems(seriesEpisodeCache[firstInfo.seriesKey] ?? [], episodes)
      };
    }
    return episodes;
  }

  function normalizeSeriesEpisodes(episodes: JellyfinItem[], currentItem: JellyfinItem) {
    const source = sourceForItem(currentItem);
    return episodes.map((episode) => ({
      ...episode,
      sourceLibraryId: episode.sourceLibraryId ?? source?.id,
      sourceLibraryName: episode.sourceLibraryName ?? source?.name,
      sourceCollectionType: episode.sourceCollectionType ?? source?.collectionType,
      contentKind: source?.contentKind ?? 'video'
    }));
  }

  function sourceForItem(item: JellyfinItem): SelectedLibrary | undefined {
    return (
      session.selectedLibraries.find((source) => source.id === item.sourceLibraryId) ??
      session.selectedLibraries.find((source) => source.id === item.ParentId) ??
      session.selectedLibraries.find((source) => source.contentKind === inferItemContentKind(item))
    );
  }

  async function resolveRoutedItem(itemId: string) {
    const existing = findLoadedItem(itemId);
    if (existing) return existing;

    loading = true;
    error = '';
    try {
      const item = await client.getItem(itemId);
      return addResolvedItem(item);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not load that video.';
      return null;
    } finally {
      loading = false;
    }
  }

  function findLoadedItem(itemId: string) {
    return (
      selectedItem?.Id === itemId
        ? selectedItem
        : libraryPool.find((item) => item.Id === itemId) ??
          videoPool.find((item) => item.Id === itemId) ??
          moviePool.find((item) => item.Id === itemId) ??
          musicPool.find((item) => item.Id === itemId) ??
          Object.values(seriesEpisodeCache).flat().find((item) => item.Id === itemId) ??
          null
    );
  }

  function addResolvedItem(item: JellyfinItem) {
    const normalized = normalizeResolvedItem(item);
    if (normalized.contentKind === 'movie') {
      moviePool = mergeItems([normalized], moviePool);
    } else if (normalized.contentKind === 'musicVideo') {
      musicPool = mergeItems([normalized], musicPool);
    } else {
      videoPool = mergeItems([normalized], videoPool);
    }
    libraryPool = mergeItems(videoPool, moviePool, musicPool);
    return normalized;
  }

  function normalizeResolvedItem(item: JellyfinItem): JellyfinItem {
    const contentKind = inferItemContentKind(item);
    const matchingSource =
      session.selectedLibraries.find((source) => source.id === item.sourceLibraryId || source.id === item.ParentId) ??
      session.selectedLibraries.find((source) => source.contentKind === contentKind);

    return {
      ...item,
      sourceLibraryId: item.sourceLibraryId ?? matchingSource?.id,
      sourceLibraryName: item.sourceLibraryName ?? matchingSource?.name,
      sourceCollectionType: item.sourceCollectionType ?? matchingSource?.collectionType,
      contentKind
    };
  }

  function inferItemContentKind(item: JellyfinItem): ContentKind {
    if (item.contentKind) return item.contentKind;
    const sourceKind = contentKindForCollection(item.sourceCollectionType);
    if (sourceKind) return sourceKind;
    const type = item.Type.toLowerCase();
    if (type === 'movie') return 'movie';
    if (type === 'musicvideo') return 'musicVideo';
    return 'video';
  }

  function mixQueueFor(channel: string, currentItem: JellyfinItem) {
    const localEpisodePool = mergeItems(videoPool, ...Object.values(seriesEpisodeCache));
    const episodeCollection = episodeCollectionForItem(currentItem, localEpisodePool);
    const normalizedChannel = normalizeSearch(channel);
    if (episodeCollection && normalizeSearch(episodeCollection.seriesName) === normalizedChannel) {
      return episodeCollection.allItems;
    }

    const queue = mergeItems(videoPool, musicPool, moviePool, localEpisodePool)
      .filter((item) => channelMatches(item, channel))
      .sort(compareByContentDateDesc);
    return queue.some((item) => item.Id === currentItem.Id) ? queue : [currentItem, ...queue];
  }

  function episodeCollectionForChannel(channel: string, items: JellyfinItem[]) {
    const channelEpisodes = items.filter((item) => channelMatches(item, channel) && episodeInfo(item));
    if (!channelEpisodes.length) return null;
    const latestEpisode = [...channelEpisodes].sort(compareByContentDateDesc)[0];
    return latestEpisode ? episodeCollectionForItem(latestEpisode, items) : null;
  }

  function latestShowEpisode(browsableEpisodes: JellyfinItem[], fallbackEpisodes: JellyfinItem[]) {
    const candidates = browsableEpisodes.length ? browsableEpisodes : fallbackEpisodes;
    return [...candidates].sort(compareByContentDateDesc)[0] ?? null;
  }

  function findChannelSeries(channel: string, seriesKey: string) {
    if (!channel) return null;
    const normalizedChannel = normalizeSearch(channel);
    return (
      seriesPool.find((series) => seriesKey && series.Id === seriesKey) ??
      seriesPool.find((series) => normalizeSearch(series.Name) === normalizedChannel) ??
      null
    );
  }

  function showHeroMeta(series: JellyfinItem | null, episodeCount: number, seasonCount: number) {
    const parts: string[] = [];
    const years = showYearRange(series);
    if (years) parts.push(years);
    if (series?.OfficialRating) parts.push(series.OfficialRating);
    if (typeof series?.CommunityRating === 'number') parts.push(`${series.CommunityRating.toFixed(1)} rating`);
    if (series?.Status) parts.push(series.Status);
    if (seasonCount) parts.push(`${seasonCount} ${seasonCount === 1 ? 'season' : 'seasons'}`);
    if (episodeCount) parts.push(`${episodeCount} ${episodeCount === 1 ? 'episode' : 'episodes'}`);
    return parts;
  }

  function showYearRange(series: JellyfinItem | null) {
    if (!series) return '';
    const startYear = series.ProductionYear ?? yearFromDate(series.PremiereDate);
    const endYear = yearFromDate(series.EndDate);
    if (!startYear) return '';
    if (endYear && endYear !== startYear) return `${startYear}-${endYear}`;
    if (!endYear && series.Status?.toLowerCase() === 'continuing') return `${startYear}-present`;
    return String(startYear);
  }

  function yearFromDate(value?: string) {
    if (!value) return 0;
    const year = new Date(value).getFullYear();
    return Number.isFinite(year) ? year : 0;
  }

  function showHeroTags(series: JellyfinItem | null) {
    if (!series) return [];
    const tags = [...(series.Genres ?? []).slice(0, 4)];
    const studio = series.Studios?.[0]?.Name;
    if (studio) tags.push(studio);
    return [...new Set(tags.filter(Boolean))].slice(0, 5);
  }

  function showBackdropStyle(item: JellyfinItem | null) {
    const backdropUrl = item ? client.getBackdropUrl(item, 1440) : '';
    return backdropUrl ? `--show-backdrop: url("${cssString(backdropUrl)}");` : '';
  }

  function cssString(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
  }

  function showProgressStatus(progress: ShowProgress | null) {
    if (!progress?.primaryItem) return 'Episodes';
    if (progress.kind === 'resume') return 'Continue watching';
    if (progress.kind === 'next') return 'Up next';
    if (progress.kind === 'replay') return 'Ready to replay';
    return 'Start watching';
  }

  function showProgressDescription(progress: ShowProgress | null) {
    if (!progress) return '';
    if (!progress.primaryItem) return 'No episodes are available yet.';
    const watched = `${progress.watchedCount} of ${progress.totalCount} episodes watched`;
    if (progress.kind === 'resume') {
      const percent = Math.round(playbackProgress(progress.primaryItem));
      return `${watched}. Continue from ${percent}% complete.`;
    }
    if (progress.kind === 'next') return `${watched}. The next episode is ready.`;
    if (progress.kind === 'replay') return `${watched}. All episodes are watched.`;
    return `${watched}. Start from the first episode.`;
  }

  function episodeMetaLine(item: JellyfinItem | null) {
    if (!item) return '';
    return [episodeCode(item), compactMeta(item), formatDuration(item.RunTimeTicks)].filter(Boolean).join(' • ');
  }

  function latestEpisodeLine(item: JellyfinItem | null) {
    if (!item) return '';
    const released = contentDate(item);
    return [episodeCode(item), released ? relativeDate(released) : ''].filter(Boolean).join(' • ');
  }

  function changeChannelSeason(event: Event) {
    const season = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(season)) return;
    selectedChannelSeason = season;
  }

  function playShowPrimary() {
    const item = channelShowProgress?.primaryItem ?? channelFirstEpisode;
    if (!item || !channelEpisodeCollection) return;
    openItem(item, channelEpisodeCollection.allItems, selectedChannel, true);
  }

  function playShowFromBeginning() {
    if (!channelFirstEpisode || !channelEpisodeCollection) return;
    openItem(channelFirstEpisode, channelEpisodeCollection.allItems, selectedChannel, true);
  }

  function playChannelSeason() {
    const first = channelSeasonItems[0];
    if (!first) return;
    openItem(first, channelSeasonItems, `${selectedChannel} Season ${activeChannelSeason}`, true);
  }

  function playLatestChannelEpisode() {
    const latest = channelEpisodeCollection?.allItems[channelEpisodeCollection.allItems.length - 1];
    if (!latest || !channelEpisodeCollection) return;
    openItem(latest, channelEpisodeCollection.allItems, selectedChannel, true);
  }

  function isMovieCollectionChannel(channel: string) {
    const normalized = normalizeSearch(channel);
    return (
      normalized === 'youtube movies' ||
      movieSources.some((source) => normalizeSearch(source.name) === normalized)
    );
  }

  function playbackActionLabel(item: JellyfinItem) {
    return (item.UserData?.PlaybackPositionTicks ?? 0) > 0 && !item.UserData?.Played ? 'Resume' : 'Watch';
  }

  function videoCountLabel(count: number) {
    return `${count} ${count === 1 ? 'video' : 'videos'}`;
  }

  function relatedCandidatesFor(item: JellyfinItem | null, queue: JellyfinItem[] = []) {
    const pool = item?.contentKind === 'movie' ? moviePool : mergeItems(videoPool, musicPool);
    const ranked = rankRecommendations(pool, {
      activity,
      currentItem: item,
      mode: item?.contentKind === 'movie' ? 'movie' : 'watch',
      recentItemIds: recentPlaybackIds,
      queueItems: queue
    });
    if (!item) return ranked;
    const recommendationPool = episodeInfo(item)
      ? ranked.filter((candidate) => !sameEpisodeSeries(candidate, item))
      : ranked;
    const currentChannel = channelName(item).toLowerCase();
    const sameChannel = recommendationPool.filter((candidate) => channelName(candidate).toLowerCase() === currentChannel);
    const other = recommendationPool.filter((candidate) => channelName(candidate).toLowerCase() !== currentChannel);
    return [...sameChannel, ...other];
  }

  function syncWatchRecommendations(
    currentRoute: Route,
    item: JellyfinItem | null,
    queue: JellyfinItem[],
    contextKey: string
  ) {
    if (currentRoute !== 'watch' || !item) {
      if (contextKey !== watchRecommendationContextKey) {
        watchRecommendationContextKey = contextKey;
        watchRecommendationRequestId += 1;
      }
      if (watchRecommendations.length) watchRecommendations = [];
      return;
    }

    if (contextKey === watchRecommendationContextKey) return;

    watchRecommendationContextKey = contextKey;
    const requestId = ++watchRecommendationRequestId;
    const fallback = relatedCandidatesFor(item, queue).slice(0, WATCH_RECOMMENDATION_LIMIT);
    watchRecommendations = fallback;
    void refreshWatchJellyGptRecommendations(item, queue, fallback, contextKey, requestId);
  }

  async function refreshWatchJellyGptRecommendations(
    item: JellyfinItem,
    queue: JellyfinItem[],
    fallback: JellyfinItem[],
    contextKey: string,
    requestId: number
  ) {
    if (!jellyGptEnabled || jellyGptStatus !== 'connected') return;
    const normalizedUrl = normalizeJellyGptUrl(jellyGptUrl);
    if (!normalizedUrl) return;

    try {
      const response = await fetchIndexedJellyGptRecommendations({
        url: normalizedUrl,
        algorithm: jellyGptSelectedAlgorithm,
        userId: session.userId,
        activity,
        recentItemIds: recentPlaybackIds,
        context: 'watch',
        currentItem: item,
        queueItems: queue,
        binge: bingeContextFor(item, queue),
        limit: WATCH_RECOMMENDATION_LIMIT
      });
      if (requestId !== watchRecommendationRequestId || contextKey !== watchRecommendationContextKey) return;
      watchRecommendations = await resolveIndexedJellyGptRanking(
        response,
        fallback,
        WATCH_RECOMMENDATION_LIMIT
      );
    } catch {
      // The already-rendered built-in list remains the watch-page fallback.
    }
  }

  async function resolveIndexedJellyGptRanking(
    response: JellyGptRecommendationResponse,
    fallback: JellyfinItem[],
    limit: number
  ) {
    if (!response.items.length) return fallback.slice(0, limit);

    const ranked: RankedItem[] = [];
    const seen = new Set<string>();

    for (const scored of response.items) {
      if (ranked.length >= limit || seen.has(scored.item_id)) continue;
      const item = await resolveIndexedRecommendationItem(scored.item_id);
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
      ranked.push(item);
    }

    return ranked.slice(0, limit);
  }

  async function resolveIndexedRecommendationItem(itemId: string) {
    const loaded = findLoadedItem(itemId) ?? indexedRecommendationCache[itemId];
    if (loaded) return normalizeResolvedItem(loaded);

    try {
      const fetched = await client.getItem(itemId);
      const normalized = addResolvedItem(fetched);
      indexedRecommendationCache = {
        ...indexedRecommendationCache,
        [normalized.Id]: normalized
      };
      return normalized;
    } catch {
      return null;
    }
  }

  function bingeContextFor(item: JellyfinItem, queue: JellyfinItem[]): JellyGptBingeContext | null {
    const currentChannel = channelName(item).toLowerCase();
    const currentSeries = item.SeriesId;
    let streakCount = 1;

    for (const queueItem of ensureQueueStartsWith(queue, item).slice(1, 8)) {
      if (isSameBingeContext(queueItem, currentChannel, currentSeries)) {
        streakCount += 1;
      } else {
        break;
      }
    }

    for (const recentId of recentPlaybackIds.slice(0, 8)) {
      const recentItem = findLoadedItem(recentId);
      if (!recentItem) continue;
      if (isSameBingeContext(recentItem, currentChannel, currentSeries)) {
        streakCount += 1;
      } else {
        break;
      }
    }

    if (streakCount < 2) return null;
    return {
      channel: channelName(item),
      series_id: currentSeries,
      streak_count: streakCount
    };
  }

  function isSameBingeContext(item: JellyfinItem, channel: string, seriesId?: string) {
    if (seriesId && item.SeriesId === seriesId) return true;
    return channelName(item).toLowerCase() === channel;
  }

  function itemIdsKey(items: JellyfinItem[]) {
    return items.map((item) => item.Id).join(',');
  }

  function playbackActivityKey(rows: PlaybackActivity[]) {
    return rows
      .map((row) => `${row.item_name ?? ''}:${row.total_count ?? ''}:${row.latest_date ?? ''}`)
      .join(',');
  }

  function rememberFinishedItem(item: JellyfinItem) {
    recentPlaybackIds = [item.Id, ...recentPlaybackIds.filter((id) => id !== item.Id)].slice(0, 80);
    refreshRecommendations();
  }

  function refreshRecommendations() {
    recommended = rankRecommendations(mergeItems(videoPool, musicPool), {
      activity,
      mode: 'home',
      recentItemIds: recentPlaybackIds
    }).slice(0, 48);
    moviePopular = rankRecommendations(moviePool, {
      activity,
      mode: 'movie',
      recentItemIds: recentPlaybackIds
    }).slice(0, 36);
    musicRecommended = rankRecommendations(musicPool, {
      activity,
      mode: 'music',
      recentItemIds: recentPlaybackIds
    }).slice(0, 36);
    void refreshJellyGptRecommendations();
  }

  async function refreshJellyGptRecommendations() {
    if (!jellyGptEnabled || jellyGptStatus !== 'connected') {
      jellyGptRecommendationStatus = 'fallback';
      jellyGptRecommendationMessage = 'Built-in recommendations active.';
      return;
    }

    const normalizedUrl = normalizeJellyGptUrl(jellyGptUrl);
    if (!normalizedUrl || (!videoPool.length && !musicPool.length && !moviePool.length)) return;

    jellyGptRecommendationStatus = 'loading';
    jellyGptRecommendationMessage = `Loading ${jellyGptSelectedAlgorithm} recommendations from jellyGPT…`;

    try {
      const [homeResponse, movieResponse, musicResponse] = await Promise.all([
        fetchIndexedJellyGptRecommendations({
          url: normalizedUrl,
          algorithm: jellyGptSelectedAlgorithm,
          userId: session.userId,
          activity,
          recentItemIds: recentPlaybackIds,
          context: 'home',
          limit: 48
        }),
        fetchIndexedJellyGptRecommendations({
          url: normalizedUrl,
          algorithm: jellyGptSelectedAlgorithm,
          userId: session.userId,
          activity,
          recentItemIds: recentPlaybackIds,
          context: 'movie',
          limit: 36
        }),
        fetchIndexedJellyGptRecommendations({
          url: normalizedUrl,
          algorithm: jellyGptSelectedAlgorithm,
          userId: session.userId,
          activity,
          recentItemIds: recentPlaybackIds,
          context: 'music',
          limit: 36
        })
      ]);

      const [homeItems, movieItems, musicItems] = await Promise.all([
        resolveIndexedJellyGptRanking(homeResponse, recommended, 48),
        resolveIndexedJellyGptRanking(movieResponse, moviePopular, 36),
        resolveIndexedJellyGptRanking(musicResponse, musicRecommended, 36)
      ]);

      recommended = homeItems;
      moviePopular = movieItems;
      musicRecommended = musicItems;
      jellyGptRecommendationStatus = 'active';
      jellyGptLastRecommendationAt = new Date().toISOString();
      jellyGptRecommendationMessage = `Using indexed jellyGPT ${jellyGptSelectedAlgorithm} recommendations.`;
    } catch (caught) {
      jellyGptRecommendationStatus = 'error';
      jellyGptRecommendationMessage = caught instanceof Error ? caught.message : 'jellyGPT recommendations unavailable; using built-in fallback.';
    }
  }

  function ensureQueueStartsWith(queue: JellyfinItem[], item: JellyfinItem) {
    const withoutCurrent = queue.filter((queueItem) => queueItem.Id !== item.Id);
    return [item, ...withoutCurrent];
  }

  function cycleTheme() {
    themeMode = effectiveTheme === 'dark' ? 'light' : 'dark';
    applyTheme();
    const nextSession = { ...session, themeMode };
    session = nextSession;
    saveSession(nextSession);
  }

  function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
    if (mode !== 'system') return mode;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    effectiveTheme = resolveEffectiveTheme(themeMode);
    document.documentElement.dataset.theme = effectiveTheme;
    localStorage.setItem('jellytube.theme', themeMode);
  }

  function scrollToTop(scroll: boolean) {
    if (!scroll) return;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function openJellyGptSetup() {
    jellyGptPanelOpen = true;
    void loadJellyGptAlgorithms();
    if (jellyGptEnabled) void checkJellyGptConnection();
  }

  function closeJellyGptSetup() {
    jellyGptPanelOpen = false;
  }

  function handleJellyGptOutsidePointerDown(event: PointerEvent) {
    if (!jellyGptPanelOpen || !(event.target instanceof Element)) return;
    if (event.target.closest('.jellygpt-panel')) return;
    closeJellyGptSetup();
  }

  function normalizeJellyGptUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  async function saveJellyGptConnection() {
    const normalizedUrl = normalizeJellyGptUrl(jellyGptUrl);
    if (!normalizedUrl) {
      jellyGptStatus = 'error';
      jellyGptStatusMessage = 'Enter the jellyGPT URL first.';
      return;
    }
    jellyGptUrl = normalizedUrl;
    jellyGptEnabled = true;
    localStorage.setItem('jellytube.jellygpt.url', normalizedUrl);
    localStorage.setItem('jellytube.jellygpt.enabled', 'true');
    await checkJellyGptConnection();
    await loadJellyGptAlgorithms();
  }

  function disconnectJellyGpt() {
    jellyGptEnabled = false;
    jellyGptVersion = '';
    jellyGptStatus = 'unconfigured';
    jellyGptStatusMessage = 'jellyGPT is disconnected. Built-in recommendations stay active.';
    jellyGptRecommendationStatus = 'fallback';
    jellyGptRecommendationMessage = 'Built-in recommendations active.';
    localStorage.setItem('jellytube.jellygpt.enabled', 'false');
  }

  async function checkJellyGptConnection() {
    const normalizedUrl = normalizeJellyGptUrl(jellyGptUrl);
    if (!normalizedUrl) {
      jellyGptStatus = 'unconfigured';
      jellyGptStatusMessage = 'Connect jellyGPT for cached AI recommendations.';
      return;
    }

    jellyGptUrl = normalizedUrl;
    jellyGptStatus = 'checking';
    jellyGptStatusMessage = `Checking ${normalizedUrl}…`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`${normalizedUrl}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = (await response.json()) as { ok?: boolean; version?: string };
      if (!health.ok) throw new Error('Health check did not report ok=true.');
      jellyGptEnabled = true;
      jellyGptVersion = health.version ?? '';
      jellyGptStatus = 'connected';
      jellyGptStatusMessage = `Connected${jellyGptVersion ? ` to jellyGPT ${jellyGptVersion}` : ''}.`;
      localStorage.setItem('jellytube.jellygpt.url', normalizedUrl);
      localStorage.setItem('jellytube.jellygpt.enabled', 'true');
      void loadJellyGptAlgorithms();
      void refreshJellyGptRecommendations();
    } catch (caught) {
      jellyGptStatus = 'error';
      jellyGptVersion = '';
      jellyGptStatusMessage = caught instanceof Error ? caught.message : 'Could not reach jellyGPT.';
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function loadJellyGptAlgorithms() {
    const normalizedUrl = normalizeJellyGptUrl(jellyGptUrl);
    if (!normalizedUrl) {
      jellyGptAlgorithms = FALLBACK_JELLYGPT_ALGORITHMS;
      return;
    }

    jellyGptAlgorithmsLoading = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`${normalizedUrl}/algorithms`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { algorithms?: JellyGptAlgorithm[] };
      const algorithms = data.algorithms?.length ? data.algorithms : FALLBACK_JELLYGPT_ALGORITHMS;
      jellyGptAlgorithms = algorithms;
      if (!algorithms.some((algorithm) => algorithm.id === jellyGptSelectedAlgorithm)) {
        jellyGptSelectedAlgorithm = algorithms.find((algorithm) => algorithm.available)?.id ?? algorithms[0]?.id ?? 'blended';
        localStorage.setItem('jellytube.jellygpt.algorithm', jellyGptSelectedAlgorithm);
      }
    } catch {
      jellyGptAlgorithms = FALLBACK_JELLYGPT_ALGORITHMS;
    } finally {
      window.clearTimeout(timeout);
      jellyGptAlgorithmsLoading = false;
    }
  }

  function selectJellyGptAlgorithm(algorithmId: string) {
    jellyGptSelectedAlgorithm = algorithmId;
    localStorage.setItem('jellytube.jellygpt.algorithm', algorithmId);
    void refreshJellyGptRecommendations();
  }

  function readUrlRoute(): UrlRoute {
    const url = new URL(window.location.href);
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
    const section = parts[0] ?? '';

    if (section === 'watch' && parts[1]) {
      const list = url.searchParams.get('list');
      return {
        view: 'watch',
        itemId: parts[1],
        ...(list === 'mix' ? { list: 'mix' as const, channel: url.searchParams.get('channel') ?? '' } : {})
      };
    }

    if (section === 'search') return { view: 'search', query: url.searchParams.get('q') ?? '' };
    if (section === 'movies') return { view: 'movies' };
    if (section === 'music') return { view: 'music' };
    if (section === 'subscriptions') return { view: 'subscriptions' };
    if (section === 'libraries') return { view: 'libraries' };
    if (section === 'channel') return { view: 'channel', channel: parts.slice(1).join('/') || url.searchParams.get('name') || '' };
    return { view: 'home' };
  }

  function writeUrl(nextRoute: UrlRoute, mode: Exclude<HistoryMode, 'none'>) {
    const nextUrl = routeToUrl(nextRoute);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (mode === 'push' && nextUrl === currentUrl) return;
    const nextIndex = mode === 'replace' ? routeHistoryIndex : routeHistoryIndex + 1;
    const state = { jellytube: true, jellytubeIndex: nextIndex, route: nextRoute };
    if (mode === 'replace') {
      window.history.replaceState(state, '', nextUrl);
    } else {
      window.history.pushState(state, '', nextUrl);
    }
    routeHistoryIndex = nextIndex;
  }

  function routeToUrl(nextRoute: UrlRoute) {
    if (nextRoute.view === 'home') return '/';
    if (nextRoute.view === 'movies') return '/movies';
    if (nextRoute.view === 'music') return '/music';
    if (nextRoute.view === 'subscriptions') return '/subscriptions';
    if (nextRoute.view === 'libraries') return '/libraries';
    if (nextRoute.view === 'search') {
      const params = new URLSearchParams({ q: nextRoute.query });
      return `/search?${params.toString()}`;
    }
    if (nextRoute.view === 'channel') return `/channel/${encodeURIComponent(nextRoute.channel)}`;

    const params = new URLSearchParams();
    if (nextRoute.list === 'mix' && nextRoute.channel) {
      params.set('list', 'mix');
      params.set('channel', nextRoute.channel);
    }
    const queryString = params.toString();
    return `/watch/${encodeURIComponent(nextRoute.itemId)}${queryString ? `?${queryString}` : ''}`;
  }

  function watchRouteFor(item: JellyfinItem, queueName = ''): UrlRoute {
    const mixName = queueName.endsWith(' Mix') ? queueName.slice(0, -4).trim() : '';
    return {
      view: 'watch',
      itemId: item.Id,
      ...(mixName ? { list: 'mix' as const, channel: mixName } : {})
    };
  }

  function safeDecode(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
</script>

<div class:menu-open={menuOpen} class="app-shell">
  <header class="topbar">
    <div class="topbar-left">
      <button class="icon-button" aria-label="Toggle navigation" on:click={() => (menuOpen = !menuOpen)}>
        <Menu size={22} />
      </button>
      <button class="wordmark" on:click={goHome} aria-label="JellyTube home">
        <span class="play-mark">▶</span>
        <span>JellyTube</span>
      </button>
    </div>

    <form class="search-form" on:submit|preventDefault={submitSearch}>
      <input bind:value={query} placeholder="Search" aria-label="Search videos" />
      <button aria-label="Search">
        <Search size={21} />
      </button>
    </form>

    <div class="topbar-actions">
      <button
        class:connected={jellyGptEnabled && jellyGptStatus === 'connected'}
        class="recommendation-settings-button topbar-ai-button"
        type="button"
        title="Recommendation settings"
        on:click={openJellyGptSetup}
      >
        <SlidersHorizontal size={17} />
        <span>Recommendations</span>
      </button>
      <button
        class="icon-button theme-toggle"
        aria-label={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} theme`}
        title={`Theme: ${themeMode}${themeMode === 'system' ? ` (${effectiveTheme})` : ''}`}
        on:click={cycleTheme}
      >
        {#if effectiveTheme === 'dark'}
          <Moon size={19} />
        {:else}
          <Sun size={19} />
        {/if}
      </button>
      <div class="account-pill" title={`${session.serverName} · ${session.userName}`}>
        <Server size={16} />
        <span>{session.serverName}</span>
        <UserCircle size={18} />
      </div>
    </div>
  </header>

  <aside class="sidebar" aria-label="Navigation">
    <button class:active={route === 'home'} on:click={goHome}>
      <Home size={21} />
      <span>Home</span>
    </button>
    <button class:active={route === 'movies'} on:click={() => goRoute('movies')} disabled={movieSources.length === 0}>
      <Clapperboard size={21} />
      <span>Movies</span>
    </button>
    <button class:active={route === 'music'} on:click={() => goRoute('music')} disabled={musicSources.length === 0}>
      <Music2 size={21} />
      <span>Music</span>
    </button>
    <button
      class:active={route === 'subscriptions'}
      aria-label="Subscriptions"
      title="Subscriptions"
      on:click={() => goRoute('subscriptions')}
    >
      <ListVideo size={21} />
      <span class="nav-label-short">Subs</span>
      <span class="nav-label-full">Subscriptions</span>
    </button>
    <button
      class:active={route === 'libraries'}
      class="library-summary"
      title={session.selectedLibraries.map((source) => source.name).join(', ')}
      on:click={openLibrarySettings}
    >
      <Library size={21} />
      <span>{session.selectedLibraries.length} libs</span>
    </button>
    <button on:click={() => dispatch('logout')}>
      <LogOut size={20} />
      <span>Sign out</span>
    </button>
  </aside>

  <main class="content">
    {#if route === 'watch' && selectedItem}
      {#key selectedItem.Id}
        <WatchPage
          {client}
          item={selectedItem}
          autoplay={shouldAutoplay}
          queue={watchQueue}
          queueTitle={watchQueueTitle}
          episodeSeasons={episodeCollection?.seasons ?? []}
          selectedEpisodeSeason={activeEpisodeSeason}
          episodeSeriesTitle={episodeCollection?.seriesName ?? ''}
          recommendations={watchRecommendations}
          on:back={goBackOrHome}
          on:select={(event) => openItem(event.detail)}
          on:queueSelect={(event) => openItem(event.detail, watchQueue, watchQueueTitle, true)}
          on:episodeSelect={(event) => openItem(event.detail, watchQueue, watchQueueTitle, true)}
          on:episodeSeason={(event) => (selectedEpisodeSeason = event.detail)}
          on:channel={(event) => openChannel(event.detail)}
          on:movies={() => navigateTo({ view: 'movies' })}
          on:finished={(event) => rememberFinishedItem(event.detail)}
          on:next={playNextQueued}
        />
      {/key}
    {:else if error}
      <div class="empty-state">
        <p>{error}</p>
        <button class="secondary-action" on:click={loadAll}>Try again</button>
      </div>
    {:else if loading}
      <SkeletonRoute {route} label={route === 'search' && searchedFor ? `Searching ${searchedFor}` : 'Loading content'} />
    {:else if route === 'search'}
      <section class="feed-section">
        <div class="section-heading">
          <h2>Search results for “{searchedFor}”</h2>
          <span>{searchResults.length} matches</span>
        </div>
        {#if searchResults.length}
          <div class="video-grid">
            {#each searchResults as item (item.Id)}
              <VideoCard
                {client}
                {item}
                poster={item.contentKind === 'movie'}
                titleContext="recommendation"
                titleChannel={channelName(item)}
                on:select={(event) => openItem(event.detail)}
                on:channel={(event) => openChannel(event.detail)}
              />
            {/each}
          </div>
        {:else}
          <div class="empty-state compact">No videos found.</div>
        {/if}
      </section>
    {:else if route === 'movies'}
      <section class="feed-section movie-landing">
        <div class="section-heading">
          <h2>YouTube Movies</h2>
          <span>{movieSources.length} selected movie {movieSources.length === 1 ? 'library' : 'libraries'}</span>
        </div>
        {#if featuredMovie}
          <button class="movie-feature" on:click={() => openItem(featuredMovie)}>
            <span class="movie-feature-poster">
              {#if client.getImageUrl(featuredMovie, 420)}
                <img src={client.getImageUrl(featuredMovie, 420)} alt="" loading="lazy" />
              {:else}
                <span>{featuredMovie.Name.slice(0, 1)}</span>
              {/if}
            </span>
            <span class="movie-feature-copy">
              <span class="content-pill">Movie</span>
              <strong>{displayTitle(featuredMovie)}</strong>
              <span>{compactMeta(featuredMovie)}{formatDuration(featuredMovie.RunTimeTicks) ? ` • ${formatDuration(featuredMovie.RunTimeTicks)}` : ''}</span>
              {#if featuredMovie.Overview}
                <small>{featuredMovie.Overview}</small>
              {/if}
              <span class="primary-action movie-feature-action">{playbackActionLabel(featuredMovie)}</span>
            </span>
          </button>
        {/if}
        {#if movieResume.length}
          <h3>Continue watching</h3>
          <div class="movie-grid horizontal-movie-rail">
            {#each movieResume as item (item.Id)}
              <VideoCard {client} {item} poster on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        {/if}
      </section>

      <section class="feed-section">
        <h2>Recommended movies</h2>
        <div class="movie-grid">
          {#each moviePopular as item (item.Id)}
            <VideoCard {client} {item} poster on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>

      <section class="feed-section">
        <h2>New movies</h2>
        <div class="movie-grid">
          {#each movies as item (item.Id)}
            <VideoCard {client} {item} poster on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>
    {:else if route === 'music'}
      <section class="feed-section hero-section">
        <div class="section-heading">
          <h2>Music Videos</h2>
          <span>{musicSources.length} selected music video {musicSources.length === 1 ? 'library' : 'libraries'}</span>
        </div>
        {#if musicMixes.length}
          <div class="mix-grid">
            {#each musicMixes.slice(0, 8) as mix (mix.name)}
              <button class="mix-card" on:click={() => openMix(mix)}>
                {#if client.getImageUrl(mix.items[0], 320)}
                  <img src={client.getImageUrl(mix.items[0], 320)} alt="" loading="lazy" />
                {:else}
                  <span>{mix.name.slice(0, 1)}</span>
                {/if}
                <strong>{mix.name} Mix</strong>
                <small>{mix.items.length} videos</small>
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="feed-section">
        <h2>Recommended music videos</h2>
        <div class="video-grid">
          {#each musicRecommended.slice(0, 12) as item (item.Id)}
            <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>

      {#if musicMixes.length}
        {#each musicMixes as mix (mix.name)}
          <section class="feed-section">
            <div class="section-heading">
              <h2>{mix.name} Mix</h2>
              <div class="section-actions">
                <button class="text-action" on:click={() => openMix(mix)}>Play all</button>
                <button class="text-action" on:click={() => openChannel(mix.name)}>View channel</button>
              </div>
            </div>
            <div class="video-grid">
              {#each mix.items.slice(0, 12) as item (item.Id)}
                <VideoCard {client} {item} on:select={(event) => openItem(event.detail, mix.items, `${mix.name} Mix`, true)} on:channel={(event) => openChannel(event.detail)} />
              {/each}
            </div>
          </section>
        {/each}
      {/if}

      <section class="feed-section">
        <h2>New music videos</h2>
        <div class="video-grid">
          {#each musicVideos as item (item.Id)}
            <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>
    {:else if route === 'subscriptions'}
      <section class="feed-section subscriptions-page">
        <div class="section-heading">
          <div>
            <h2>Subscriptions</h2>
            <span>{channelDirectory.length} shows and channels</span>
          </div>
        </div>

        <div class="directory-filter">
          <input bind:value={channelDirectoryQuery} placeholder="Filter shows and channels" aria-label="Filter shows and channels" />
        </div>
      </section>

      {#if showDirectory.length}
        <section class="feed-section">
          <div class="section-heading">
            <h2>Shows</h2>
            <span>{showDirectory.length} shown</span>
          </div>
          <div class="subscription-channel-grid">
            {#each showDirectory as entry (entry.name)}
              <button class="subscription-card directory-card" on:click={() => openChannel(entry.name)}>
                <span class="subscription-avatar">
                  {#if entry.latestItem && client.getImageUrl(entry.latestItem, 220)}
                    <img src={client.getImageUrl(entry.latestItem, 220)} alt="" loading="lazy" />
                  {:else}
                    <span>{entry.name.slice(0, 1)}</span>
                  {/if}
                </span>
                <span class="subscription-copy">
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.itemCount ? videoCountLabel(entry.itemCount) : 'Show'}{entry.sourceLibraryName ? ` · ${entry.sourceLibraryName}` : ''}
                  </small>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if creatorDirectory.length}
        <section class="feed-section">
          <div class="section-heading">
            <h2>Channels</h2>
            <span>{creatorDirectory.length} shown</span>
          </div>
          <div class="subscription-channel-grid">
            {#each creatorDirectory as entry (entry.name)}
              <button class="subscription-card directory-card" on:click={() => openChannel(entry.name)}>
                <span class="subscription-avatar">
                  {#if entry.latestItem && client.getImageUrl(entry.latestItem, 220)}
                    <img src={client.getImageUrl(entry.latestItem, 220)} alt="" loading="lazy" />
                  {:else}
                    <span>{entry.name.slice(0, 1)}</span>
                  {/if}
                </span>
                <span class="subscription-copy">
                  <strong>{entry.name}</strong>
                  <small>{videoCountLabel(entry.itemCount)}{entry.kind === 'music' ? ' · Music videos' : ''}</small>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if !showDirectory.length && !creatorDirectory.length}
        <div class="empty-state compact">No shows or channels found.</div>
      {/if}

      {#if latestDirectoryVideos.length && !channelDirectoryFilterActive}
        <section class="feed-section">
          <div class="section-heading">
            <h2>Recent uploads</h2>
            <span>{latestDirectoryVideos.length} videos</span>
          </div>
          <div class="video-grid">
            {#each latestDirectoryVideos as item (item.Id)}
              <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}
    {:else if route === 'channel'}
      {#if channelEpisodeCollection}
        <section class="show-hero" style={channelHeroBackdropStyle}>
          <div class="show-artwork">
            {#if channelHeroItem && client.getImageUrl(channelHeroItem, 420)}
              <img src={client.getImageUrl(channelHeroItem, 420)} alt="" loading="lazy" />
            {:else}
              <span>{selectedChannel.slice(0, 1)}</span>
            {/if}
          </div>
          <div class="show-hero-copy">
            <span class="content-pill">Show</span>
            <h1>{selectedChannel}</h1>
            {#if channelHeroMeta.length}
              <div class="show-meta-line">
                {#each channelHeroMeta as part}
                  <span>{part}</span>
                {/each}
              </div>
            {/if}
            {#if channelSeries?.Overview}
              <p class="show-overview">{channelSeries.Overview}</p>
            {/if}
            {#if channelHeroTags.length}
              <div class="show-tag-row">
                {#each channelHeroTags as tag}
                  <span>{tag}</span>
                {/each}
              </div>
            {/if}
            {#if channelShowProgress}
              <div class="show-progress-summary">
                <div class="show-progress-heading">
                  <span>{showProgressStatus(channelShowProgress)}</span>
                  <span>{channelShowProgress.watchedCount} / {channelShowProgress.totalCount}</span>
                </div>
                <div class="show-progress-track" style={channelProgressStyle}>
                  <span></span>
                </div>
                <p>{showProgressDescription(channelShowProgress)}</p>
              </div>
            {/if}
            {#if channelLatestEpisode}
              <div class="show-latest-line">
                <span>Latest episode</span>
                <strong>{displayTitle(channelLatestEpisode, { context: 'series', channel: selectedChannel })}</strong>
                <small>{latestEpisodeLine(channelLatestEpisode)}</small>
              </div>
            {/if}
            <div class="show-hero-actions">
              <button class="primary-action" on:click={playShowPrimary} disabled={!channelShowProgress?.primaryItem}>
                <Play size={18} />
                <span>{channelShowProgress?.label ?? 'Play'}</span>
              </button>
              <button class="secondary-action" on:click={playShowFromBeginning} disabled={!channelFirstEpisode}>
                <RotateCcw size={17} />
                <span>Start over</span>
              </button>
              <button class="secondary-action" on:click={playChannelMix} disabled={!channelMixItems.length}>
                <ListVideo size={17} />
                <span>Mix</span>
              </button>
            </div>
          </div>
        </section>
      {:else}
        <section class="channel-header">
          <div class="channel-avatar">{selectedChannel.slice(0, 1)}</div>
          <div class="channel-header-copy">
            <h1>{selectedChannel}</h1>
            <p>{channelItems.length} videos across selected libraries</p>
          </div>
          <button class="primary-action channel-mix-action" on:click={playChannelMix} disabled={!channelMixItems.length}>
            <ListVideo size={18} />
            <span>Mix</span>
          </button>
        </section>
      {/if}

      {#if channelLoading}
        <div class="skeleton-inline-status">
          <SkeletonRoute route="channel" label={`Loading ${selectedChannel}`} />
        </div>
      {/if}

      {#if channelEpisodeCollection}
        {#if channelShowProgress?.primaryItem}
          <section class="show-up-next">
            <button class="show-up-next-thumb" on:click={playShowPrimary} aria-label={channelShowProgress.label}>
              {#if client.getImageUrl(channelShowProgress.primaryItem, 640)}
                <img src={client.getImageUrl(channelShowProgress.primaryItem, 640)} alt="" loading="lazy" />
              {:else}
                <span>{channelShowProgress.primaryItem.Name.slice(0, 1)}</span>
              {/if}
              {#if formatDuration(channelShowProgress.primaryItem.RunTimeTicks)}
                <span class="duration">{formatDuration(channelShowProgress.primaryItem.RunTimeTicks)}</span>
              {/if}
              {#if playbackProgress(channelShowProgress.primaryItem) > 0 && playbackProgress(channelShowProgress.primaryItem) < 95}
                <span class="progress-bar" style={`width: ${playbackProgress(channelShowProgress.primaryItem)}%`}></span>
              {/if}
            </button>
            <div class="show-up-next-copy">
              <span class="content-pill">{showProgressStatus(channelShowProgress)}</span>
              <h2>{displayTitle(channelShowProgress.primaryItem, { context: 'series', channel: selectedChannel })}</h2>
              <div class="show-up-next-meta">{episodeMetaLine(channelShowProgress.primaryItem)}</div>
              {#if channelShowProgress.primaryItem.Overview}
                <p>{channelShowProgress.primaryItem.Overview}</p>
              {/if}
              <button class="primary-action show-up-next-action" on:click={playShowPrimary}>
                <Play size={18} />
                <span>{channelShowProgress.label}</span>
              </button>
            </div>
          </section>
        {/if}

        <section class="feed-section show-guide">
          <div class="section-heading">
            <div>
              <h2>Episodes</h2>
              <span>{channelEpisodeCollection.allItems.length} episodes · {channelEpisodeCollection.seasons.length} seasons</span>
            </div>
            <div class="section-actions">
              <button class="text-action" on:click={playLatestChannelEpisode}>Latest episode</button>
              <button class="text-action" on:click={playChannelSeason}>Play season</button>
              <label class="season-picker inline">
                <span>Season</span>
                <select value={activeChannelSeason} on:change={changeChannelSeason}>
                  {#each channelDisplaySeasons as season (season.season)}
                    <option value={season.season}>{season.label}</option>
                  {/each}
                </select>
              </label>
            </div>
          </div>
          <div class="video-grid">
            {#each channelSeasonItems as item (item.Id)}
              <VideoCard {client} {item} titleContext="series" titleChannel={selectedChannel} on:select={(event) => openItem(event.detail, channelSeasonItems, `${selectedChannel} Season ${activeChannelSeason}`, true)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}

      <section class="feed-section">
        <h2>{channelEpisodeCollection ? 'Latest uploads from this show' : 'Latest by release date'}</h2>
        <div class="video-grid">
          {#each channelLatest as item (item.Id)}
            <VideoCard {client} {item} titleContext={channelEpisodeCollection ? 'series' : 'channel'} titleChannel={selectedChannel} poster={item.contentKind === 'movie'} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>

      {#if channelPopular.length}
        <section class="feed-section">
          <h2>Replay picks</h2>
          <div class="video-grid">
            {#each channelPopular.slice(0, 18) as item (item.Id)}
              <VideoCard {client} {item} titleContext={channelEpisodeCollection ? 'series' : 'channel'} titleChannel={selectedChannel} poster={item.contentKind === 'movie'} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}
    {:else if route === 'libraries'}
      <section class="feed-section library-settings">
        <div class="section-heading">
          <h2>Selected Libraries</h2>
          <span>{librarySelectionIds.length} selected</span>
        </div>
        {#if librarySettingsLoading}
          <div class="skeleton-inline-status" role="status" aria-busy="true">
            <span class="sr-only">Loading libraries</span>
            <SkeletonLibraryGrid count={6} />
          </div>
        {:else}
          <div class="settings-grid">
            {#each availableLibraries as source (source.id)}
              <button
                class:selected={librarySelectionIds.includes(source.id)}
                class="library-card"
                on:click={() => toggleSource(source)}
              >
                <Library size={22} />
                <span class="library-name">{source.name}</span>
                <span class="library-meta">{libraryKindLabel(source.collectionType)} · {source.itemTypes}</span>
                <span class="library-check">{librarySelectionIds.includes(source.id) ? 'Selected' : 'Add'}</span>
              </button>
            {/each}
          </div>
          {#if librarySettingsError}
            <div class="status-error" role="alert">{librarySettingsError}</div>
          {/if}
          <button class="primary-action settings-save" on:click={saveLibraries}>Update libraries</button>
        {/if}
      </section>
    {:else}
      {#if resume.length}
        <section class="feed-section">
          <h2>Continue watching</h2>
          <div class="video-grid horizontal-video-rail">
            {#each resume as item (item.Id)}
              <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}

      {#if latestAdded.length}
        <section class="feed-section">
          <div class="section-heading">
            <h2>Latest added</h2>
            <span>Across selected libraries</span>
          </div>
          <div class="video-grid">
            {#each latestAdded as item (item.Id)}
              <VideoCard
                {client}
                {item}
                poster={item.contentKind === 'movie'}
                titleContext="recommendation"
                titleChannel={channelName(item)}
                on:select={(event) => openItem(event.detail)}
                on:channel={(event) => openChannel(event.detail)}
              />
            {/each}
          </div>
        </section>
      {/if}

      <section class="feed-section">
        <div class="section-heading recommendation-heading">
          <div>
            <h2>Recommended</h2>
            <span>{jellyGptRecommendationStatus === 'active' ? 'Powered by jellyGPT' : jellyGptEnabled && jellyGptStatus === 'connected' ? jellyGptRecommendationMessage : musicSources.length ? 'Includes music-video matches' : 'Built-in recommendations'}</span>
          </div>
          <button
            class:connected={jellyGptEnabled && jellyGptStatus === 'connected'}
            class="recommendation-settings-button"
            type="button"
            on:click={openJellyGptSetup}
          >
            <SlidersHorizontal size={17} />
            <span>Recommendation settings</span>
          </button>
        </div>
        <div class="video-grid">
          {#each recommended as item (item.Id)}
            <VideoCard {client} {item} titleContext="recommendation" titleChannel={channelName(item)} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>

      <section class="feed-section">
        <h2>New videos</h2>
        <div class="video-grid">
          {#each recent as item (item.Id)}
            <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
          {/each}
        </div>
      </section>

      {#if popular.length}
        <section class="feed-section">
          <h2>Replay picks</h2>
          <div class="video-grid">
            {#each popular as item (item.Id)}
              <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </main>

  {#if jellyGptPanelOpen}
    <div class="modal-backdrop">
      <div class="jellygpt-panel" role="dialog" aria-modal="true" aria-labelledby="jellygpt-title">
        <div class="jellygpt-panel-heading">
          <div>
            <p class="eyebrow">Optional sidecar</p>
            <h2 id="jellygpt-title">Recommendation settings</h2>
          </div>
          <button class="icon-button" aria-label="Close jellyGPT setup" on:click={closeJellyGptSetup}>×</button>
        </div>

        <p class="jellygpt-panel-copy">
          Connect JellyTube to jellyGPT for cached AI recommendation features. JellyTube keeps using built-in recommendations if the sidecar is offline.
        </p>

        <label>
          jellyGPT URL
          <div class="field-shell">
            <Server size={17} />
            <input bind:value={jellyGptUrl} placeholder="http://127.0.0.1:8787" aria-label="jellyGPT URL" />
          </div>
        </label>

        <div class="algorithm-settings">
          <div class="algorithm-settings-heading">
            <strong>Recommendation system</strong>
            <span>{jellyGptAlgorithmsLoading ? 'Loading from jellyGPT…' : `${jellyGptAlgorithms.length} available`}</span>
          </div>
          <div class="algorithm-grid" role="radiogroup" aria-label="Recommendation system">
            {#each jellyGptAlgorithms as algorithm (algorithm.id)}
              <button
                class:selected={jellyGptSelectedAlgorithm === algorithm.id}
                class="algorithm-card"
                type="button"
                role="radio"
                aria-checked={jellyGptSelectedAlgorithm === algorithm.id}
                disabled={!algorithm.available}
                title={algorithm.reason ?? algorithm.name}
                on:click={() => selectJellyGptAlgorithm(algorithm.id)}
              >
                <span>{algorithm.name}</span>
                <small>{algorithm.available ? algorithm.id : algorithm.reason ?? 'Unavailable'}</small>
              </button>
            {/each}
          </div>
        </div>

        <div class:connected={jellyGptStatus === 'connected'} class:error-state={jellyGptStatus === 'error'} class="jellygpt-status">
          <SlidersHorizontal size={16} />
          <span>{jellyGptStatusMessage}</span>
        </div>

        <div class:connected={jellyGptRecommendationStatus === 'active'} class:error-state={jellyGptRecommendationStatus === 'error'} class="jellygpt-status">
          <SlidersHorizontal size={16} />
          <span>{jellyGptRecommendationMessage}{jellyGptLastRecommendationAt ? ` Last updated ${relativeDate(jellyGptLastRecommendationAt)}.` : ''}</span>
        </div>

        <div class="jellygpt-actions">
          <button class="primary-action" type="button" on:click={saveJellyGptConnection} disabled={jellyGptStatus === 'checking'}>
            Save & test
          </button>
          <button class="secondary-action" type="button" on:click={checkJellyGptConnection} disabled={jellyGptStatus === 'checking'}>
            Test connection
          </button>
          <button class="text-action" type="button" on:click={disconnectJellyGpt}>Disable</button>
        </div>
      </div>
    </div>
  {/if}
</div>
