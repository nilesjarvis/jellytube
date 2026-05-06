# JellyTube

A local Svelte frontend that turns a selected Jellyfin library into a YouTube-like browsing and watching experience.

## Requirements

- Node.js 20+
- A Jellyfin server reachable from the browser
- An admin Jellyfin account
- Jellyfin Playback Reporting plugin installed and active
- A Jellyfin library with downloaded YouTube videos, using either Shows or Home Videos & Photos

## Quick Setup On A Server

From the JellyTube directory, run:

```bash
./scripts/quick-setup.sh
```

The script installs dependencies, builds the production frontend, and starts JellyTube detached from the terminal.

Defaults:

- URL: `http://localhost:4173`
- Host binding: `0.0.0.0`
- Runtime files: `.jellytube/`
- PID file: `.jellytube/jellytube.pid`
- Log file: `.jellytube/jellytube.log`

To use a different host or port:

```bash
JELLYTUBE_PORT=8088 ./scripts/quick-setup.sh
```

Stop the detached server with:

```bash
./scripts/stop.sh
```

## Production Commands

```bash
npm ci
npm run build
npm run serve
```

`npm run serve` serves the built `dist/` folder with SPA routing fallback and static asset caching. It does not run the Vite development server.

## Development

```bash
npm install
npm run dev
```

Open the local Vite URL, sign in with Jellyfin credentials, and select the YouTube video library.

## Configuration

The production server reads these optional environment variables:

- `JELLYTUBE_HOST`: bind host, default `0.0.0.0`
- `JELLYTUBE_PORT`: bind port, default `4173`
- `JELLYTUBE_DIST`: build directory, default `dist`
- `JELLYTUBE_RUNTIME_DIR`: quick-setup runtime directory, default `.jellytube`
- `JELLYTUBE_PID_FILE`: PID file path
- `JELLYTUBE_LOG_FILE`: log file path

## Notes

JellyTube is a frontend-only app. Jellyfin credentials and session data are stored in the user's browser local storage, and media/API calls go directly from the browser to the configured Jellyfin server.
