<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Play } from 'lucide-svelte';
  import { formatDuration } from '../../lib/recommendations';
  import type { JellyfinItem } from '../../lib/types';

  export let song: JellyfinItem;
  export let active = false;
  export let playingNow = false;
  /** When set, shows a plain rank (e.g. a countdown list) instead of the album track number. */
  export let rank: number | null = null;

  const dispatch = createEventDispatcher<{ select: JellyfinItem }>();

  $: trackNumber =
    rank !== null ? String(rank) : song.IndexNumber ? String(song.IndexNumber).padStart(2, '0') : '';
  $: artist = song.AlbumArtist || song.Artists?.join(', ') || '';
</script>

<button
  class:active
  class="music-song-row"
  aria-pressed={active}
  on:click={() => dispatch('select', song)}
>
  <span class="music-song-track">
    {#if active && playingNow}
      <span class="music-eq" aria-hidden="true"><i></i><i></i><i></i></span>
    {:else}
      {trackNumber}
    {/if}
  </span>
  <span class="music-song-title">{song.Name}</span>
  <span class="music-song-artist">{artist}</span>
  <span class="music-song-album">{song.Album}</span>
  <span class="music-song-duration">{formatDuration(song.RunTimeTicks)}</span>
  <span class="music-song-play"><Play size={16} fill="currentColor" /></span>
</button>

<style>
  .music-song-row {
    display: grid;
    grid-template-columns: 2.6rem minmax(0, 3fr) minmax(0, 2fr) minmax(0, 2fr) auto auto;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 6px;
    color: var(--text);
    text-align: left;
    background: transparent;
  }
  .music-song-row:hover {
    background: var(--soft);
  }
  .music-song-row.active {
    background: var(--soft-2);
  }
  .music-song-row.active :global(.music-song-title) {
    color: var(--focus);
  }
  .music-song-row:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .music-song-track,
  .music-song-duration {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .music-song-title,
  .music-song-artist,
  .music-song-album {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .music-song-title {
    font-weight: 600;
  }
  .music-song-artist,
  .music-song-album {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .music-song-play {
    display: inline-flex;
    color: var(--muted);
    opacity: 0;
  }
  .music-song-row:hover .music-song-play,
  .music-song-row.active .music-song-play {
    opacity: 1;
  }
  .music-eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .music-eq i {
    width: 3px;
    border-radius: 2px;
    background: var(--focus);
    animation: musicEq 1s ease-in-out infinite;
  }
  .music-eq i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .music-eq i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes musicEq {
    0%, 100% { height: 4px; }
    50% { height: 14px; }
  }
  @media (max-width: 720px) {
    .music-song-row {
      grid-template-columns: 2.2rem minmax(0, 3fr) minmax(0, 2fr) auto;
    }
    .music-song-album {
      display: none;
    }
  }
</style>
