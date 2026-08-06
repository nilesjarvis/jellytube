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
  <span class="music-album-art-wrap">
    <button class="music-album-art-btn" aria-label={"Open album " + title} on:click={() => dispatch('open', album)}>
      <span class="music-album-art">
        {#if imageUrl}
          <img src={imageUrl} alt="" loading="lazy" />
        {:else}
          <span class="music-art-fallback">{title.slice(0, 1)}</span>
        {/if}
      </span>
    </button>
    <button class="music-album-play" aria-label={"Play album " + title} title={"Play " + title} on:click={() => dispatch('play', album)}>
      <Play size={18} fill="currentColor" aria-hidden="true" />
    </button>
  </span>

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
  .music-album-art-wrap {
    position: relative;
    display: block;
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
  .music-album-art-btn:hover .music-album-art {
    transform: scale(1.02);
  }
  .music-album-art-btn:focus-visible .music-album-art {
    box-shadow: 0 0 0 3px var(--focus);
  }
  .music-album-art-btn:focus-visible {
    outline: none;
  }
  .music-album-art {
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .music-album-play {
    position: absolute;
    right: 8px;
    bottom: 8px;
    z-index: 2;
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
  .music-album-card:hover .music-album-play,
  .music-album-card:focus-within .music-album-play {
    opacity: 1;
    transform: translateY(0);
  }
  .music-album-play:hover {
    background: var(--brand);
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
