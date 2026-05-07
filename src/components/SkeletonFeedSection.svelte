<script lang="ts">
  import SkeletonVideoCard from './SkeletonVideoCard.svelte';

  export let count = 8;
  export let poster = false;
  export let compact = false;
  export let heading = true;
  export let showMeta = false;
  export let grid: 'video' | 'movie' = poster ? 'movie' : 'video';

  $: cards = Array.from({ length: count });
  $: gridClass = grid === 'movie' ? 'movie-grid' : 'video-grid';
</script>

<section class="feed-section skeleton-feed-section" aria-hidden="true">
  {#if heading}
    <div class="section-heading skeleton-section-heading">
      <span class="skeleton-line skeleton-heading-title"></span>
      {#if showMeta}
        <span class="skeleton-line skeleton-heading-meta"></span>
      {/if}
    </div>
  {/if}
  <div class={gridClass}>
    {#each cards as _, index (index)}
      <SkeletonVideoCard {poster} {compact} />
    {/each}
  </div>
</section>
