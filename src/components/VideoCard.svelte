<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { JellyfinClient } from '../lib/jellyfin';
  import {
    channelName,
    compactMeta,
    displayTitle,
    formatDuration,
    playbackProgress
  } from '../lib/recommendations';
  import type { JellyfinItem } from '../lib/types';

  export let client: JellyfinClient;
  export let item: JellyfinItem;
  export let compact = false;
  export let poster = false;

  const dispatch = createEventDispatcher<{ select: JellyfinItem; channel: string }>();

  $: imageUrl = client.getImageUrl(item, compact ? 320 : 640);
  $: progress = playbackProgress(item);
  $: channel = channelName(item);
</script>

<article class:compact class:poster class="video-card">
  <button class="thumbnail-button" on:click={() => dispatch('select', item)} aria-label={displayTitle(item)}>
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumbnail-fallback">{item.Name.slice(0, 1)}</div>
    {/if}
    {#if formatDuration(item.RunTimeTicks)}
      <span class="duration">{formatDuration(item.RunTimeTicks)}</span>
    {/if}
    {#if progress > 0 && progress < 95}
      <span class="progress-bar" style={`width: ${progress}%`}></span>
    {/if}
  </button>

  <div class="video-copy">
    <button class="video-title" on:click={() => dispatch('select', item)}>{displayTitle(item)}</button>
    <button class="video-channel" on:click={() => dispatch('channel', channel)}>{channel}</button>
    <div class="video-meta">{compactMeta(item)}</div>
  </div>
</article>
