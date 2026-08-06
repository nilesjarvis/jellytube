<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Play } from 'lucide-svelte';
  import type { JellyfinClient } from '../../lib/jellyfin';
  import { displayTitle } from '../../lib/recommendations';
  import type { JellyfinItem } from '../../lib/types';

  export let client: JellyfinClient;
  export let album: JellyfinItem;

  // play = play the album, open = go to the album page, artist = go to the artist
  const dispatch = createEventDispatcher<{ play: JellyfinItem; open: JellyfinItem; artist: JellyfinItem }>();

  $: artist = album.AlbumArtist || album.Artists?.join(', ') || '';
  $: imageUrl = client.getImageUrl(album, 360);
  $: title = displayTitle(album);
  $: hasArtist = artist.length > 0;
</script>

<div class="music-album-card">
  <button class="music-album-art-btn" aria-label={"Play album " + title} on:click={() => dispatch('play', album)}>
    <span class="music-album-art">
      {#if imageUrl}
        <img src={imageUrl} alt="" loading="lazy" />
      {:else}
        <span class="music-art-fallback">{title.slice(0, 1)}</span>
      {/if}
      <span class="music-play-overlay">
        <Play size={22} fill="currentColor" aria-hidden="true" />
      </span>
    </span>
  </button>

  <button class="music-album-title" on:click={() => dispatch('open', album)}>{title}</button>

  {#if hasArtist}
    <button class="music-album-artist" on:click={() => dispatch('artist', album)}>{artist}</button>
  {/if}
</div>

<style>
  .music-album-card {
    min-width: 0;
    display: grid;
    gap: 7px;
  }
  .music-album-art-btn {
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
  }
  .music-album-art {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 8px;
    background: var(--soft);
  }
  .music-album-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .music-art-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 2.4rem;
    font-weight: 800;
    color: var(--muted);
  }
  .music-play-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(180deg, transparent 40%, rgba(0, 0, 0, 0.45));
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .music-play-overlay :global(svg) {
    fill: currentColor;
  }
  .music-album-art-btn:hover .music-play-overlay,
  .music-album-art-btn:focus-visible .music-play-overlay {
    opacity: 1;
  }
  .music-album-art-btn:focus-visible {
    outline: none;
  }
  .music-album-title,
  .music-album-artist {
    overflow: hidden;
    padding: 0;
    border: 0;
    text-align: left;
    background: transparent;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .music-album-title {
    color: var(--text);
    font-weight: 600;
    font-size: 0.95rem;
    line-height: 1.25;
  }
  .music-album-title:hover {
    color: var(--muted);
  }
  .music-album-artist {
    margin-top: -3px;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .music-album-artist:hover,
  .music-album-artist:focus-visible {
    color: var(--focus);
    text-decoration: underline;
  }
</style>
