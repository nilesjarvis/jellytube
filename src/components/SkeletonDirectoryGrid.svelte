<script lang="ts">
  export let count = 6;

  $: cards = Array.from({ length: count });
</script>

<div class="subscription-channel-grid skeleton-directory-grid" aria-hidden="true">
  {#each cards as _, index (index)}
    <div class="subscription-card directory-card skeleton-directory-card">
      <span class="skeleton-box skeleton-directory-avatar"></span>
      <span class="subscription-copy skeleton-directory-copy">
        <span class="skeleton-line skeleton-line-title"></span>
        <span class="skeleton-line skeleton-line-short"></span>
      </span>
    </div>
  {/each}
</div>
