# JellyTube UI Audit

## Audit Method

The audit uses the user stories in `docs/ui-user-stories.md`, current Jellyfin API behavior, and screenshot review from the browser smoke run. The main correction areas were movies, episodic shows, channel identity, and preserving the existing YouTube-like watch flow.

## Global Shell

- Top bar: Keep the wordmark, search, theme toggle, and server pill. These are expected global controls and remain visible across routes.
- Sidebar: Keep Home, Movies, Music, Subscriptions, Channel, Libraries, Refresh, and Sign out. The route-specific active states are useful; no consolidation needed.
- Search field: Keep global search in the top bar. It remains the main cross-library action and now preserves content identity through search ranking and card presentation.
- Theme toggle: Keep as an icon-only global control. It is already persistent and low-noise.

## Home Feed

- Continue watching: Keep first when available. It maps to the highest-frequency returning-user story.
- Recommended: Keep mixed videos and music videos, but not movies. Movies are intentionally separated.
- New videos: Keep release-date-oriented sorting. This now relies on `PremiereDate` when Jellyfin has it.
- Replay picks: Keep as a lower-priority shelf driven by user play count.

## Video Cards

- Thumbnail button: Keep as the primary click target.
- Duration badge: Keep.
- Progress bar: Keep for partially watched items.
- Title button: Keep as a second click target.
- Channel button: Keep for normal videos/music videos. For movies, the channel identity now resolves to the movie library and routes back to Movies instead of a generic channel.
- Metadata row: Keep views/year/date, using release date before import date.

## Movies

- Movies route: Expanded into a clearer YouTube Movies surface with a featured/resume movie treatment above poster grids.
- Movie cards: Continue using poster layout rather than 16:9 video layout.
- Movie watch metadata: The context button now returns to Movies, not a fake Jellyfin channel.
- Movie recommendations: Stay movie-only on the watch page.
- Edge case: If no overview/poster exists, the feature card falls back to compact metadata and a letter placeholder.

## Episodic Shows

- Watch page episode shelf: Keep horizontal season strip under the player.
- Show/channel page: Expanded from a flat channel grid into a show guide with season picker, "Latest episode", and "Play season" actions.
- Large shows: The show guide uses cached full-series data from Jellyfin `/Shows/{seriesId}/Episodes` after channel resolution.
- SNL metadata outliers: Extreme season-number outliers are filtered from the season picker display while still appearing in latest uploads.
- Latest uploads section: Kept below the season guide so clipped/special content is still findable.

## Music Videos And Mixes

- Music route: Keep mix cards first, then recommendations and new videos.
- Mix cards: Keep playlist-like behavior with `Play all`.
- Artist/channel parsing: Improved through Jellyfin artist/studio metadata and common YouTube title separators.
- Mix watch queue: Keep the queue rail and autoplay toggle.

## Subscriptions

- Purpose: Subscriptions is a show/channel directory for quickly selecting content groups from the selected Jellyfin libraries.
- Data flow: The tab derives directory cards from the already-loaded videos/music/show pool and the lightweight series list, excluding movies because Movies has its own product surface.
- API usage: No background full-series fetch is triggered by opening Subscriptions; full show episodes still load lazily when the user opens a channel page.
- Controls: Follow/unfollow state and Subscribe buttons are intentionally absent.

## Watch Page

- Player: Keep central video, seek bar, skip buttons, volume, fullscreen, double-click fullscreen, wheel volume, and persistent volume.
- Metadata: Keep title, context button, views/date/runtime, resume note, and overview.
- Recommendations rail: Keep right rail on desktop and responsive stacking on mobile.
- Movies: Context button routes to Movies.
- Episodes: Episode shelf takes priority over generic queue panel.
- Mixes: Queue panel takes priority when there is no episode shelf.

## Search

- Search results page: Keep a single results grid.
- Ranking: Show/series matches rank above title-only false positives.
- Visual identity: Movies use poster cards; episodes and music/video use normal cards.

## Library Settings And Onboarding

- Onboarding fields: Keep server URL, username, password, admin/plugin validation, and library selection.
- Library cards: Keep library type and item-type metadata.
- Settings page: Keep multi-library selection and save action.
- Production readiness: Removed the hardcoded test server default from onboarding.

## Screenshot Review Notes

- `06-movies.png`: Movie surface now reads as a distinct Movies destination with a featured/resume item and poster grids.
- `06b-movie-context.png`: Clicking movie context returns to Movies as expected.
- `10b-snl-show-page.png`: SNL now opens to a season-aware show guide with a normal season selection rather than the prior outlier season.
- `13-channel.png`: Music/artist channel pages remain simple flat latest-video pages, which is appropriate for non-episodic channels.
- `13b-subscriptions.png`: Subscriptions shows a filterable show/channel directory and recent uploads without extra channel-wide API calls.
- `18-watch-mobile.png`: Watch layout remains usable on mobile after the additions.
