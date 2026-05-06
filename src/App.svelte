<script lang="ts">
  import Onboarding from './components/Onboarding.svelte';
  import JellyTube from './components/JellyTube.svelte';
  import { clearSession, loadSession, saveSession } from './lib/session';
  import type { AppSession } from './lib/types';

  let session: AppSession | null = loadSession();

  function handleReady(event: CustomEvent<AppSession>) {
    session = event.detail;
    saveSession(event.detail);
  }

  function handleLogout() {
    clearSession();
    window.history.replaceState({ jellytube: true, route: { view: 'home' } }, '', '/');
    session = null;
  }
</script>

{#if session}
  <JellyTube {session} on:logout={handleLogout} />
{:else}
  <Onboarding on:ready={handleReady} />
{/if}
