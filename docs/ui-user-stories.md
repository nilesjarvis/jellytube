# JellyTube UI User Stories

## Navigation And Global Shell

- As a viewer, I want the left rail to take me to distinct content modes, so I can tell whether I am browsing videos, movies, music, channels, or settings.
- As a viewer, I want a Subscriptions tab like YouTube, so I can quickly pick a show or channel from my selected Jellyfin libraries.
- As a viewer, I want browser back/forward and refresh to preserve the current task, so I do not lose context while watching or searching.
- As a viewer, I want dark mode and compact controls to stay out of the way, so the app feels like a media product rather than an admin dashboard.

## Home

- As a returning viewer, I want continue-watching first, because that is usually the fastest path back into playback.
- As a viewer with YouTube archives, I want recommendations to include music-video matches but not bury normal videos under movies.
- As a viewer, I want new videos sorted by the recorded/released date where available, because import date is misleading for old archives.

## Movies

- As a viewer choosing a movie, I expect a separate Movies area with poster-style cards, production year, runtime, resume progress, and movie-only recommendations.
- As a viewer watching a movie, I expect the metadata link to return me to Movies, not to a fake "Jellyfin" channel.
- As a viewer, I expect movie cards not to look like episodic channel uploads.

## Episodic Shows

- As a viewer opening a show such as Saturday Night Live, I expect a show page with seasons and episode order, not just a flat channel grid.
- As a viewer deep inside a large show, I expect full series data from Jellyfin `/Shows/{seriesId}/Episodes`, not only the limited home/recommendation pool.
- As a viewer, I expect next/previous and autoplay to follow episode order while cards display the real air date when Jellyfin has it.

## Music Videos And Mixes

- As a viewer, I expect mixes to behave like playlists with visible order, autoplay, and a clear channel/artist identity.
- As a viewer, I expect music videos with common YouTube title separators to group under the artist/channel instead of a generic fallback.

## Subscriptions

- As a viewer, I expect the Subscriptions tab to behave as a show/channel directory, not as a follow/unfollow system.
- As a viewer, I expect to filter the directory and open a show or channel quickly.
- As a viewer, I expect opening a show channel to load any full episode data only when I actually visit that channel.

## Search

- As a viewer searching for a show, I expect the actual show episodes to rank above unrelated title matches.
- As a viewer searching across selected libraries, I expect movies, episodes, normal videos, and music videos to keep their visual identity.

## Library Settings

- As a server owner, I want to select multiple supported libraries and understand their Jellyfin type, because YouTube archives may be split across Shows, Home Videos, Movies, and Music Videos.

## Implementation Focus For This Pass

- Keep Subscriptions as a left-rail destination that derives shows and channels from the already-loaded Jellyfin item pool and series list.
- Remove follow/unfollow state and channel subscribe controls.
- Keep channel-level API expansion lazy; do not fetch full show libraries for every listed channel.
