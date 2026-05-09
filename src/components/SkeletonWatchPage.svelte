<script lang="ts">
  import SkeletonVideoCard from './SkeletonVideoCard.svelte';

  const queueCards = Array.from({ length: 4 });
  const recommendationCards = Array.from({ length: 8 });
</script>

<section class="watch-layout skeleton-watch-layout" aria-hidden="true">
  <div class="watch-left">
    <div class="watch-player-area">
      <div class="skeleton-box skeleton-watch-player"></div>
    </div>

    <div class="watch-main skeleton-watch-main">
      <span class="skeleton-line skeleton-watch-title"></span>
      <span class="skeleton-watch-meta-row">
        <span class="skeleton-line skeleton-line-short"></span>
        <span class="skeleton-line skeleton-line-meta"></span>
        <span class="skeleton-line skeleton-line-medium"></span>
      </span>
      <span class="skeleton-box skeleton-watch-overview"></span>

      <section class="episode-shelf skeleton-episode-shelf">
        <div class="episode-shelf-heading skeleton-section-heading">
          <div>
            <span class="skeleton-line skeleton-heading-title"></span>
            <span class="skeleton-line skeleton-heading-meta"></span>
          </div>
          <span class="skeleton-box skeleton-season-control"></span>
        </div>
        <div class="episode-strip">
          {#each queueCards as _, index (index)}
            <div class="episode-tile skeleton-episode-tile">
              <span class="skeleton-box skeleton-thumbnail"></span>
              <span class="episode-copy">
                <span class="skeleton-line skeleton-line-meta"></span>
                <span class="skeleton-line skeleton-line-title"></span>
                <span class="skeleton-line skeleton-line-short"></span>
              </span>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </div>

  <aside class="recommendation-rail skeleton-recommendation-rail">
    <div class="recommendation-heading skeleton-section-heading">
      <span class="skeleton-line skeleton-heading-title"></span>
    </div>
    <div class="video-grid skeleton-compact-list">
      {#each recommendationCards as _, index (index)}
        <SkeletonVideoCard compact />
      {/each}
    </div>
  </aside>
</section>
