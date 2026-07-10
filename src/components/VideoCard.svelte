<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type Hls from 'hls.js';
  import type { JellyfinClient } from '../lib/jellyfin';
  import {
    canDirectPreview,
    claimHoverPreview,
    directStreamExtension,
    getCachedPreviewPlaybackInfo,
    HOVER_PREVIEW_DELAY_MS,
    HOVER_PREVIEW_HLS_BUFFER_SECONDS,
    HOVER_PREVIEW_HLS_MAX_BUFFER_SECONDS,
    HOVER_PREVIEW_HLS_MAX_BUFFER_SIZE,
    isHoverPreviewEligible,
    isDirectPreviewLightweight,
    previewHlsOptions,
    releaseHoverPreview,
    supportsNativeHls
  } from '../lib/hoverPreview';
  import {
    channelName,
    compactMeta,
    displayTitle,
    formatDuration,
    playbackProgress,
    shouldStartFromBeginning
  } from '../lib/recommendations';
  import { episodeCode } from '../lib/episodes';
  import type { JellyfinItem } from '../lib/types';

  export let client: JellyfinClient;
  export let item: JellyfinItem;
  export let compact = false;
  export let poster = false;
  export let titleContext: 'feed' | 'series' | 'channel' | 'recommendation' = 'feed';
  export let titleChannel = '';
  export let recommendationReason = '';

  const dispatch = createEventDispatcher<{ select: JellyfinItem; channel: string }>();

  let previewVideo: HTMLVideoElement;
  let previewTimer = 0;
  let previewRequestId = 0;
  let previewReady = false;
  let previewLoading = false;
  let previewFailed = false;
  let previewConfirmed = false;
  let previewHovering = false;
  let previewPlayStarted = false;
  let suppressPreviewErrors = false;
  let hls: Hls | null = null;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  $: imageUrl = client.getImageUrl(item, compact ? 320 : 640);
  $: progress = playbackProgress(item);
  $: showProgress = progress > 0 && progress < 95 && !shouldStartFromBeginning(item);
  $: previewEligible = isHoverPreviewEligible(item, { poster, finePointer, reducedMotion });
  $: showPreviewLoading = previewHovering && !previewFailed && !(previewConfirmed && previewReady);
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
  $: readableRecommendationReason = recommendationReason?.trim() ?? '';

  onDestroy(() => stopPreview());

  function beginPreview(event: PointerEvent) {
    if (!previewEligible || event.pointerType !== 'mouse') return;
    window.clearTimeout(previewTimer);
    const requestId = previewRequestId + 1;
    previewRequestId = requestId;
    previewLoading = true;
    previewReady = false;
    previewFailed = false;
    previewConfirmed = false;
    previewHovering = true;
    previewPlayStarted = false;
    claimHoverPreview(stopPreview);
    teardownPreviewSource();

    previewTimer = window.setTimeout(() => {
      if (requestId !== previewRequestId) return;
      previewConfirmed = true;
      void playPreparedPreview(requestId);
    }, HOVER_PREVIEW_DELAY_MS);
    void warmPreview(requestId);
  }

  async function warmPreview(requestId: number) {
    if (!previewEligible || !previewVideo) return;
    try {
      const playbackInfo = await getCachedPreviewPlaybackInfo(client, item.Id);
      if (requestId !== previewRequestId) return;
      const mediaSource = playbackInfo.MediaSources[0];
      if (!mediaSource) throw new Error('No preview media source.');

      previewVideo.preload = 'auto';
      const extension = directStreamExtension(mediaSource);
      if (canDirectPreview(mediaSource, previewVideo, extension) && isDirectPreviewLightweight(mediaSource)) {
        previewVideo.src = client.getStreamUrl(item.Id, mediaSource.Id, extension);
        previewVideo.load();
      } else if (mediaSource.SupportsTranscoding !== false) {
        const previewUrl = client.getHlsUrl(item.Id, mediaSource.Id, previewHlsOptions(mediaSource, playbackInfo.PlaySessionId));
        if (supportsNativeHls(previewVideo)) {
          previewVideo.src = previewUrl;
          previewVideo.load();
        } else {
          const { default: HlsPlayer } = await import('hls.js');
          if (requestId !== previewRequestId) return;
          if (!HlsPlayer.isSupported()) throw new Error('Preview HLS is unavailable.');
          hls = new HlsPlayer({
            lowLatencyMode: false,
            autoStartLoad: true,
            backBufferLength: 0,
            maxBufferLength: HOVER_PREVIEW_HLS_BUFFER_SECONDS,
            maxMaxBufferLength: HOVER_PREVIEW_HLS_MAX_BUFFER_SECONDS,
            maxBufferSize: HOVER_PREVIEW_HLS_MAX_BUFFER_SIZE,
            capLevelToPlayerSize: true
          });
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (data.fatal) handlePreviewError();
          });
          hls.loadSource(previewUrl);
          hls.attachMedia(previewVideo);
        }
      } else {
        throw new Error('No browser-compatible preview stream.');
      }

      if (previewConfirmed) await playPreparedPreview(requestId);
    } catch {
      if (requestId === previewRequestId) {
        previewFailed = true;
        stopPreview();
      }
    } finally {
      if (requestId === previewRequestId) previewLoading = false;
    }
  }

  async function playPreparedPreview(requestId: number) {
    if (requestId !== previewRequestId || previewPlayStarted || !previewVideo) return;
    if (!previewVideo.currentSrc && !hls) return;
    previewPlayStarted = true;

    try {
      previewVideo.muted = true;
      await previewVideo.play();
      if (requestId === previewRequestId) previewReady = true;
    } catch {
      if (requestId === previewRequestId) {
        previewFailed = true;
        stopPreview();
      }
    }
  }

  function stopPreview() {
    window.clearTimeout(previewTimer);
    previewTimer = 0;
    previewRequestId += 1;
    previewLoading = false;
    previewReady = false;
    previewConfirmed = false;
    previewHovering = false;
    previewPlayStarted = false;
    releaseHoverPreview(stopPreview);
    teardownPreviewSource();
  }

  function teardownPreviewSource() {
    hls?.destroy();
    hls = null;
    if (!previewVideo) return;
    suppressPreviewErrors = true;
    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewVideo.preload = 'none';
    previewVideo.load();
    window.setTimeout(() => {
      suppressPreviewErrors = false;
    }, 0);
  }

  function handlePreviewReady() {
    if (!previewVideo?.currentSrc) return;
    previewReady = true;
  }

  function handlePreviewError() {
    if (suppressPreviewErrors) return;
    previewFailed = true;
    stopPreview();
  }
</script>

<article class:compact class:poster class="video-card">
  <button
    class:preview-ready={previewConfirmed && previewReady}
    class:preview-failed={previewFailed}
    class:preview-loading={showPreviewLoading}
    class="thumbnail-button"
    on:pointerenter={beginPreview}
    on:pointerleave={stopPreview}
    on:pointercancel={stopPreview}
    on:click={() => dispatch('select', item)}
    aria-label={title}
  >
    {#if imageUrl}
      <img src={imageUrl} alt="" loading="lazy" />
    {:else}
      <div class="thumbnail-fallback">{item.Name.slice(0, 1)}</div>
    {/if}
    {#if previewEligible}
      <video
        bind:this={previewVideo}
        class="thumbnail-preview"
        muted
        playsinline
        preload="none"
        aria-hidden="true"
        on:canplay={handlePreviewReady}
        on:playing={handlePreviewReady}
        on:error={handlePreviewError}
      ></video>
    {/if}
    {#if formatDuration(item.RunTimeTicks)}
      <span class="duration">{formatDuration(item.RunTimeTicks)}</span>
    {/if}
    {#if showProgress && !showPreviewLoading}
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
    {#if readableRecommendationReason}
      <div class="video-recommendation-reason">{readableRecommendationReason}</div>
    {/if}
    <div class="video-meta">{compactMeta(item)}</div>
  </div>
</article>
