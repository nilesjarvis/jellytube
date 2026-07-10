<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { JellyfinClient } from '../lib/jellyfin';
  import type { JellyfinPerson } from '../lib/types';

  export let client: JellyfinClient;
  export let actors: JellyfinPerson[];

  const dispatch = createEventDispatcher<{ select: { actor: JellyfinPerson } }>();

  function getActorName(actor: JellyfinPerson) {
    return actor.Name?.trim() || 'Unknown actor';
  }

  function getActorInitial(name: string) {
    return name.charAt(0).toLocaleUpperCase();
  }

  function selectActor(actor: JellyfinPerson) {
    dispatch('select', { actor });
  }
</script>

{#if actors.length > 0}
  <section class="actor-cast" aria-label="Cast">
    <div class="cast-heading">
      <h2>Cast</h2>
      <span>{actors.length} {actors.length === 1 ? 'actor' : 'actors'}</span>
    </div>

    <ul class="actor-rail">
      {#each actors as actor, index (`${actor.Id ?? actor.Name ?? 'actor'}:${index}`)}
        {@const name = getActorName(actor)}
        {@const role = actor.Role?.trim()}
        {@const imageUrl = client.getPersonImageUrl(actor, 320)}
        <li class="actor-card">
          <button
            class="actor-button"
            type="button"
            aria-label={role ? `${name}, ${role}` : name}
            on:click={() => selectActor(actor)}
          >
            <span class="actor-portrait">
              {#if imageUrl}
                <img src={imageUrl} alt="" loading="lazy" />
              {:else}
                <span class="actor-initial" aria-hidden="true">{getActorInitial(name)}</span>
              {/if}
            </span>
            <span class="actor-copy">
              <strong class="actor-name" title={name}>{name}</strong>
              {#if role}
                <small class="actor-role" title={role}>{role}</small>
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .actor-cast {
    min-width: 0;
    margin-top: 22px;
  }

  .cast-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }

  .cast-heading h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .cast-heading span {
    color: var(--muted);
    font-size: 0.9rem;
    white-space: nowrap;
  }

  .actor-rail {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(132px, 154px);
    gap: 12px;
    margin: 0;
    padding: 3px 3px 12px;
    overflow-x: auto;
    overflow-y: hidden;
    list-style: none;
    overscroll-behavior-inline: contain;
    scroll-padding-inline: 3px;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }

  .actor-card {
    min-width: 0;
    scroll-snap-align: start;
  }

  .actor-button {
    width: 100%;
    height: 100%;
    min-width: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    align-content: start;
    gap: 0;
    padding: 0 0 12px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    appearance: none;
    color: var(--text);
    text-align: left;
    background: var(--surface);
    box-shadow: 0 1px 0 var(--shadow);
  }

  .actor-button:hover {
    border-color: color-mix(in srgb, var(--brand) 34%, var(--border));
    background: var(--soft-2);
  }

  .actor-button:focus-visible {
    border-color: var(--focus);
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }

  .actor-portrait {
    width: 100%;
    aspect-ratio: 2 / 3;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: linear-gradient(
      145deg,
      color-mix(in srgb, var(--brand) 18%, #151515),
      #202020
    );
  }

  .actor-portrait img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .actor-initial {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: #fff;
    font-size: 2.75rem;
    font-weight: 800;
  }

  .actor-copy {
    min-width: 0;
    display: grid;
    align-content: start;
    gap: 5px;
    padding: 10px 10px 0;
  }

  .actor-name,
  .actor-role {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
  }

  .actor-name {
    line-clamp: 2;
    -webkit-line-clamp: 2;
    font-size: 0.94rem;
    line-height: 1.25;
  }

  .actor-role {
    line-clamp: 2;
    -webkit-line-clamp: 2;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.35;
  }

  @media (max-width: 900px) {
    .cast-heading {
      align-items: start;
      flex-direction: column;
      gap: 4px;
    }

    .actor-rail {
      grid-auto-columns: minmax(112px, 34vw);
      gap: 10px;
    }

    .actor-copy {
      padding-inline: 9px;
    }

    .actor-initial {
      font-size: 2.25rem;
    }
  }
</style>
