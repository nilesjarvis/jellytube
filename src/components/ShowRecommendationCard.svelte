<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { JellyfinClient } from '../lib/jellyfin';
  import type { ShowRecommendation } from '../lib/showRecommendations';

  export let client: JellyfinClient;
  export let recommendation: ShowRecommendation;
  export let compact = false;

  const dispatch = createEventDispatcher<{
    play: ShowRecommendation;
    show: string;
  }>();

  $: title = recommendation.title;
  $: progress = recommendation.progress;
  $: primaryEpisode = progress.primaryItem ?? recommendation.representative;
  $: imageUrl = recommendation.seriesItem
    ? client.getBackdropUrl(recommendation.seriesItem, 640) ||
      client.getImageUrl(recommendation.seriesItem, 640) ||
      client.getImageUrl(primaryEpisode, 640)
    : client.getImageUrl(primaryEpisode, 640);
  $: playLabel = `Play ${title}: ${progress.label}`;
  $: progressLabel = `${progress.label} · ${progress.watchedCount}/${progress.totalCount} watched`;
</script>

<article class:compact class="video-card show-recommendation-card">
  <button
    class="thumbnail-button"
    type="button"
    on:click={() => dispatch('play', recommendation)}
    aria-label={playLabel}
  >
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumbnail-fallback">{title.slice(0, 1)}</div>
    {/if}
    <span class="content-pill show-recommendation-pill">Show</span>
    {#if progress.progressPercent > 0}
      <span class="progress-bar" style={`width: ${progress.progressPercent}%`}></span>
    {/if}
  </button>

  <div class="video-copy show-recommendation-copy">
    <button
      class="video-title"
      type="button"
      on:click={() => dispatch('play', recommendation)}
      aria-label={playLabel}
    >{title}</button>
    <button
      class="video-channel"
      type="button"
      on:click={() => dispatch('show', title)}
      aria-label={`View show ${title}`}
    >View show</button>
    {#if recommendation.reason?.trim()}
      <div class="video-recommendation-reason">{recommendation.reason.trim()}</div>
    {/if}
    <div class="video-meta">{progressLabel}</div>
  </div>
</article>
