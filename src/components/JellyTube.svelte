<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import {
    Clapperboard,
    Home,
    Library,
    ListVideo,
    Loader2,
    LogOut,
    Menu,
    Moon,
    Music2,
    Play,
    RefreshCcw,
    RotateCcw,
    Search,
    Server,
    Sun,
    UserCircle,
    UsersRound
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
    rankRecommendations
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

  let recent: JellyfinItem[] = [];
  let resume: JellyfinItem[] = [];
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

  onMount(() => {
    applyTheme();
    const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      if (themeMode === 'system') applyTheme();
    };
    colorSchemeQuery.addEventListener('change', handleSystemThemeChange);
    window.addEventListener('popstate', handlePopState);
    void initializeApp();
    return () => {
      colorSchemeQuery.removeEventListener('change', handleSystemThemeChange);
      window.removeEventListener('popstate', handlePopState);
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
      resume = continueWatching(mergeItems(videoResume, videoPool, musicPool)).slice(0, 24);
      recommended = rankRecommendations(mergeItems(videoPool, musicPool), activity).slice(0, 48);
      popular = popularItems(mergeItems(videoPool, musicPool)).slice(0, 24);
      movies = movieRecent;
      movieResume = continueWatching(mergeItems(movieResumeItems, moviePool)).slice(0, 18);
      moviePopular = rankRecommendations(moviePool, activity).slice(0, 36);
      musicVideos = mergeItems(musicRecentByRelease, musicRecentByAdded).sort(compareByContentDateDesc).slice(0, 100);
      musicRecommended = rankRecommendations(musicPool, activity).slice(0, 36);
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

    const mixChannel = nextRoute.list === 'mix' ? nextRoute.channel?.trim() ?? '' : '';
    const queue = mixChannel ? mixQueueFor(mixChannel, item) : [];
    await ensureSeriesEpisodes(item);
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
    const queue = musicPool
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

  function relatedFor(item: JellyfinItem | null) {
    const pool = item?.contentKind === 'movie' ? moviePool : mergeItems(videoPool, musicPool);
    const ranked = rankRecommendations(pool, activity, item);
    if (!item) return ranked.slice(0, 28);
    const recommendationPool = episodeInfo(item)
      ? ranked.filter((candidate) => !sameEpisodeSeries(candidate, item))
      : ranked;
    const currentChannel = channelName(item).toLowerCase();
    const sameChannel = recommendationPool.filter((candidate) => channelName(candidate).toLowerCase() === currentChannel);
    const other = recommendationPool.filter((candidate) => channelName(candidate).toLowerCase() !== currentChannel);
    return [...sameChannel, ...other].slice(0, 28);
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      <span>Subs</span>
    </button>
    <button class:active={route === 'channel'} on:click={() => selectedChannel && goRoute('channel')} disabled={!selectedChannel}>
      <UsersRound size={21} />
      <span>Channel</span>
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
    <button on:click={loadAll}>
      <RefreshCcw size={20} />
      <span>Refresh</span>
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
          recommendations={relatedFor(selectedItem)}
          on:back={goBackOrHome}
          on:select={(event) => openItem(event.detail)}
          on:queueSelect={(event) => openItem(event.detail, watchQueue, watchQueueTitle, true)}
          on:episodeSelect={(event) => openItem(event.detail, watchQueue, watchQueueTitle, true)}
          on:episodeSeason={(event) => (selectedEpisodeSeason = event.detail)}
          on:channel={(event) => openChannel(event.detail)}
          on:movies={() => navigateTo({ view: 'movies' })}
          on:next={playNextQueued}
        />
      {/key}
    {:else if error}
      <div class="empty-state">
        <p>{error}</p>
        <button class="secondary-action" on:click={loadAll}>Try again</button>
      </div>
    {:else if loading}
      <div class="loading-state">
        <Loader2 size={28} class="spin" />
      </div>
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
          <div class="movie-grid">
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

      {#if latestDirectoryVideos.length}
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
        </section>
      {/if}

      {#if channelLoading}
        <div class="loading-state compact">
          <Loader2 size={24} class="spin" />
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
          <div class="loading-state compact">
            <Loader2 size={24} class="spin" />
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
          <div class="video-grid">
            {#each resume as item (item.Id)}
              <VideoCard {client} {item} on:select={(event) => openItem(event.detail)} on:channel={(event) => openChannel(event.detail)} />
            {/each}
          </div>
        </section>
      {/if}

      <section class="feed-section">
        <div class="section-heading">
          <h2>Recommended</h2>
          {#if musicSources.length}
            <span>Includes music-video matches</span>
          {/if}
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
</div>
