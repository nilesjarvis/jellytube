<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { JellyfinClient } from '../lib/jellyfin';
  import type { JellyfinItem } from '../lib/types';

  export let client: JellyfinClient;
  /** Representative item from the newly-added feed (an episode or a Series). */
  export let item: JellyfinItem;
  /** Full Series item when one is available in the local catalog. */
  export let seriesItem: JellyfinItem | null = null;
  /** Number of episodes added for this show in the current feed window. */
  export let newEpisodeCount = 1;

  const dispatch = createEventDispatcher<{ show: string }>();

  $: title = seriesItem?.Name || item.SeriesName || item.Name;

  $: imageUrl =
    (seriesItem &&
      (client.getBackdropUrl(seriesItem, 640) || client.getImageUrl(seriesItem, 640))) ||
    client.getImageUrl(item, 640);

  $: meta =
    newEpisodeCount > 1
      ? `${newEpisodeCount} new episodes`
      : newEpisodeCount === 1
        ? 'Newly added episode'
        : 'Newly added';

  function openShow() {
    dispatch('show', title);
  }
</script>

<article class="video-card">
  <button
    class="thumbnail-button"
    type="button"
    on:click={openShow}
    aria-label={title}
  >
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumbnail-fallback">{title.slice(0, 1)}</div>
    {/if}
    <span class="content-pill show-recommendation-pill">Show</span>
  </button>

  <div class="video-copy show-recommendation-copy">
    <button class="video-title" type="button" on:click={openShow} aria-label={title}>
      {title}
    </button>
    <button
      class="video-channel"
      type="button"
      on:click={openShow}
      aria-label={`View show ${title}`}
    >View show</button>
    <div class="video-meta">{meta}</div>
  </div>
</article>
