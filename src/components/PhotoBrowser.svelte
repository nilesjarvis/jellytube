<script lang="ts">
  // Browses every selected photo library in one flat, newest-first grid.
  // Clicking a photo opens a lightbox with keyboard navigation.
  import { onDestroy, onMount } from 'svelte';
  import { ChevronLeft, ChevronRight, X } from 'lucide-svelte';
  import type { JellyfinClient } from '../lib/jellyfin';
  import type { JellyfinItem, SelectedLibrary } from '../lib/types';
  import { contentDate, contentDateValue, relativeDate } from '../lib/dates';
  import { displayTitle } from '../lib/recommendations';

  export let client: JellyfinClient;
  export let sources: SelectedLibrary[];

  const PAGE_SIZE = 120;
  const photoFields = 'PrimaryImageAspectRatio,DateCreated,PremiereDate';

  type PhotoPage = { items: JellyfinItem[]; total: number };

  let photos: JellyfinItem[] = [];
  let startIndex = 0;
  let hasMore = false;
  let loading = false;
  let loadingMore = false;
  let error = '';
  let lightboxIndex: number | null = null;
  let closeBtn: HTMLButtonElement | undefined;

  $: lightboxPhoto = lightboxIndex !== null ? photos[lightboxIndex] : null;

  async function fetchPhotoPage(source: SelectedLibrary, offset: number): Promise<PhotoPage> {
    try {
      const response = await client.getItems({
        parentId: source.id,
        itemTypes: 'Photo',
        fields: photoFields,
        sortBy: 'DateCreated',
        sortOrder: 'Descending',
        startIndex: offset,
        limit: PAGE_SIZE
      });
      return { items: response.Items ?? [], total: response.TotalRecordCount };
    } catch {
      return { items: [], total: 0 };
    }
  }

  async function loadPhotos() {
    loading = true;
    error = '';
    const pages = await Promise.all(sources.map((source) => fetchPhotoPage(source, 0)));
    photos = mergePhotos(pages.map((page) => page.items));
    startIndex = PAGE_SIZE;
    hasMore = pages.some((page) => page.total > PAGE_SIZE);
    loading = false;
  }

  async function loadMorePhotos() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    const pages = await Promise.all(sources.map((source) => fetchPhotoPage(source, startIndex)));
    photos = mergePhotos([photos, ...pages.map((page) => page.items)]);
    startIndex += PAGE_SIZE;
    hasMore = pages.some((page) => page.total > startIndex);
    loadingMore = false;
  }

  function mergePhotos(groups: JellyfinItem[][]): JellyfinItem[] {
    const seen = new Set<string>();
    const merged: JellyfinItem[] = [];
    // Interleave by group so several libraries stay mixed by date instead of
    // one library monopolizing the first page.
    const longest = Math.max(0, ...groups.map((group) => group.length));
    for (let index = 0; index < longest; index += 1) {
      for (const group of groups) {
        const item = group[index];
        if (item && !seen.has(item.Id)) {
          seen.add(item.Id);
          merged.push(item);
        }
      }
    }
    return merged.sort((a, b) => contentDateValue(b) - contentDateValue(a));
  }

  function openLightbox(index: number) {
    lightboxIndex = index;
  }

  function closeLightbox() {
    lightboxIndex = null;
  }

  function stepLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next < 0 || next >= photos.length) return;
    lightboxIndex = next;
  }

  function onKeydown(event: KeyboardEvent) {
    if (lightboxIndex === null) return;
    if (event.key === 'Escape') closeLightbox();
    else if (event.key === 'ArrowLeft') stepLightbox(-1);
    else if (event.key === 'ArrowRight') stepLightbox(1);
  }

  function onBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) closeLightbox();
  }

  function photoThumb(item: JellyfinItem) {
    return client.getImageUrl(item, 480);
  }

  function photoFull(item: JellyfinItem) {
    return client.getImageUrl(item, 1920);
  }

  onMount(() => {
    void loadPhotos();
  });

  $: if (lightboxIndex !== null && closeBtn) closeBtn.focus();

  onDestroy(() => {
    document.body.style.overflow = '';
  });

  $: document.body.style.overflow = lightboxIndex !== null ? 'hidden' : '';
</script>

<section class="feed-section photo-page">
  <div class="section-heading">
    <h2>Photos</h2>
    <span>
      {sources.map((source) => source.name).join(' · ')}
      {#if photos.length}· {photos.length} loaded{/if}
    </span>
  </div>

  {#if loading}
    <div class="photo-grid" aria-busy="true">
      {#each Array.from({ length: 18 }) as _, index (index)}
        <div class="photo-thumb skeleton-photo"></div>
      {/each}
    </div>
  {:else if error}
    <div class="empty-state compact">
      <p>{error}</p>
      <button class="secondary-action" on:click={() => void loadPhotos()}>Try again</button>
    </div>
  {:else if photos.length === 0}
    <div class="empty-state compact">
      <p>No photos found in the selected libraries yet.</p>
    </div>
  {:else}
    <div class="photo-grid">
      {#each photos as photo, index (photo.Id)}
        <button
          class="photo-thumb"
          title={displayTitle(photo)}
          aria-label={'View ' + displayTitle(photo)}
          on:click={() => openLightbox(index)}
        >
          <img src={photoThumb(photo)} alt={displayTitle(photo)} loading="lazy" />
        </button>
      {/each}
    </div>
    {#if hasMore}
      <button class="secondary-action photo-more" on:click={() => void loadMorePhotos()}>
        {loadingMore ? 'Loading…' : 'Load more'}
      </button>
    {/if}
  {/if}
</section>

{#if lightboxPhoto}
  <!-- Backdrop click is an enhancement: keyboard users close via Esc or the
       close button, which receives focus when the dialog opens. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
  <div class="photo-lightbox" role="dialog" aria-modal="true" aria-label={displayTitle(lightboxPhoto)} on:click={onBackdropClick}>
    <button class="lightbox-close" bind:this={closeBtn} aria-label="Close viewer" on:click={closeLightbox}>
      <X size={22} />
    </button>
    {#if (lightboxIndex ?? 0) > 0}
      <button class="lightbox-nav lightbox-prev" aria-label="Previous photo" on:click={() => stepLightbox(-1)}>
        <ChevronLeft size={30} />
      </button>
    {/if}
    <figure class="lightbox-stage">
      <img src={photoFull(lightboxPhoto)} alt={displayTitle(lightboxPhoto)} />
      <figcaption>
        <strong>{displayTitle(lightboxPhoto)}</strong>
        {#if contentDate(lightboxPhoto)}
          <span>{relativeDate(contentDate(lightboxPhoto))}</span>
        {/if}
      </figcaption>
    </figure>
    {#if (lightboxIndex ?? 0) < photos.length - 1}
      <button class="lightbox-nav lightbox-next" aria-label="Next photo" on:click={() => stepLightbox(1)}>
        <ChevronRight size={30} />
      </button>
    {/if}
  </div>
{/if}

<svelte:window on:keydown={onKeydown} />

<style>
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 10px;
  }
  .photo-thumb {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
    cursor: zoom-in;
  }
  .photo-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.18s ease;
  }
  .photo-thumb:hover img {
    transform: scale(1.04);
  }
  .skeleton-photo {
    background: var(--surface);
    animation: photoPulse 1.2s ease-in-out infinite;
  }
  @keyframes photoPulse {
    50% {
      opacity: 0.55;
    }
  }
  .photo-more {
    margin-top: 14px;
  }

  .photo-lightbox {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 34px clamp(52px, 9vw, 96px);
    background: rgba(0, 0, 0, 0.88);
  }
  .lightbox-stage {
    margin: 0;
    min-width: 0;
    max-width: 100%;
    display: grid;
    justify-items: center;
    gap: 10px;
  }
  .lightbox-stage img {
    max-width: 100%;
    max-height: 82vh;
    border-radius: 6px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
  }
  .lightbox-stage figcaption {
    display: flex;
    align-items: baseline;
    gap: 12px;
    max-width: 100%;
    color: rgba(255, 255, 255, 0.85);
    font-size: 0.9rem;
  }
  .lightbox-stage strong {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: #fff;
  }
  .lightbox-close {
    position: absolute;
    top: 14px;
    right: 16px;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    cursor: pointer;
  }
  .lightbox-close:hover,
  .lightbox-nav:hover {
    background: rgba(255, 255, 255, 0.26);
  }
  .lightbox-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    cursor: pointer;
  }
  .lightbox-prev {
    left: 14px;
  }
  .lightbox-next {
    right: 14px;
  }
  @media (max-width: 640px) {
    .photo-grid {
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 6px;
    }
    .photo-lightbox {
      padding: 26px 12px;
    }
    .lightbox-nav {
      width: 40px;
      height: 40px;
    }
    .lightbox-prev {
      left: 8px;
    }
    .lightbox-next {
      right: 8px;
    }
  }
</style>
