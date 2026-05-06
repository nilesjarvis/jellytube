# JellyTube Feature Audit

## Current Feature Surface

- Onboarding authenticates with Jellyfin, checks for an admin user, verifies the Playback Reporting plugin, and lets the user select supported libraries.
- Home loads a bounded Jellyfin item pool for fast startup, then builds continue-watching, recommended, new, and replay sections.
- Search combines Jellyfin item search, Jellyfin series search, cached full-series episodes, and local metadata ranking.
- Watch uses Jellyfin playback info, direct play when the browser can support it, HLS fallback when needed, Jellyfin playback reporting events, resume points, scrubbing, volume persistence, fullscreen, autoplay-next, and keyboard shortcuts.
- Episode shelves use `/Shows/{seriesId}/Episodes` on demand so large shows do not depend on the limited home feed.
- Music-video mixes act as playlist queues using the music-video library grouped by artist/channel.
- Channel pages use cached and on-demand full-series episodes and sort by Jellyfin content date.
- Movies are separated into a YouTube Movies-style view.
- Routing supports refresh/back/forward for home, search, watch, movies, music, channel, and library settings.

## API Findings

- `DateCreated` is Jellyfin/import time. It should not be used as the user-facing date for shows when `PremiereDate` is available.
- `PremiereDate` is the best available Jellyfin field for recorded/released/air date. JellyTube now treats it as the primary content date and falls back to `DateCreated`.
- Jellyfin item search can miss actual show matches because episode titles may not include the series name. Series search plus `/Shows/{seriesId}/Episodes` is required for expected searches such as `Homeland`.
- Large shows such as Saturday Night Live should not be loaded in full on startup. Loading the series index first and fetching full episodes on watch/search/channel keeps startup lighter while preserving complete episode shelves.
- Playback Reporting plugin activity is useful as a history signal, but the exposed `user_activity` endpoint on the tested server is aggregate-oriented. Jellyfin `UserData` on items is still the strongest per-item signal for resume, watched state, play count, and recommendations.

## Implemented From Audit

- Content dates now prefer `PremiereDate` for cards, channel ordering, recommendation freshness, music mixes, and home recency where available.
- Startup now fetches both release-date and import-date windows, then merges them so older imported archives and items without `PremiereDate` still appear.
- TV series are indexed separately from episodes, and full series episodes are fetched on demand for watch, search, and channel views.
- Channel pages now show full series episode sets when Jellyfin can resolve the channel to a series.
- Search ranking was moved into a testable module and prioritizes exact series/channel matches over incidental title matches.
- Unit tests cover SNL-style large-series ordering, duplicate episode metadata, Homeland search ranking, content-date fallbacks, channel grouping, and channel metadata.

## Realistic Next Features

- Add a "Latest from subscriptions" style channel strip using selected libraries and cached series/channel groups.
- Add "Watched" and "Unwatched" filters using `UserData.Played`, `PlayCount`, and `PlayedPercentage`.
- Add "Resume all" and "Start over" actions on the watch page by setting seek position to Jellyfin `PlaybackPositionTicks` or zero.
- Add an optional "shuffle mix" button for music-video mixes using only the local/cached queue.
- Add a "More from this show" channel tab split by season for TV series with many episodes.
- Add a lightweight background series prefetch queue after first paint, with a strict concurrency cap, for users who prefer richer recommendations over minimum network usage.

## Known Limits

- Jellyfin does not expose YouTube subscriptions, likes, comments, or upload-time semantics directly; JellyTube can only infer channels from series/artist/title metadata.
- Playback Reporting data can improve recommendation tokens, but it does not replace Jellyfin per-item `UserData` for exact watched/resume state.
- Some libraries have incomplete `PremiereDate`; those items fall back to `DateCreated`.
- Autoplay can still be blocked by browser media policy unless the prior playback interaction allows it.
