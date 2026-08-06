<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Play } from 'lucide-svelte';
  import type { JellyfinClient } from '../../lib/jellyfin';
  import { displayTitle } from '../../lib/recommendations';
  import type { JellyfinItem } from '../../lib/types';

  export let client: JellyfinClient;
  export let album: JellyfinItem;

  const dispatch = createEventDispatcher<{ select: JellyfinItem }>();

  $: artist = album.AlbumArtist || album.Artists?.join(', ') || '';
  $: year = album.ProductionYear ? String(album.ProductionYear) : '';
  $: imageUrl = client.getImageUrl(album, 360);
  $: title = displayTitle(album);
</script>

<button class="music-album-card" aria-label={`Play ${title}`} on:click={() => dispatch('select', album)}>
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
  <strong class="music-album-title">{title}</strong>
  {#if artist || year}
    <span class="music-album-sub">{artist}{artist && year ? ' · ' : ''}{year}</span>
  {/if}
</button>

<style>
  .music-album-card {
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--text);
    text-align: left;
    background: transparent;
  }
  .music-album-card:hover .music-play-overlay {
    opacity: 1;
  }
  .music-album-card:focus-visible .music-play-overlay {
    opacity: 1;
  }
  .music-album-card:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 4px;
    border-radius: 8px;
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
  .music-album-title {
    overflow: hidden;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .music-album-sub {
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
