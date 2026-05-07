<script lang="ts">
  import SkeletonDirectoryGrid from './SkeletonDirectoryGrid.svelte';
  import SkeletonFeedSection from './SkeletonFeedSection.svelte';
  import SkeletonLibraryGrid from './SkeletonLibraryGrid.svelte';

  export let route = 'home';
  export let label = 'Loading content';

  const mixCards = Array.from({ length: 8 });
</script>

<div class="skeleton-route" role="status" aria-busy="true">
  <span class="sr-only">{label}</span>
  <div class="skeleton-route-body" aria-hidden="true">
    {#if route === 'movies'}
      <section class="feed-section movie-landing skeleton-feed-section">
        <div class="section-heading skeleton-section-heading">
          <span class="skeleton-line skeleton-heading-title"></span>
          <span class="skeleton-line skeleton-heading-meta"></span>
        </div>
        <div class="movie-feature skeleton-movie-feature">
          <span class="skeleton-box skeleton-movie-feature-poster"></span>
          <span class="movie-feature-copy skeleton-movie-feature-copy">
            <span class="skeleton-line skeleton-pill-line"></span>
            <span class="skeleton-line skeleton-feature-title"></span>
            <span class="skeleton-line skeleton-line-short"></span>
            <span class="skeleton-line skeleton-line-wide"></span>
            <span class="skeleton-line skeleton-line-medium"></span>
          </span>
        </div>
      </section>
      <SkeletonFeedSection poster grid="movie" count={8} />
      <SkeletonFeedSection poster grid="movie" count={8} />
    {:else if route === 'music'}
      <section class="feed-section hero-section skeleton-feed-section">
        <div class="section-heading skeleton-section-heading">
          <span class="skeleton-line skeleton-heading-title"></span>
          <span class="skeleton-line skeleton-heading-meta"></span>
        </div>
        <div class="mix-grid">
          {#each mixCards as _, index (index)}
            <div class="mix-card skeleton-mix-card">
              <span class="skeleton-box skeleton-mix-thumb"></span>
              <span class="skeleton-mix-copy">
                <span class="skeleton-line skeleton-line-title"></span>
                <span class="skeleton-line skeleton-line-short"></span>
              </span>
            </div>
          {/each}
        </div>
      </section>
      <SkeletonFeedSection count={8} />
      <SkeletonFeedSection count={8} />
    {:else if route === 'subscriptions'}
      <section class="feed-section subscriptions-page skeleton-feed-section">
        <div class="section-heading skeleton-section-heading">
          <span class="skeleton-line skeleton-heading-title"></span>
          <span class="skeleton-line skeleton-heading-meta"></span>
        </div>
        <span class="skeleton-box skeleton-filter"></span>
      </section>
      <section class="feed-section skeleton-feed-section">
        <div class="section-heading skeleton-section-heading">
          <span class="skeleton-line skeleton-heading-title"></span>
          <span class="skeleton-line skeleton-heading-meta"></span>
        </div>
        <SkeletonDirectoryGrid count={6} />
      </section>
      <SkeletonFeedSection count={8} />
    {:else if route === 'libraries'}
      <section class="feed-section library-settings skeleton-feed-section">
        <div class="section-heading skeleton-section-heading">
          <span class="skeleton-line skeleton-heading-title"></span>
          <span class="skeleton-line skeleton-heading-meta"></span>
        </div>
        <SkeletonLibraryGrid count={6} />
      </section>
    {:else if route === 'channel'}
      <section class="show-up-next skeleton-show-up-next">
        <span class="skeleton-box skeleton-show-thumb"></span>
        <span class="show-up-next-copy skeleton-show-copy">
          <span class="skeleton-line skeleton-pill-line"></span>
          <span class="skeleton-line skeleton-feature-title"></span>
          <span class="skeleton-line skeleton-line-short"></span>
          <span class="skeleton-line skeleton-line-wide"></span>
          <span class="skeleton-line skeleton-line-medium"></span>
        </span>
      </section>
      <SkeletonFeedSection count={6} />
      <SkeletonFeedSection count={8} />
    {:else if route === 'search'}
      <SkeletonFeedSection count={12} showMeta />
    {:else}
      <SkeletonFeedSection count={6} />
      <SkeletonFeedSection count={8} showMeta />
      <SkeletonFeedSection count={8} />
    {/if}
  </div>
</div>
