<script lang="ts">
  export let count = 6;

  $: cards = Array.from({ length: count });
</script>

<div class="settings-grid skeleton-library-grid" aria-hidden="true">
  {#each cards as _, index (index)}
    <div class="library-card skeleton-library-card">
      <span class="skeleton-box skeleton-library-icon"></span>
      <span class="library-name">
        <span class="skeleton-line skeleton-line-title"></span>
      </span>
      <span class="library-meta">
        <span class="skeleton-line skeleton-line-short"></span>
      </span>
      <span class="library-check skeleton-library-pill">
        <span class="skeleton-line"></span>
      </span>
    </div>
  {/each}
</div>
