<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowLeft, Music2, Play } from 'lucide-svelte';
  import type { JellyfinClient } from '../../lib/jellyfin';
  import type { SelectedLibrary, JellyfinItem } from '../../lib/types';
  import { playTracks } from '../../lib/music/store';
  import MusicAlbumCard from './MusicAlbumCard.svelte';
  import MusicSongRow from './MusicSongRow.svelte';

  export let client: JellyfinClient;
  export let sources: SelectedLibrary[];

  let loading = true;
  let error = '';
  let albums: JellyfinItem[] = [];
  let artists: JellyfinItem[] = [];
  let songs: JellyfinItem[] = [];
  let artistAlbums: JellyfinItem[] = [];
  let activeArtist: JellyfinItem | null = null;

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

  async function playAlbum(album: JellyfinItem) {
    try {
      const response = await client.getAlbumTracks(album.Id);
      const tracks = response.Items ?? [];
      if (tracks.length) playTracks(tracks, 0, true);
    } catch {
      error = 'Could not load this album.';
    }
  }

  function playSongs(list: JellyfinItem[], startIndex: number) {
    if (list.length) playTracks(list, startIndex, true);
  }

  async function openArtist(artist: JellyfinItem) {
    activeArtist = artist;
    artistAlbums = [];
    try {
      const response = await client.getArtistAlbums(artist.Id, 80);
      artistAlbums = response.Items ?? [];
    } catch {
      artistAlbums = [];
    }
  }

  async function playArtist(artist: JellyfinItem | null) {
    if (!artist) return;
    try {
      const groups = await Promise.all(
        sources.map((source) =>
          client
            .getItems({
              parentId: source.id,
              itemTypes: 'Audio',
              artistIds: artist.Id,
              limit: 120,
              sortBy: 'SortName',
              sortOrder: 'Ascending'
            })
            .then((response) => response.Items ?? [])
        )
      );
      const tracks = merge(groups);
      if (tracks.length) playTracks(tracks, 0, true);
    } catch {
      error = 'Could not start this artist mix.';
    }
  }

  function closeArtist() {
    activeArtist = null;
    artistAlbums = [];
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
{:else}
  <section class="feed-section">
    <div class="section-heading">
      <div class="music-page-title">
        <h2>{activeArtist?.Name ?? 'Music'}</h2>
        <span>{activeArtist ? activeArtist.Name + ' albums' : sources.length + ' selected music library' + (sources.length === 1 ? '' : 's')}</span>
      </div>
      <div class="section-actions">
        {#if activeArtist}
          <button class="text-action" on:click={closeArtist}><ArrowLeft size={16} /> Back</button>
          <button class="text-action" on:click={() => playArtist(activeArtist)}><Play size={15} fill="currentColor" /> Play artist</button>
        {:else}
          <button class="text-action" on:click={() => playSongs(songs, 0)}><Play size={15} fill="currentColor" /> Play all songs</button>
        {/if}
      </div>
    </div>

    {#if activeArtist}
      <div class="music-albums-grid">
        {#each artistAlbums as album (album.Id)}
          <MusicAlbumCard {client} {album} on:select={(event) => playAlbum(event.detail)} />
        {/each}
      </div>
    {:else}
      <div class="music-albums-grid">
        {#each albums as album (album.Id)}
          <MusicAlbumCard {client} {album} on:select={(event) => playAlbum(event.detail)} />
        {/each}
      </div>
    {/if}
  </section>

  {#if !activeArtist && artists.length}
    <section class="feed-section">
      <div class="section-heading"><h2>Artists</h2><span>{artists.length} total</span></div>
      <div class="music-artists-grid">
        {#each artists as artist (artist.Id)}
          <button class="music-artist" on:click={() => openArtist(artist)} on:auxclick={(event) => { if (event.button === 1) void playArtist(artist); }}>
            <span class="music-artist-art">
              {#if client.getImageUrl(artist, 220)}
                <img src={client.getImageUrl(artist, 220)} alt="" loading="lazy" />
              {:else}
                <span>{artist.Name.slice(0, 1)}</span>
              {/if}
            </span>
            <span class="music-artist-name">{artist.Name}</span>
            <span class="music-artist-hint">Play</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if songs.length}
    <section class="feed-section">
      <div class="section-heading"><h2>New songs</h2><span>{songs.length} recent</span></div>
      <div class="music-song-list">
        {#each songs as song, index (song.Id)}
          <MusicSongRow {song} on:select={() => playSongs(songs, index)} />
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
  .music-artist {
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--text);
    text-align: left;
    background: transparent;
  }
  .music-artist:hover .music-artist-hint,
  .music-artist:focus-visible .music-artist-hint {
    opacity: 1;
  }
  .music-artist:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 4px;
    border-radius: 50%;
  }
  .music-artist-art {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    background: var(--soft);
    color: var(--muted);
    font-size: 1.8rem;
    font-weight: 800;
  }
  .music-artist-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .music-artist-name {
    overflow: hidden;
    text-align: center;
    font-weight: 600;
    font-size: 0.92rem;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .music-artist-hint {
    margin-top: -4px;
    color: var(--muted);
    font-size: 0.8rem;
    text-align: center;
    opacity: 0;
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
    border-radius: 8px;
    background: var(--soft);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
