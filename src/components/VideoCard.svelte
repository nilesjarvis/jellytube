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
  import { episodeCode } from '../lib/episodes';
  import type { JellyfinItem } from '../lib/types';

  export let client: JellyfinClient;
  export let item: JellyfinItem;
  export let compact = false;
  export let poster = false;
  export let titleContext: 'feed' | 'series' | 'channel' | 'recommendation' = 'feed';
  export let titleChannel = '';

  const dispatch = createEventDispatcher<{ select: JellyfinItem; channel: string }>();

  $: imageUrl = client.getImageUrl(item, compact ? 320 : 640);
  $: progress = playbackProgress(item);
  $: channel = channelName(item);
  $: title = displayTitle(item, { context: titleContext, channel: titleChannel || channel });
  $: episodeLabel = episodeCode(item);
  $: readableRecommendationCode = episodeLabel.length <= 8 ? episodeLabel : '';
  $: contextualEpisodeCode =
    titleContext === 'recommendation'
      ? readableRecommendationCode
      : titleContext !== 'feed'
        ? episodeLabel
        : '';
  $: contextLine =
    titleContext === 'recommendation' && contextualEpisodeCode
      ? `${contextualEpisodeCode} · ${channel}`
      : channel;
</script>

<article class:compact class:poster class="video-card">
  <button class="thumbnail-button" on:click={() => dispatch('select', item)} aria-label={title}>
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
    <button class="video-title" on:click={() => dispatch('select', item)}>{title}</button>
    {#if titleContext === 'recommendation'}
      <button class="video-channel" on:click={() => dispatch('channel', channel)}>{contextLine}</button>
    {:else if contextualEpisodeCode}
      <div class="video-kicker">{contextualEpisodeCode}</div>
    {:else if titleContext === 'feed'}
      <button class="video-channel" on:click={() => dispatch('channel', channel)}>{channel}</button>
    {/if}
    <div class="video-meta">{compactMeta(item)}</div>
  </div>
</article>
