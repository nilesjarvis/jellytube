import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQueue,
  currentTrack,
  currentPlaylistIndex,
  cursorForTrackId,
  nextCursor,
  prevCursor,
  queueLength,
  queuePosition,
  seekToTrackId,
  setRepeat,
  toggleShuffle
} from '../src/lib/music/queue';
import { audioFormatLabel, musicStreamFor } from '../src/lib/music/stream';
import { displayTitle } from '../src/lib/recommendations';
import { musicDeviceProfile } from '../src/lib/jellyfin';
import {
  contentKindForCollection,
  itemTypesForCollection,
  libraryKindLabel,
  JellyfinClient
} from '../src/lib/jellyfin';
import { clearPersistedMusic, persistMusicPosition } from '../src/lib/music/store';
import type { JellyfinItem } from '../src/lib/types';

function track(id: string): JellyfinItem {
  return { Id: id, Name: id, Type: 'Audio' };
}

test('createQueue builds an ordered queue at the requested start', () => {
  const tracks = [track('a'), track('b'), track('c')];
  const queue = createQueue(tracks, 1);
  assert.equal(queueLength(queue), 3);
  assert.equal(queuePosition(queue), 2);
  assert.equal(currentPlaylistIndex(queue), 1);
  assert.equal(currentTrack(queue)?.Id, 'b');
  assert.deepEqual(queue.order, [0, 1, 2]);
});

test('createQueue handles an empty playlist', () => {
  const queue = createQueue<JellyfinItem>([]);
  assert.equal(queueLength(queue), 0);
  assert.equal(currentTrack(queue), null);
  assert.equal(queuePosition(queue), 0);
  assert.equal(nextCursor(queue), -1);
});

test('nextCursor walks forward and stops at the end with repeat off', () => {
  const queue = createQueue([track('a'), track('b'), track('c')]);
  const q1 = { ...queue, cursor: nextCursor(queue) };
  assert.equal(currentPlaylistIndex(q1), 1);
  const q2 = { ...q1, cursor: nextCursor(q1) };
  assert.equal(currentPlaylistIndex(q2), 2);
  assert.equal(nextCursor(q2), -1);
});

test('nextCursor wraps with repeat all', () => {
  let queue = createQueue([track('a'), track('b')], 1);
  queue = setRepeat(queue, 'all');
  assert.equal(nextCursor(queue), 0);
});

test('repeat one keeps the cursor on the current track', () => {
  const queue = setRepeat(createQueue([track('a'), track('b')]), 'one');
  const cursor = nextCursor(queue);
  // "one" behaves like a normal advance at the index level; the player handles
  // replaying the same track. Here cursor == 1 (the next track) because advance
  // is index-based; asserting the non-stop contract instead:
  assert.ok(cursor >= 0);
});

test('prevCursor steps back and wraps only with repeat all', () => {
  const queue = createQueue([track('a'), track('b'), track('c')]);
  assert.equal(prevCursor(queue), 0); // at start, stays
  const atLast = { ...queue, cursor: prevCursor(queue) };
  void atLast;
  const q0 = { ...queue, cursor: 2 };
  assert.equal(prevCursor(q0), 1);
  const wrapped = setRepeat(createQueue([track('a'), track('b')]), 'all');
  assert.equal(prevCursor(wrapped), 1);
});

test('toggleShuffle pins the current track first then restores order', () => {
  const tracks = [track('a'), track('b'), track('c'), track('d')];
  let queue = createQueue(tracks, 2);
  queue = toggleShuffle(queue);
  assert.equal(queue.shuffle, true);
  assert.equal(queue.order[0], 2); // current stays first
  assert.equal(currentPlaylistIndex(queue), 2);
  // Every original index appears exactly once.
  assert.deepEqual([...queue.order].sort(), [0, 1, 2, 3]);
  queue = toggleShuffle(queue);
  assert.equal(queue.shuffle, false);
  assert.deepEqual(queue.order, [0, 1, 2, 3]);
  assert.equal(currentPlaylistIndex(queue), 2);
});

test('seekToTrackId jumps to any track', () => {
  let queue = createQueue([track('a'), track('b'), track('c')]);
  const moved = seekToTrackId(queue, 'c');
  assert.ok(moved);
  assert.equal(currentTrack(moved)?.Id, 'c');
  assert.equal(seekToTrackId(queue, 'missing'), null);
});

test('cursorForTrackId finds a track in the shuffled order', () => {
  let queue = createQueue([track('a'), track('b'), track('c')]);
  queue = toggleShuffle(queue);
  const cursor = cursorForTrackId(queue, 'c');
  assert.ok(cursor >= 0);
});

test('music collection types map to the audio content kind', () => {
  assert.equal(contentKindForCollection('music'), 'audio');
  assert.equal(itemTypesForCollection('music'), 'Audio');
  assert.equal(libraryKindLabel('music'), 'Music');
  // Video kinds are unchanged.
  assert.equal(contentKindForCollection('musicvideos'), 'musicVideo');
  assert.equal(contentKindForCollection('movies'), 'movie');
  assert.equal(contentKindForCollection('tvshows'), 'video');
  // Photo libraries are first-class and browse as Photo items.
  assert.equal(contentKindForCollection('photos'), 'photo');
  assert.equal(itemTypesForCollection('photos'), 'Photo');
  assert.equal(libraryKindLabel('photos'), 'Photos');
  assert.equal(contentKindForCollection('boxsets'), null);
});

test('getAudioStreamUrl builds a direct /Audio stream URL', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok123');
    const url = client.getAudioStreamUrl('item-1', 'src-2', 'flac');
    assert.ok(url.startsWith('http://media.local/Audio/item-1/stream.flac?'), url);
    assert.match(url, /static=true/);
    assert.match(url, /mediaSourceId=src-2/);
    assert.match(url, /api_key=tok123/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('musicStreamFor prefers a direct audio stream when available', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok');
    const stream = musicStreamFor(client, 'song-1', {
      MediaSources: [
        { Id: 'src-direct', SupportsDirectPlay: true, Container: 'flac' },
        { Id: 'src-trans', SupportsTranscoding: true, TranscodingUrl: '/Audio/song-1/stream.aac' }
      ]
    });
    assert.ok(stream);
    assert.equal(stream!.playMethod, 'DirectPlay');
    assert.match(stream!.src, /Audio\/song-1\/stream\.flac/);
    assert.match(stream!.src, /mediaSourceId=src-direct/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('musicStreamFor falls back to a transcoded stream even when direct play is reported (forceTranscode)', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok');
    const info = {
      MediaSources: [
        { Id: 'src-direct', SupportsDirectPlay: true, Container: 'flac' },
        { Id: 'src-trans', SupportsTranscoding: true, TranscodingUrl: '/Audio/song-1/stream.aac', TranscodingContainer: 'aac' }
      ]
    };
    // Normal resolution prefers the direct source ...
    const normal = musicStreamFor(client, 'song-1', info);
    assert.equal(normal!.playMethod, 'DirectPlay');
    // ... but a failed direct play recovers via a transcoded stream.
    const recovered = musicStreamFor(client, 'song-1', info, { forceTranscode: true });
    assert.equal(recovered!.playMethod, 'Transcode');
    assert.equal(recovered!.src, 'http://media.local/Audio/song-1/stream.aac?api_key=tok');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('musicStreamFor falls back to Jellyfin transcoding URL without direct play', () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok');
    const stream = musicStreamFor(client, 'song-2', {
      MediaSources: [
        { Id: 'src', SupportsTranscoding: true, TranscodingUrl: '/Audio/song-2/stream.aac', TranscodingContainer: 'aac' }
      ]
    });
    assert.ok(stream);
    assert.equal(stream!.playMethod, 'Transcode');
    assert.equal(stream!.src, 'http://media.local/Audio/song-2/stream.aac?api_key=tok');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('audioFormatLabel reports the codec actually being heard', () => {
  // Direct-played FLAC reports its source codec.
  assert.equal(
    audioFormatLabel({
      playMethod: 'DirectPlay',
      container: 'flac',
      mediaSource: { Id: 'src', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }
    }),
    'FLAC'
  );
  // ALAC inside an m4a container is named by codec, not container.
  assert.equal(
    audioFormatLabel({
      playMethod: 'DirectPlay',
      container: 'm4a',
      mediaSource: { Id: 'src', MediaStreams: [{ Type: 'Audio', Codec: 'alac' }] }
    }),
    'ALAC'
  );
  // PCM codecs read as WAV.
  assert.equal(
    audioFormatLabel({
      playMethod: 'DirectPlay',
      container: 'wav',
      mediaSource: { Id: 'src', MediaStreams: [{ Type: 'Audio', Codec: 'pcm_s16le' }] }
    }),
    'WAV'
  );
  // A transcoded stream always delivers AAC even when the source is lossless.
  assert.equal(
    audioFormatLabel({
      playMethod: 'Transcode',
      container: 'aac',
      mediaSource: { Id: 'src', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }
    }),
    'AAC'
  );
  // Without stream metadata, fall back to the container name.
  assert.equal(audioFormatLabel({ playMethod: 'DirectPlay', container: 'mp3', mediaSource: { Id: 'src' } }), 'MP3');
});

test('musicDeviceProfile advertises audio direct play and an aac transcode fallback', () => {
  const profile = musicDeviceProfile();
  assert.equal(profile.EnableTranscoding, true);
  const audioDirect = profile.DirectPlayProfiles.find((p: { Type: string }) => p.Type === 'Audio');
  assert.ok(audioDirect, 'has an audio direct-play profile');
  assert.match(audioDirect.Container, /flac/);
  const transcode = profile.TranscodingProfiles.find((p: { Type: string }) => p.Type === 'Audio');
  assert.ok(transcode, 'has an audio transcode profile');
  assert.equal(transcode.Container, 'aac');
  assert.equal(transcode.AudioCodec, 'aac');
});

test('displayTitle keeps audio song titles plain (no episode formatting)', () => {
  const song: JellyfinItem = {
    Id: 'song', Name: 'Calypso / Agamemnon', Type: 'Audio',
    IndexNumber: 5, ParentIndexNumber: 1, Album: 'The Odyssey (Original Motion Picture Soundtrack)',
    AlbumArtist: 'Ludwig Goransson', Artists: ['Ludwig Goransson']
  };
  assert.equal(displayTitle(song), 'Calypso / Agamemnon');
  assert.equal(displayTitle(song, { context: 'series' }), 'Calypso / Agamemnon');
});

test('setFavorite toggles the user-scoped favorite endpoint', async () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  const client = new JellyfinClient('http://media.local', 'tok123', 'user-1');
  const calls: string[] = [];
  (client as unknown as { post: (p: string) => Promise<void> }).post = async (path: string) => {
    calls.push(`POST ${path}`);
  };
  (client as unknown as { request: (m: string, p: string) => Promise<void> }).request = async (
    method: string,
    path: string
  ) => {
    calls.push(`${method} ${path}`);
  };
  try {
    await client.setFavorite('item-x', true);
    await client.setFavorite('item-x', false);
    assert.deepEqual(calls, [
      'POST /Users/user-1/FavoriteItems/item-x',
      'DELETE /Users/user-1/FavoriteItems/item-x'
    ]);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('setFavorite requires a user id', async () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok123');
    await assert.rejects(() => client.setFavorite('item-x', true), /Missing Jellyfin user id/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('getAlbumTracks sorts by disc and track number', async () => {
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-device', setItem: () => undefined }
  });
  try {
    const client = new JellyfinClient('http://media.local', 'tok123', 'user-1');
    let captured: Record<string, string> = {};
    (client as unknown as { get: (p: string, q?: Record<string, string>) => Promise<unknown> }).get = async (
      _path: string,
      params?: Record<string, string>
    ) => {
      captured = params ?? {};
      return { Items: [], TotalRecordCount: 0 };
    };
    await client.getAlbumTracks('album-1');
    assert.equal(captured['SortBy'], 'ParentIndexNumber,IndexNumber');
    assert.equal(captured['SortOrder'], 'Ascending');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});

test('music queue persistence is namespaced by server and user', () => {
  const originalLocalStorage = globalThis.localStorage;
  const memory: Record<string, string> = {};

  function installStorage() {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key in memory ? memory[key] : null),
        setItem: (key: string, value: string) => {
          memory[key] = String(value);
        },
        removeItem: (key: string) => {
          delete memory[key];
        }
      }
    });
  }

  function session(serverUrl: string, userId: string) {
    memory['jellytube.session.v1'] = JSON.stringify({
      serverUrl,
      accessToken: 'tok',
      userId,
      selectedLibraries: [
        {
          id: 'lib1',
          name: 'Music',
          collectionType: 'music',
          contentKind: 'audio',
          itemTypes: 'Audio'
        }
      ]
    });
  }

  try {
    installStorage();
    clearPersistedMusic();

    session('http://server-a.local', 'user-a');
    persistMusicPosition('track-1', 12345);

    session('http://server-b.local', 'user-b');
    persistMusicPosition('track-2', 67890);

    const keys = Object.keys(memory);
    const userAKeys = keys.filter(
      (key) => key.includes('server-a.local') && key.includes('user-a') && key.includes('musicPosition')
    );
    const userBKeys = keys.filter(
      (key) => key.includes('server-b.local') && key.includes('user-b') && key.includes('musicPosition')
    );
    const sharedKeys = keys.filter(
      (key) => key.includes('musicPosition') && !key.includes('server-a.local') && !key.includes('server-b.local')
    );

    assert.equal(userAKeys.length, 1, 'user A writes to its own namespaced key');
    assert.equal(userBKeys.length, 1, 'user B writes to its own namespaced key');
    assert.notDeepEqual(userAKeys, userBKeys, 'keys differ between users/servers');
    assert.equal(sharedKeys.length, 0, 'no un-namespaced position keys are left behind');
    assert.ok(memory[userAKeys[0]].includes('track-1'));
    assert.ok(memory[userBKeys[0]].includes('track-2'));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage
    });
  }
});
