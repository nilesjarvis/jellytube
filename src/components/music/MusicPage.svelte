<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { ArrowLeft, Clock, Disc3, ListMusic, Music2, Play, Shuffle } from 'lucide-svelte';
  import type { JellyfinClient } from '../../lib/jellyfin';
  import type { SelectedLibrary, JellyfinItem } from '../../lib/types';
  import { musicPlayerState, playTracks } from '../../lib/music/store';
  import { formatDuration } from '../../lib/recommendations';
  import { normalizeSearch } from '../../lib/search';
  import MusicAlbumCard from './MusicAlbumCard.svelte';
  import MusicSongRow from './MusicSongRow.svelte';

  export let client: JellyfinClient;
  export let sources: SelectedLibrary[];
  // URL-driven sub-view so browser back/forward works: null = browse grid,
  // otherwise the album/artist being displayed. Passed down from the app router.
  export let item: { kind: 'album' | 'artist'; id: string } | null = null;

  const dispatch = createEventDispatcher<{ navigate: { kind: 'album' | 'artist'; id: string } | null }>();

  let loading = true;
  let error = '';
  let albums: JellyfinItem[] = [];
  let artists: JellyfinItem[] = [];
  let songs: JellyfinItem[] = [];

  // Artist view
  let artistAlbums: JellyfinItem[] = [];
  let artistSongs: JellyfinItem[] = [];
  let artistInfo: JellyfinItem | null = null;
  let activeArtist: JellyfinItem | null = null;
  let artistBusy = false;

  // Album view
  let activeAlbum: JellyfinItem | null = null;
  let albumInfo: JellyfinItem | null = null;
  let albumTracks: JellyfinItem[] = [];
  let albumBusy = false;

  $: musicQueue = $musicPlayerState.queue;
  $: musicCurrentId = $musicPlayerState.currentId;
  $: musicPlaying = $musicPlayerState.playing;
  $: albumDuration = albumTracks.reduce((sum, track) => sum + (track.RunTimeTicks || 0), 0);

  async function reload() {
    if (!sources.length) {
      loading = false;
      albums = [];
      artists = [];
      songs = [];
      return;
    }
    loading = true;
    error = '';
    try {
      const [albumGroups, artistGroups, songGroups] = await Promise.all([
        Promise.all(sources.map((source) => client.getMusicAlbums(source.id, { limit: 120 }))),
        Promise.all(sources.map((source) => client.getMusicArtists(source.id, 120))),
        Promise.all(sources.map((source) => client.getMusicSongs(source.id, { limit: 80 })))
      ]);
      albums = merge(albumGroups.map((group) => group.Items ?? []));
      artists = merge(artistGroups.map((group) => group.Items ?? []));
      songs = merge(songGroups.map((group) => group.Items ?? [])).slice(0, 120);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not load music.';
    } finally {
      loading = false;
    }
  }

  // ---- Playback ----
  function playTrackList(list: JellyfinItem[], startIndex: number) {
    if (list.length) playTracks(list, startIndex, true);
  }

  async function playAlbum(album: JellyfinItem) {
    try {
      const response = await client.getAlbumTracks(album.Id);
      const tracks = response.Items ?? [];
      playTrackList(tracks, 0);
    } catch {
      error = 'Could not load this album.';
    }
  }

  function playAlbumTracks(startIndex: number) {
    playTrackList(albumTracks, startIndex);
  }

  async function fetchArtistAlbums(artist: JellyfinItem) {
    const groups = await Promise.all(
      sources.map((source) => client.getArtistAlbums(artist.Id, source.id, 120))
    );
    return merge(groups.map((group) => group.Items ?? []));
  }

  async function fetchArtistSongs(artist: JellyfinItem) {
    const groups = await Promise.all(
      sources.map((source) => client.getArtistSongs(artist.Id, source.id, 200))
    );
    return merge(groups.map((group) => group.Items ?? []));
  }

  async function playArtist(artist: JellyfinItem | null) {
    if (!artist) return;
    try {
      const tracks = await fetchArtistSongs(artist);
      playTrackList(tracks, 0);
    } catch {
      error = 'Could not start this artist mix.';
    }
  }

  async function playArtistShuffled(artist: JellyfinItem | null) {
    if (!artist) return;
    try {
      const tracks = shuffled(await fetchArtistSongs(artist));
      playTrackList(tracks, 0);
    } catch {
      error = 'Could not shuffle this artist.';
    }
  }

  function shuffled(items: JellyfinItem[]) {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [out[index], out[swapIndex]] = [out[swapIndex], out[index]];
    }
    return out;
  }

  // ---- Artist navigation ----
  async function loadArtist(artist: JellyfinItem) {
    activeArtist = artist;
    activeAlbum = null;
    artistAlbums = [];
    artistSongs = [];
    artistInfo = null;
    artistBusy = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      const [detail, albumItems, songsForArtist] = await Promise.all([
        client.getItem(artist.Id).catch(() => null),
        fetchArtistAlbums(artist),
        fetchArtistSongs(artist)
      ]);
      if (activeArtist?.Id !== artist.Id) return;
      artistInfo = detail;
      artistAlbums = albumItems;
      artistSongs = songsForArtist;
    } catch {
      artistAlbums = [];
    } finally {
      if (activeArtist?.Id === artist.Id) artistBusy = false;
    }
  }

  async function openArtist(artist: JellyfinItem) {
    await loadArtist(artist);
    dispatch('navigate', { kind: 'artist', id: artist.Id });
  }

  function closeArtist() {
    activeArtist = null;
    artistAlbums = [];
    artistSongs = [];
    artistInfo = null;
  }

  function primaryArtistName(album: JellyfinItem) {
    return album.AlbumArtist || album.Artists?.[0] || '';
  }

  async function openArtistFromName(name: string) {
    const normalized = normalizeSearch(name);
    if (!normalized) return;
    const loadedMatch = artists.find((artist) => normalizeSearch(artist.Name) === normalized);
    if (loadedMatch) {
      await openArtist(loadedMatch);
      return;
    }
    for (const source of sources) {
      try {
        const response = await client.getItems({
          parentId: source.id,
          itemTypes: 'MusicArtist',
          searchTerm: name,
          limit: 5,
          sortBy: 'SortName',
          sortOrder: 'Ascending'
        });
        const found = (response.Items ?? []).find(
          (artist) => normalizeSearch(artist.Name) === normalized
        );
        if (found) {
          await openArtist(found);
          return;
        }
      } catch {
        // keep searching other sources
      }
    }
  }

  async function openArtistFromAlbum(album: JellyfinItem | null) {
    if (!album) return;
    const name = primaryArtistName(album);
    if (!name) return;
    const normalized = normalizeSearch(name);
    // Albums link to their primary artist via ArtistItems; use that id directly.
    const linked = album.ArtistItems?.find((item) => normalizeSearch(item.Name) === normalized);
    if (linked?.Id) {
      await openArtist({ Id: linked.Id, Name: linked.Name, Type: 'MusicArtist' });
      return;
    }
    await openArtistFromName(name);
  }

  // ---- Album navigation ----
  async function loadAlbum(album: JellyfinItem) {
    activeAlbum = album;
    albumInfo = null;
    albumTracks = [];
    albumBusy = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      const [detail, trackResponse] = await Promise.all([
        client.getItem(album.Id).catch(() => null),
        client.getAlbumTracks(album.Id)
      ]);
      if (activeAlbum?.Id !== album.Id) return;
      albumInfo = detail;
      albumTracks = trackResponse.Items ?? [];
    } catch {
      albumTracks = [];
    } finally {
      if (activeAlbum?.Id === album.Id) albumBusy = false;
    }
  }

  async function openAlbum(album: JellyfinItem) {
    await loadAlbum(album);
    dispatch('navigate', { kind: 'album', id: album.Id });
  }

  // Load an album from only its id (e.g. deep link), falling back to a direct fetch.
  async function openAlbumById(id: string) {
    try {
      const detail = await client.getItem(id);
      await loadAlbum(detail);
    } catch {
      closeAlbum();
    }
  }

  // Load an artist from only its id (e.g. deep link or back to a search-resolved artist).
  async function openArtistById(id: string) {
    try {
      const detail = await client.getItem(id);
      await loadArtist(detail);
    } catch {
      // nothing to show — leave as-is
    }
  }

  // Sync the visible view to the URL (browser back/forward or deep link).
  $: syncFromUrl(item);

  async function syncFromUrl(next: { kind: 'album' | 'artist'; id: string } | null) {
    if (!next) {
      if (activeAlbum || activeArtist) {
        closeAlbum();
        closeArtist();
      }
      return;
    }
    if (next.kind === 'album') {
      if (activeAlbum?.Id === next.id && !albumBusy) {
        closeArtist();
        return;
      }
      closeArtist();
      const album =
        albums.find((candidate) => candidate.Id === next.id) ||
        artistAlbums.find((candidate) => candidate.Id === next.id);
      if (album) await loadAlbum(album);
      else await openAlbumById(next.id);
    } else {
      if (activeArtist?.Id === next.id && !artistBusy) {
        closeAlbum();
        return;
      }
      closeAlbum();
      const artist = artists.find((candidate) => candidate.Id === next.id);
      if (artist) await loadArtist(artist);
      else await openArtistById(next.id);
    }
  }

  function goBackInMusic() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      dispatch('navigate', null);
    }
  }

  function closeAlbum() {
    activeAlbum = null;
    albumInfo = null;
    albumTracks = [];
  }

  onMount(reload);

  function merge(groups: JellyfinItem[][]) {
    const seen = new Set<string>();
    const out: JellyfinItem[] = [];
    for (const group of groups) {
      for (const item of group) {
        if (seen.has(item.Id)) continue;
        seen.add(item.Id);
        out.push(item);
      }
    }
    return out;
  }

  function albumBackdrop(client: JellyfinClient, album: JellyfinItem) {
    const url = client.getImageUrl(album, 900);
    return url ? `url("${url}")` : 'none';
  }

  function artistBackdrop(client: JellyfinClient, artist: JellyfinItem) {
    const url = client.getImageUrl(artist, 900);
    return url ? `url("${url}")` : 'none';
  }
</script>

{#if loading}
  <div class="feed-section">
    <div class="section-heading"><h2>Music</h2><span>Loading your library…</span></div>
    <div class="music-albums-grid">
      {#each Array.from({ length: 8 }) as _}
        <span class="music-skeleton"></span>
      {/each}
    </div>
  </div>
{:else if !sources.length}
  <div class="empty-state music-empty">
    <Music2 size={40} />
    <h2>No music library connected</h2>
    <p>Add a Jellyfin <strong>Music</strong> library to browse albums, artists, and songs here.</p>
  </div>
{:else if error}
  <div class="empty-state music-empty">
    <p>{error}</p>
  </div>
{:else if activeAlbum && !albumBusy}
  <!-- ======================= ALBUM PAGE ======================= -->
  <div class="music-artist-hero" style="--artist-backdrop:{albumBackdrop(client, activeAlbum)};">
    <button class="music-artist-back" on:click={goBackInMusic} aria-label="Back to music">
      <ArrowLeft size={20} />
    </button>
    <span class="music-album-art-big">
      {#if client.getImageUrl(activeAlbum, 420)}
        <img src={client.getImageUrl(activeAlbum, 420)} alt="" loading="lazy" />
      {:else}
        <span>{activeAlbum.Name.slice(0, 1)}</span>
      {/if}
    </span>
    <div class="music-artist-copy">
      <span class="content-pill">Album</span>
      <h1>{activeAlbum.Name}</h1>
      <div class="music-album-byline">
        {#if primaryArtistName(activeAlbum)}
          <button class="music-artist-link" on:click={() => openArtistFromAlbum(activeAlbum)}>
            {primaryArtistName(activeAlbum)}
          </button>
        {/if}
        {#if albumInfo?.ProductionYear || albumInfo?.Genres?.length}
          <span class="music-album-meta-line">
            {#if albumInfo?.ProductionYear}{albumInfo.ProductionYear}{/if}
            {#if albumInfo?.ProductionYear && albumInfo?.Genres?.length} · {/if}
            {#if albumInfo?.Genres?.length}{albumInfo.Genres[0]}{/if}
          </span>
        {/if}
      </div>
      <div class="music-artist-meta">
        <span><Disc3 size={15} /> {albumTracks.length} {albumTracks.length === 1 ? 'track' : 'tracks'}</span>
        {#if albumDuration}<span><Clock size={15} /> {formatDuration(albumDuration)}</span>{/if}
      </div>
      {#if albumInfo?.Overview}
        <p class="music-artist-bio">{albumInfo.Overview}</p>
      {/if}
      <div class="music-artist-actions">
        <button class="primary-action" on:click={() => playAlbumTracks(0)}>
          <Play size={18} fill="currentColor" /> Play
        </button>
        <button class="secondary-action music-artist-shuffle" on:click={() => playTrackList(shuffled(albumTracks), 0)}>
          <Shuffle size={16} /> Shuffle
        </button>
      </div>
    </div>
  </div>

  <section class="feed-section">
    <div class="section-heading">
      <h2>Tracks</h2>
      <span>{albumTracks.length} songs</span>
    </div>
    <div class="music-song-list">
      {#each albumTracks as song, index (song.Id)}
        <MusicSongRow
          {song}
          active={song.Id === musicCurrentId}
          playingNow={song.Id === musicCurrentId && musicPlaying}
          on:select={() => playAlbumTracks(index)}
        />
      {/each}
    </div>
  </section>

{:else if activeAlbum && albumBusy}
  <div class="music-artist-hero">
    <span class="music-avatar-skeleton"></span>
    <div class="music-artist-copy">
      <span class="music-artist-name-skeleton"></span>
      <span class="music-artist-bio-skeleton"></span>
    </div>
  </div>
  <section class="feed-section">
    <div class="section-heading"><h2>Tracks</h2></div>
    {#each Array.from({ length: 5 }) as _}
      <span class="music-song-skeleton"></span>
    {/each}
  </section>

{:else if activeArtist && !artistBusy}
  <!-- ======================= ARTIST PAGE ======================= -->
  <div class="music-artist-hero" style="--artist-backdrop:{artistBackdrop(client, activeArtist)};">
    <button class="music-artist-back" on:click={goBackInMusic} aria-label="Back to music">
      <ArrowLeft size={20} />
    </button>
    <span class="music-artist-avatar">
      {#if client.getImageUrl(activeArtist, 420)}
        <img src={client.getImageUrl(activeArtist, 420)} alt="" loading="lazy" />
      {:else}
        <span>{activeArtist.Name.slice(0, 1)}</span>
      {/if}
    </span>
    <div class="music-artist-copy">
      <span class="content-pill">Artist</span>
      <h1>{activeArtist.Name}</h1>
      <div class="music-artist-meta">
        {#if artistAlbums.length}<span><Disc3 size={15} /> {artistAlbums.length} {artistAlbums.length === 1 ? 'album' : 'albums'}</span>{/if}
        {#if artistSongs.length}<span><ListMusic size={15} /> {artistSongs.length} {artistSongs.length === 1 ? 'song' : 'songs'}</span>{/if}
        {#if artistInfo?.Genres?.length}<span>{artistInfo.Genres[0]}</span>{/if}
      </div>
      {#if artistInfo?.Overview}
        <p class="music-artist-bio">{artistInfo.Overview}</p>
      {/if}
      <div class="music-artist-actions">
        <button class="primary-action" on:click={() => playArtist(activeArtist)}>
          <Play size={18} fill="currentColor" /> Play
        </button>
        <button class="secondary-action music-artist-shuffle" on:click={() => playArtistShuffled(activeArtist)}>
          <Shuffle size={16} /> Shuffle
        </button>
      </div>
    </div>
  </div>

  {#if artistSongs.length}
    <section class="feed-section">
      <div class="section-heading">
        <h2>Top songs</h2>
        <span>{artistSongs.length} in the library</span>
      </div>
      <div class="music-song-list">
        {#each artistSongs.slice(0, 8) as song, index (song.Id)}
          <MusicSongRow
            {song}
            rank={index + 1}
            active={song.Id === musicCurrentId}
            playingNow={song.Id === musicCurrentId && musicPlaying}
            on:select={() => playTrackList(artistSongs, index)}
          />
        {/each}
      </div>
    </section>
  {/if}

  {#if artistAlbums.length}
    <section class="feed-section">
      <div class="section-heading">
        <h2>Albums</h2>
        <span>{artistAlbums.length} total</span>
      </div>
      <div class="music-albums-grid">
        {#each artistAlbums as album (album.Id)}
          <MusicAlbumCard {client} {album}
            on:play={(event) => playAlbum(event.detail)}
            on:open={(event) => openAlbum(event.detail)}
            on:artist={(event) => openArtistFromAlbum(event.detail)}
          />
        {/each}
      </div>
    </section>
  {/if}

{:else if activeArtist && artistBusy}
  <div class="music-artist-hero">
    <span class="music-avatar-skeleton"></span>
    <div class="music-artist-copy">
      <span class="music-artist-name-skeleton"></span>
      <span class="music-artist-bio-skeleton"></span>
    </div>
  </div>
  <section class="feed-section">
    <div class="section-heading"><h2>Top songs</h2></div>
    {#each Array.from({ length: 5 }) as _}
      <span class="music-song-skeleton"></span>
    {/each}
  </section>
  <section class="feed-section">
    <div class="section-heading"><h2>Albums</h2></div>
    <div class="music-albums-grid">
      {#each Array.from({ length: 6 }) as _}
        <span class="music-skeleton"></span>
      {/each}
    </div>
  </section>

{:else}
  <!-- ======================= BROWSE ======================= -->
  <section class="feed-section">
    <div class="section-heading">
      <div class="music-page-title">
        <h2>Music</h2>
        <span>{sources.length} selected music {sources.length === 1 ? 'library' : 'libraries'}</span>
      </div>
      <div class="section-actions">
        <button class="text-action" on:click={() => playTrackList(songs, 0)}>
          <Play size={15} fill="currentColor" /> Play all songs
        </button>
      </div>
    </div>
    <div class="music-albums-grid">
      {#each albums as album (album.Id)}
        <MusicAlbumCard {client} {album}
          on:play={(event) => playAlbum(event.detail)}
          on:open={(event) => openAlbum(event.detail)}
          on:artist={(event) => openArtistFromAlbum(event.detail)}
        />
      {/each}
    </div>
  </section>

  {#if artists.length}
    <section class="feed-section">
      <div class="section-heading"><h2>Artists</h2><span>{artists.length} in the library</span></div>
      <div class="music-artists-grid">
        {#each artists as artist (artist.Id)}
          <div class="music-artist">
            <button class="music-artist-art-btn" aria-label={"Open artist " + artist.Name} on:click={() => openArtist(artist)}>
              <span class="music-artist-art">
                {#if client.getImageUrl(artist, 320)}
                  <img src={client.getImageUrl(artist, 320)} alt="" loading="lazy" />
                {:else}
                  <span>{artist.Name.slice(0, 1)}</span>
                {/if}
              </span>
            </button>
            <button class="music-artist-play" aria-label={"Play " + artist.Name} title={"Shuffle " + artist.Name} on:click={() => void playArtistShuffled(artist)}>
              <Play size={17} fill="currentColor" />
            </button>
            <button class="music-artist-name" on:click={() => openArtist(artist)}>
              {artist.Name}
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if songs.length}
    <section class="feed-section">
      <div class="section-heading"><h2>New songs</h2><span>{songs.length} recent</span></div>
      <div class="music-song-list">
        {#each songs as song, index (song.Id)}
          <MusicSongRow
            {song}
            active={song.Id === musicCurrentId}
            playingNow={song.Id === musicCurrentId && musicPlaying}
            on:select={() => playTrackList(songs, index)}
          />
        {/each}
      </div>
    </section>
  {/if}
{/if}

<style>
  .music-page-title {
    display: grid;
    gap: 4px;
  }
  .music-albums-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 22px 16px;
  }
  .music-artists-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 22px 16px;
  }

  /* ---- Shared hero ---- */
  .music-artist-hero {
    --artist-backdrop: none;
    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-columns: minmax(150px, 230px) minmax(0, 1fr);
    gap: 28px;
    align-items: center;
    min-height: 320px;
    margin-bottom: 26px;
    padding: 30px;
    overflow: hidden;
    border-radius: 10px;
    background: var(--soft-2);
  }
  .music-artist-hero::before,
  .music-artist-hero::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -2;
    pointer-events: none;
  }
  .music-artist-hero::before {
    background-image: var(--artist-backdrop, none);
    background-position: center;
    background-size: cover;
    opacity: 0.22;
    filter: saturate(1.15) blur(12px);
    transform: scale(1.12);
  }
  .music-artist-hero::after {
    z-index: -1;
    background:
      linear-gradient(90deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 84%, transparent) 55%, color-mix(in srgb, var(--surface) 32%, transparent) 100%),
      linear-gradient(180deg, color-mix(in srgb, var(--surface) 58%, transparent) 0%, var(--surface) 100%);
  }
  .music-artist-back {
    position: absolute;
    top: 14px;
    left: 14px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--muted);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    border: 1px solid var(--border);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .music-artist-back:hover {
    color: var(--text);
    background: var(--soft);
  }
  .music-artist-avatar,
  .music-album-art-big {
    position: relative;
    width: 100%;
    max-width: 230px;
    aspect-ratio: 1;
    align-self: center;
    display: grid;
    place-items: center;
    overflow: hidden;
    border: 4px solid color-mix(in srgb, var(--surface) 85%, transparent);
    background: var(--soft);
    box-shadow: 0 20px 44px var(--shadow);
    color: var(--muted);
    font-size: 3.4rem;
    font-weight: 800;
  }
  .music-artist-avatar {
    border-radius: 50%;
  }
  .music-album-art-big {
    border-radius: 10px;
  }
  .music-artist-avatar img,
  .music-album-art-big img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .music-artist-copy {
    min-width: 0;
    display: grid;
    align-content: center;
    gap: 12px;
    max-width: 940px;
  }
  .music-artist-copy h1 {
    margin: 0;
    font-size: clamp(1.9rem, 4vw, 3.1rem);
    line-height: 1.04;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .music-artist-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 0.94rem;
    font-weight: 650;
  }
  .music-artist-meta span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .music-artist-meta span + span::before {
    content: "•";
    margin-right: 4px;
    color: color-mix(in srgb, var(--muted) 60%, transparent);
  }
  .music-album-byline {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 1.02rem;
    font-weight: 700;
  }
  .music-artist-link {
    padding: 0;
    border: 0;
    color: var(--text);
    font: inherit;
    font-weight: 700;
    background: transparent;
  }
  .music-artist-link:hover {
    color: var(--focus);
    text-decoration: underline;
  }
  .music-album-meta-line {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    font-weight: 600;
  }
  .music-album-meta-line::before {
    content: "•";
    margin-right: 8px;
    color: color-mix(in srgb, var(--muted) 60%, transparent);
  }
  .music-artist-bio {
    display: -webkit-box;
    max-width: 820px;
    margin: 0;
    overflow: hidden;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    color: var(--text);
    line-height: 1.5;
  }
  .music-artist-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 2px;
  }
  .music-artist-shuffle {
    color: var(--text);
  }

  /* ---- Skeletons ---- */
  .music-avatar-skeleton,
  .music-artist-name-skeleton,
  .music-artist-bio-skeleton,
  .music-song-skeleton,
  .music-skeleton {
    display: block;
    border-radius: 8px;
    background: var(--soft);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .music-avatar-skeleton {
    width: 100%;
    max-width: 230px;
    aspect-ratio: 1;
    align-self: center;
    border-radius: 10px;
  }
  .music-artist-name-skeleton {
    width: 45%;
    height: 44px;
  }
  .music-artist-bio-skeleton {
    width: 70%;
    max-width: 540px;
    height: 16px;
  }
  .music-song-skeleton {
    height: 44px;
    margin-bottom: 8px;
  }

  /* ---- Artist grid card (browse) ---- */
  .music-artist {
    min-width: 0;
    position: relative;
    display: grid;
    gap: 8px;
    text-align: center;
  }
  .music-artist-art-btn {
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }
  .music-artist-art {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 50%;
    background: var(--soft);
    color: var(--muted);
    font-size: 1.9rem;
    font-weight: 800;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .music-artist-art-btn:hover .music-artist-art {
    transform: scale(1.03);
  }
  .music-artist-art-btn:focus-visible .music-artist-art {
    box-shadow: 0 0 0 3px var(--focus);
  }
  .music-artist-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .music-artist-play {
    position: absolute;
    right: 6%;
    bottom: 22%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    color: var(--bg);
    background: var(--text);
    box-shadow: 0 4px 12px var(--shadow);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
  }
  .music-artist:hover .music-artist-play,
  .music-artist:focus-within .music-artist-play {
    opacity: 1;
    transform: translateY(0);
  }
  .music-artist-play:hover {
    background: var(--brand);
  }
  .music-artist-name {
    overflow: hidden;
    padding: 0;
    border: 0;
    font-weight: 650;
    font-size: 0.92rem;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    background: transparent;
    text-align: center;
  }
  .music-artist-name:hover {
    color: var(--muted);
  }

  .music-song-list {
    border-top: 1px solid var(--border);
  }
  .music-empty {
    gap: 12px;
  }
  .music-empty p {
    color: var(--muted);
  }
  .music-skeleton {
    height: 150px;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .music-song-list :global(.music-song-row.active) {
    background: var(--soft-2);
  }
  @media (max-width: 720px) {
    .music-artist-hero {
      grid-template-columns: 1fr;
      text-align: left;
      gap: 18px;
      padding: 22px;
    }
    .music-artist-avatar,
    .music-album-art-big {
      width: 150px;
      margin: 8px auto 0;
    }
  }
</style>
