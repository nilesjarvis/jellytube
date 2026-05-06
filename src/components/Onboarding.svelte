<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import {
    CheckCircle2,
    Film,
    KeyRound,
    Library,
    Loader2,
    Server,
    ShieldCheck,
    TriangleAlert
  } from 'lucide-svelte';
  import {
    JellyfinClient,
    JellyfinError,
    isEligibleLibrary,
    libraryKindLabel,
    libraryToSelectedSource,
    normalizeServerUrl
  } from '../lib/jellyfin';
  import type { AppSession, JellyfinLibrary, PublicServerInfo } from '../lib/types';

  const dispatch = createEventDispatcher<{ ready: AppSession }>();

  let serverUrl = localStorage.getItem('jellytube.lastServerUrl') ?? '';
  let username = localStorage.getItem('jellytube.lastUsername') ?? '';
  let password = '';
  let loading = false;
  let error = '';
  let info: PublicServerInfo | null = null;
  let accessToken = '';
  let userId = '';
  let userName = '';
  let libraries: JellyfinLibrary[] = [];
  let selectedLibraryIds: string[] = [];

  $: canSubmit = serverUrl.trim().length > 0 && username.trim().length > 0 && password.length > 0;

  async function signIn() {
    if (!canSubmit || loading) return;
    loading = true;
    error = '';
    libraries = [];

    try {
      const normalized = normalizeServerUrl(serverUrl);
      const anonymousClient = new JellyfinClient(normalized);
      info = await anonymousClient.getPublicInfo();
      const auth = await anonymousClient.authenticate(username.trim(), password);

      if (!auth.User.Policy?.IsAdministrator) {
        throw new JellyfinError('JellyTube requires a Jellyfin admin account so Playback Reporting history is available.');
      }

      const client = anonymousClient.withAuth(auth.AccessToken, auth.User.Id);
      const plugins = await client.getPlugins();
      const playbackReporting = plugins.find((plugin) => plugin.Name === 'Playback Reporting');
      if (!playbackReporting || playbackReporting.Status !== 'Active') {
        throw new JellyfinError('Playback Reporting must be installed and active on this Jellyfin server.');
      }

      const views = await client.getViews(auth.User.Id);
      libraries = views.Items.filter(isEligibleLibrary);
      if (libraries.length === 0) {
        throw new JellyfinError('No supported Shows, Home Videos & Photos, Movies, or Music Videos libraries were found for this user.');
      }
      selectedLibraryIds = libraries.map((library) => library.Id);

      serverUrl = normalized;
      accessToken = auth.AccessToken;
      userId = auth.User.Id;
      userName = auth.User.Name;
      localStorage.setItem('jellytube.lastServerUrl', normalized);
      localStorage.setItem('jellytube.lastUsername', username.trim());
    } catch (caught) {
      error =
        caught instanceof JellyfinError || caught instanceof Error
          ? caught.message
          : 'Could not sign in to Jellyfin.';
    } finally {
      loading = false;
    }
  }

  function toggleLibrary(library: JellyfinLibrary) {
    if (selectedLibraryIds.includes(library.Id)) {
      selectedLibraryIds = selectedLibraryIds.filter((id) => id !== library.Id);
    } else {
      selectedLibraryIds = [...selectedLibraryIds, library.Id];
    }
  }

  function finishSetup() {
    const selectedLibraries = libraries
      .filter((library) => selectedLibraryIds.includes(library.Id))
      .map(libraryToSelectedSource)
      .filter((library) => library !== null);
    if (selectedLibraries.length === 0) {
      error = 'Select at least one supported Jellyfin library.';
      return;
    }
    dispatch('ready', {
      serverUrl,
      serverName: info?.ServerName ?? 'Jellyfin',
      serverVersion: info?.Version,
      accessToken,
      userId,
      userName,
      selectedLibraries,
      themeMode: 'system'
    });
  }
</script>

<main class="onboarding">
  <section class="onboarding-panel" aria-labelledby="onboarding-title">
    <div class="brand-row">
      <div class="brand-mark">
        <Film size={28} />
      </div>
      <div>
        <p class="eyebrow">Jellyfin for YouTube archives</p>
        <h1 id="onboarding-title">JellyTube</h1>
      </div>
    </div>

    {#if libraries.length === 0}
      <form class="signin-form" on:submit|preventDefault={signIn}>
        <label>
          <span>Server URL</span>
          <div class="field-shell">
            <Server size={18} />
            <input bind:value={serverUrl} placeholder="http://jellyfin.local:8096" autocomplete="url" />
          </div>
        </label>

        <label>
          <span>Username</span>
          <div class="field-shell">
            <ShieldCheck size={18} />
            <input bind:value={username} autocomplete="username" />
          </div>
        </label>

        <label>
          <span>Password</span>
          <div class="field-shell">
            <KeyRound size={18} />
            <input bind:value={password} type="password" autocomplete="current-password" />
          </div>
        </label>

        {#if error}
          <div class="status-error" role="alert">
            <TriangleAlert size={18} />
            <span>{error}</span>
          </div>
        {/if}

        <button class="primary-action" disabled={!canSubmit || loading}>
          {#if loading}
            <Loader2 size={18} class="spin" />
            Checking server
          {:else}
            Continue
          {/if}
        </button>
      </form>

      <div class="requirements">
        <div><CheckCircle2 size={17} /> Admin Jellyfin account required</div>
        <div><CheckCircle2 size={17} /> Playback Reporting plugin required</div>
        <div><CheckCircle2 size={17} /> Select video, movie, or music video libraries</div>
      </div>
    {:else}
      <div class="library-step">
        <div class="success-strip">
          <CheckCircle2 size={18} />
          <span>{info?.ServerName ?? 'Jellyfin'} {info?.Version ? `(${info.Version})` : ''}</span>
        </div>

        <div class="library-grid">
          {#each libraries as library}
            <button
              class:selected={selectedLibraryIds.includes(library.Id)}
              class="library-card"
              on:click={() => toggleLibrary(library)}
            >
              <Library size={22} />
              <span class="library-name">{library.Name}</span>
              <span class="library-meta">{libraryKindLabel(library.CollectionType)} · {library.ChildCount ?? 0} items</span>
              <span class="library-check">{selectedLibraryIds.includes(library.Id) ? 'Selected' : 'Add'}</span>
            </button>
          {/each}
        </div>

        {#if error}
          <div class="status-error" role="alert">
            <TriangleAlert size={18} />
            <span>{error}</span>
          </div>
        {/if}

        <button class="primary-action library-continue" on:click={finishSetup} disabled={selectedLibraryIds.length === 0}>
          Continue with {selectedLibraryIds.length} {selectedLibraryIds.length === 1 ? 'library' : 'libraries'}
        </button>
      </div>
    {/if}
  </section>
</main>
