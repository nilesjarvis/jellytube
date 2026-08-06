# Music Page & Player

## Goal
Add audio-music support to JellyTube from Jellyfin `music` libraries, kept
separate from the video player and the existing music-videos surface, while
staying visually consistent with the YouTube-style design.

## Scope (what ships)
- A Jellyfin **audio** library (`collectionType: "music"`) is now a selectable
  content kind (`audio`). Its items are `Type: "Audio"`, `MusicAlbum`,
  `MusicArtist`.
- The **Music** nav is a two-tab hub: **Music Videos** (existing, unchanged)
  and **Music** (new audio browse + player). The audio tab appears whenever at
  least one Music library is connected.
- The **Music page** (`src/components/music/MusicPage.svelte`) browses albums,
  artists, and recent songs. Album cards have distinct targets: the **cover art
  plays the album**, the **title opens the album page**, and the **artist name
  opens the artist page**.
- The **album view** shows a hero (cover art, artist link, year · genre, track
  count and total duration, bio, Play / Shuffle) plus the full track list with a
  live highlight for the currently-playing song.
- The **artist view** shows a blurred-artwork hero (round avatar, album & song
  counts, bio, Play / Shuffle, a ranked Top songs list) and their albums. Back
  from an album returns to the artist you came from.
- A **persistent now-playing bar** (`src/components/music/MusicPlayer.svelte`)
  plays audio via a plain `<audio>` element with direct `/Audio/…/stream`
  URLs, and includes play/pause, prev/next, seek, volume, shuffle, repeat,
  position, and a queue drawer. It also reports playback progress to Jellyfin.
- Media Session API support for lock-screen / OS media controls.

## How it stays separate
- All new logic lives under `src/lib/music/` and `src/components/music/`.
- The video player (`WatchPage.svelte`) is untouched.
- Audio sources are **not** pulled into the home video feed; they only surface
  in the Music tab and the player.
- The music bar is hidden while a video is actively playing so the two
  experiences never overlap. Audio keeps playing underneath if it was already
  running.

## Data flow
- `JellyfinClient`: `getMusicArtists`, `getMusicAlbums`, `getMusicSongs`,
  `getAlbumTracks`, `getArtistAlbums`, `getArtistSongs`, `getAudioStreamUrl`,
  plus `artistIds` support in `getItems`. Artist albums/songs are queried
  per-library source via the Items endpoint with `ArtistIds`.
- `musicStreamFor` (src/lib/music/stream.ts) prefers a static direct stream and
  falls back to Jellyfin's transcoded URL, mirroring the video player's
  robustness for unusual containers.
- Queue state (src/lib/music/queue.ts + store.ts) is shared through a Svelte
  store so the page and the persistent bar stay in sync across navigation.

## Testing
- `tests/music.test.ts` covers queue ordering/shuffle/repeat, content-kind
  mapping, audio stream URL generation, and direct-stream vs transcode
  fallback.
- `npm test` (svelte-check + unit tests) is green.

## Possible follow-ups (not in v1)
- Jellyfin Playlists library and `InstantMix` radio.
- A home-feed "New music" shelf.
- Artist/album detail routes with browser-back parity.
