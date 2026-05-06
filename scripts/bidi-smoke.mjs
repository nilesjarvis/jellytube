import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';

const port = Number(process.env.BIDI_PORT || 9226);
const appUrl = process.env.JELLYTUBE_APP_URL || 'http://127.0.0.1:5173/';
const serverUrl = process.env.JELLYTUBE_SERVER_URL;
const username = process.env.JELLYTUBE_USERNAME;
const password = process.env.JELLYTUBE_PASSWORD;
const outputDir = process.env.SCREENSHOT_DIR || './screenshots';

if (!serverUrl || !username || !password) {
  throw new Error('Set JELLYTUBE_SERVER_URL, JELLYTUBE_USERNAME, and JELLYTUBE_PASSWORD.');
}

function routeUrl(path) {
  return new URL(path, appUrl).toString();
}

let nextId = 1;
let buffer = Buffer.alloc(0);
let handshaken = false;
const pending = new Map();

function makeFrame(text) {
  const payload = Buffer.from(text);
  const header = [0x81];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, payload.length >> 8, payload.length & 255);
  } else {
    throw new Error('Payload too large');
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function readFrame() {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  let offset = 2;
  let length = second & 0x7f;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const masked = (second & 0x80) !== 0;
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  let payload = buffer.slice(offset, offset + length);
  if (masked) payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  buffer = buffer.slice(offset + length);
  return { opcode: first & 0x0f, text: payload.toString('utf8') };
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');

    socket.on('connect', () => {
      socket.write(
        [
          'GET /session HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: webdriver-bidi',
          '',
          ''
        ].join('\r\n')
      );
    });

    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const status = buffer.slice(0, end).toString();
        if (!status.includes('101 Switching Protocols')) {
          reject(new Error(status));
          return;
        }
        buffer = buffer.slice(end + 4);
        handshaken = true;
        resolve(socket);
      }

      let frame;
      while ((frame = readFrame())) {
        if (frame.opcode !== 1 || !frame.text) continue;
        const message = JSON.parse(frame.text);
        if (message.id && pending.has(message.id)) {
          const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
          pending.delete(message.id);
          if (message.type === 'error') rejectPending(new Error(message.error || JSON.stringify(message)));
          else resolvePending(message.result);
        }
      }
    });
  });
}

function send(socket, method, params = {}) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  socket.write(makeFrame(JSON.stringify({ id, method, params })));
  return promise;
}

async function evaluate(socket, context, expression) {
  const result = await send(socket, 'script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true
  });
  return result?.result?.value ?? result?.value;
}

async function waitFor(socket, context, expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(socket, context, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const text = await evaluate(socket, context, `document.body.innerText`);
  await screenshot(socket, context, `failure-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  throw new Error(`Timed out waiting for ${label}\n${text}`);
}

async function screenshot(socket, context, name) {
  await new Promise((resolve) => setTimeout(resolve, 650));
  const shot = await send(socket, 'browsingContext.captureScreenshot', {
    context,
    origin: 'viewport'
  });
  const path = `${outputDir}/${name}.png`;
  await fs.writeFile(path, Buffer.from(shot.data, 'base64'));
  console.log(path);
}

async function setViewport(socket, context, width, height) {
  await send(socket, 'browsingContext.setViewport', {
    context,
    viewport: { width, height },
    devicePixelRatio: 1
  }).catch(() => {});
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const socket = await connect();
  await send(socket, 'session.new', { capabilities: {} });
  const tree = await send(socket, 'browsingContext.getTree', {});
  const context = tree.contexts[0].context;

  await setViewport(socket, context, 1440, 950);
  await send(socket, 'browsingContext.navigate', { context, url: appUrl, wait: 'complete' });
  await evaluate(
    socket,
    context,
    `
      (() => {
        localStorage.removeItem('jellytube.session.v1');
        localStorage.removeItem('jellytube.cinematicMode');
        localStorage.removeItem('jellytube.ultrawideCrop');
        localStorage.setItem('jellytube.theme', 'light');
        localStorage.setItem('jellytube.autoplayNext', 'true');
        return true;
      })()
    `
  );
  await send(socket, 'browsingContext.navigate', { context, url: appUrl, wait: 'complete' });
  await waitFor(socket, context, `document.body.innerText.includes('JellyTube')`, 'onboarding');
  await screenshot(socket, context, '01-onboarding');

  await evaluate(
    socket,
    context,
    `
      (async () => {
        const [server, user, pass] = document.querySelectorAll('input');
        for (const [element, value] of [[server, ${JSON.stringify(serverUrl)}], [user, ${JSON.stringify(username)}], [pass, ${JSON.stringify(password)}]]) {
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        document.querySelector('.primary-action').click();
        return true;
      })()
    `
  );

  await waitFor(socket, context, `document.querySelectorAll('.library-card').length > 0`, 'library picker');
  await screenshot(socket, context, '02-library-picker');

  await evaluate(socket, context, `document.querySelector('.library-continue').click()`);

  await waitFor(
    socket,
    context,
    `document.body.innerText.includes('Recommended') && document.querySelector('[aria-label="Subscriptions"]') && document.querySelectorAll('.video-card').length > 3`,
    'home feed',
    20000
  );
  await screenshot(socket, context, '03-home-feed-light');
  await evaluate(socket, context, `document.querySelector('.topbar-left .icon-button').click()`);
  await waitFor(
    socket,
    context,
    `document.querySelector('.app-shell.menu-open') && [...document.querySelectorAll('.sidebar button')].some((button) => button.innerText.includes('Subscriptions'))`,
    'expanded navigation'
  );
  await screenshot(socket, context, '03c-expanded-navigation');
  await evaluate(socket, context, `document.querySelector('.topbar-left .icon-button').click()`);
  await waitFor(socket, context, `!document.querySelector('.app-shell.menu-open')`, 'collapsed navigation');
  await evaluate(
    socket,
    context,
    `
      (() => {
        const recommended = [...document.querySelectorAll('.feed-section')]
          .find((section) => section.querySelector('h2')?.innerText.trim() === 'Recommended');
        if (recommended) {
          window.scrollTo({
            top: recommended.getBoundingClientRect().top + window.scrollY - 88,
            behavior: 'instant'
          });
        }
        return Boolean(recommended);
      })()
    `
  );
  await screenshot(socket, context, '03b-recommended');
  await evaluate(socket, context, `window.scrollTo({ top: 0, behavior: 'instant' })`);

  await evaluate(
    socket,
    context,
    `
      (() => {
        document.querySelector('.theme-toggle').click();
        return document.documentElement.dataset.theme;
      })()
    `
  );
  await waitFor(socket, context, `document.documentElement.dataset.theme === 'dark'`, 'dark mode');
  await screenshot(socket, context, '04-home-feed-dark');

  await evaluate(socket, context, `[...document.querySelectorAll('.sidebar button')].find((button) => button.innerText.includes('libs')).click()`);
  await waitFor(
    socket,
    context,
    `location.pathname === '/libraries' && document.body.innerText.includes('Selected Libraries') && document.querySelectorAll('.settings-grid .library-card').length > 0`,
    'library settings'
  );
  await screenshot(socket, context, '05-library-settings');

  await evaluate(socket, context, `[...document.querySelectorAll('.sidebar button')].find((button) => button.innerText.includes('Movies')).click()`);
  await waitFor(
    socket,
    context,
    `location.pathname === '/movies' && document.body.innerText.includes('YouTube Movies') && document.querySelectorAll('.movie-grid .video-card').length > 0`,
    'movies view'
  );
  await screenshot(socket, context, '06-movies');
  await evaluate(socket, context, `document.querySelector('.movie-grid .video-card .thumbnail-button').click()`);
  await waitFor(
    socket,
    context,
    `Boolean(
      location.pathname.startsWith('/watch/') &&
      document.querySelector('.watch-main h1') &&
      document.querySelector('.watch-channel') &&
      document.querySelector('.movie-recommendation-grid') &&
      document.querySelectorAll('.movie-recommendation-grid .video-card.poster').length > 0
    )`,
    'movie watch page'
  );
  await screenshot(socket, context, '06a-movie-watch');
  await evaluate(socket, context, `document.querySelector('.watch-channel').click()`);
  await waitFor(
    socket,
    context,
    `location.pathname === '/movies' && document.body.innerText.includes('YouTube Movies')`,
    'movie context returns to movies'
  );
  await screenshot(socket, context, '06b-movie-context');

  await evaluate(
    socket,
    context,
    `
      (() => {
        const search = document.querySelector('.search-form input');
        search.value = 'Homeland';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname === '/search' &&
        new URL(location.href).searchParams.get('q') === 'Homeland' &&
        document.querySelector('.video-card .video-channel')?.innerText.includes('Homeland') &&
        document.querySelector('.video-card .video-channel')?.innerText.includes('S07') &&
        !document.querySelector('.video-card .video-title')?.innerText.includes('Homeland S') &&
        !document.querySelector('.video-card .video-title')?.innerText.includes('Das Boot')
      )
    `,
    'homeland series search'
  );
  await screenshot(socket, context, '07-homeland-search');
  await evaluate(socket, context, `document.querySelector('.video-card .thumbnail-button').click()`);
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname.startsWith('/watch/') &&
        document.querySelector('.watch-channel')?.innerText === 'Homeland' &&
        !document.querySelector('.watch-main h1')?.innerText.includes('Homeland S') &&
        document.querySelector('.episode-shelf') &&
        document.querySelectorAll('.episode-strip .episode-tile').length > 8
      )
    `,
    'homeland episode shelf'
  );
  await screenshot(socket, context, '08-homeland-shelf');

  await send(socket, 'browsingContext.navigate', {
    context,
    url: routeUrl('/watch/ee4d0998c1c945dcc1f935ba89dc791e'),
    wait: 'complete'
  });
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname === '/watch/ee4d0998c1c945dcc1f935ba89dc791e' &&
        document.querySelector('.watch-channel')?.innerText === 'Saturday Night Live' &&
        document.body.innerText.includes('S29E09') &&
        !document.querySelector('.watch-main h1')?.innerText.includes('Saturday Night Live S29E09') &&
        document.querySelector('.episode-shelf') &&
        document.body.innerText.includes('S29E08') &&
        document.body.innerText.includes('S29E09') &&
        document.body.innerText.includes('S29E10')
      )
    `,
    'snl routed episode shelf',
    30000
  );
  await screenshot(socket, context, '09-snl-episode-shelf');
  await evaluate(
    socket,
    context,
    `
      (() => {
        window.__jellytubeSnlTitle = document.querySelector('.watch-main h1').innerText;
        document.querySelector('.player-shell video').dispatchEvent(new Event('ended', { bubbles: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `document.body.innerText.includes('S29E10') && !document.querySelector('.watch-main h1')?.innerText.includes('Saturday Night Live S29E10') && document.querySelector('.watch-main h1')?.innerText !== window.__jellytubeSnlTitle`,
    'snl next episode'
  );
  await screenshot(socket, context, '10-snl-next-episode');
  await evaluate(socket, context, `document.querySelector('.watch-channel').click()`);
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname.startsWith('/channel/') &&
        document.querySelector('.show-hero') &&
        document.querySelector('.show-up-next') &&
        document.querySelector('.show-progress-track') &&
        document.body.innerText.includes('Episodes') &&
        document.body.innerText.includes('Season') &&
        document.querySelectorAll('.show-guide .video-card').length > 1
      )
    `,
    'snl show channel page',
    30000
  );
  await screenshot(socket, context, '10b-snl-show-page');
  await setViewport(socket, context, 390, 900);
  await screenshot(socket, context, '10c-snl-show-page-mobile');
  await setViewport(socket, context, 1440, 950);

  await evaluate(
    socket,
    context,
    `
      (() => {
        const search = document.querySelector('.search-form input');
        search.value = 'S01E02';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `location.pathname === '/search' && new URL(location.href).searchParams.get('q') === 'S01E02' && document.body.innerText.includes('Search results') && document.querySelectorAll('.video-card').length > 0`,
    'episode search results'
  );
  await evaluate(socket, context, `document.querySelector('.video-card .thumbnail-button').click()`);
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname.startsWith('/watch/') &&
        document.querySelector('.episode-shelf') &&
        document.querySelector('.season-picker select') &&
        document.querySelectorAll('.episode-strip .episode-tile').length > 1 &&
        !document.querySelector('.queue-panel') &&
        document.querySelector('.autoplay-next input:checked')
      )
    `,
    'episode shelf'
  );
  await screenshot(socket, context, '07-episode-shelf');

  const episodeUrl = await evaluate(socket, context, `location.href`);
  await send(socket, 'browsingContext.navigate', { context, url: episodeUrl, wait: 'complete' });
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname.startsWith('/watch/') &&
        document.querySelector('.episode-shelf') &&
        document.querySelector('.season-picker select') &&
        document.querySelectorAll('.episode-strip .episode-tile').length > 1
      )
    `,
    'watch route refresh'
  );
  await screenshot(socket, context, '08-watch-route-refresh');

  await evaluate(
    socket,
    context,
    `
      (() => {
        window.__jellytubeEpisodeTitle = document.querySelector('.watch-main h1').innerText;
        window.__jellytubeEpisodePath = location.pathname;
        document.querySelector('.player-shell video').dispatchEvent(new Event('ended', { bubbles: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `document.querySelector('.watch-main h1')?.innerText !== window.__jellytubeEpisodeTitle && location.pathname !== window.__jellytubeEpisodePath && Boolean(document.querySelector('.episode-shelf'))`,
    'episode autoplay next'
  );
  await screenshot(socket, context, '09-episode-autoplay-next');

  await evaluate(socket, context, `[...document.querySelectorAll('.sidebar button')].find((button) => button.innerText.includes('Music')).click()`);
  await waitFor(
    socket,
    context,
    `location.pathname === '/music' && document.body.innerText.includes('Music Videos') && document.querySelectorAll('.video-card').length > 0`,
    'music videos view'
  );
  await screenshot(socket, context, '10-music-videos');

  await evaluate(socket, context, `document.querySelector('.mix-card').click()`);
  await waitFor(
    socket,
    context,
    `Boolean(location.pathname.startsWith('/watch/') && new URL(location.href).searchParams.get('list') === 'mix' && document.querySelector('.player-shell video') && document.querySelector('.queue-panel') && document.querySelector('.autoplay-next input:checked') && document.querySelector('.player-shell video').autoplay)`,
    'mix watch page'
  );
  await evaluate(
    socket,
    context,
    `
      (() => {
        const video = document.querySelector('.player-shell video');
        const shell = document.querySelector('.player-shell');
        video.volume = 0.5;
        video.muted = false;
        shell.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        window.__jellytubeWheelVolume = video.volume;
        return video.volume;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `window.__jellytubeWheelVolume > 0.5 && Math.abs(Number(localStorage.getItem('jellytube.playerVolume')) - window.__jellytubeWheelVolume) < 0.02`,
    'wheel volume persistence'
  );
  await evaluate(
    socket,
    context,
    `
      (async () => {
        const shell = document.querySelector('.player-shell');
        const target = document.querySelector('.player-hit-target');
        shell.requestFullscreen = async () => {
          window.__jellytubeDoubleClickFullscreen = true;
        };
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        return window.__jellytubeDoubleClickFullscreen;
      })()
    `
  );
  await waitFor(socket, context, `window.__jellytubeDoubleClickFullscreen === true`, 'double click fullscreen');
  await evaluate(
    socket,
    context,
    `
      (async () => {
        const video = document.querySelector('.player-shell video');
        video.muted = true;
        video.dispatchEvent(new Event('volumechange', { bubbles: true }));
        window.__jellytubePersistedVolume = video.volume;
        await video.play();
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      (() => {
        const video = document.querySelector('.player-shell video');
        return Boolean(video && !document.body.innerText.includes('Playback failed') && (video.readyState >= 2 || video.currentTime > 0 || !video.paused));
      })()
    `,
    'music video playback',
    45000
  );
  await evaluate(
    socket,
    context,
    `
      (() => {
        const video = document.querySelector('.player-shell video');
        const seek = document.querySelector('.player-seek');
        const target = Math.max(1, Math.min(4, Number(seek.max) || 4));
        seek.value = String(target);
        seek.dispatchEvent(new Event('input', { bubbles: true }));
        window.__jellytubeSeekTime = video.currentTime;
        return window.__jellytubeSeekTime;
      })()
    `
  );
  await waitFor(socket, context, `window.__jellytubeSeekTime >= 1`, 'timeline scrubbing');
  await screenshot(socket, context, '11-mix-watch-playing');

  await evaluate(
    socket,
    context,
    `
      (() => {
        window.__jellytubeMixTitle = document.querySelector('.watch-main h1').innerText;
        document.querySelector('.player-shell video').dispatchEvent(new Event('ended', { bubbles: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      (() => {
        const video = document.querySelector('.player-shell video');
        return Boolean(
          document.querySelector('.watch-main h1')?.innerText !== window.__jellytubeMixTitle &&
          document.querySelector('.queue-heading')?.innerText.includes('2 /') &&
          !document.body.innerText.includes('The play method is not allowed') &&
          video &&
          video.muted &&
          Math.abs(video.volume - window.__jellytubePersistedVolume) < 0.02
        );
      })()
    `,
    'mix autoplay next'
  );
  await evaluate(
    socket,
    context,
    `
      (async () => {
        const video = document.querySelector('.player-shell video');
        video.muted = true;
        video.dispatchEvent(new Event('volumechange', { bubbles: true }));
        await video.play();
        return true;
      })()
    `
  );
  await screenshot(socket, context, '12-mix-autoplay-next');

  await evaluate(socket, context, `document.querySelector('.watch-channel').click()`);
  await waitFor(
    socket,
    context,
    `location.pathname.startsWith('/channel/') && document.querySelector('.channel-header') && document.body.innerText.includes('Latest by release date') && document.querySelectorAll('.video-card').length > 0`,
    'channel page'
  );
  await screenshot(socket, context, '13-channel');

  await evaluate(socket, context, `[...document.querySelectorAll('.sidebar button')].find((button) => button.getAttribute('aria-label') === 'Subscriptions').click()`);
  await waitFor(
    socket,
    context,
    `
      Boolean(
        location.pathname === '/subscriptions' &&
        document.body.innerText.includes('Subscriptions') &&
        document.body.innerText.includes('Shows') &&
        document.body.innerText.includes('Channels') &&
        document.querySelectorAll('.subscription-card').length > 0 &&
        !document.body.innerText.includes('Subscribe')
      )
    `,
    'show and channel directory'
  );
  await screenshot(socket, context, '13b-subscriptions');

  await evaluate(
    socket,
    context,
    `
      (() => {
        const search = document.querySelector('.search-form input');
        search.value = 'SNL';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `location.pathname === '/search' && new URL(location.href).searchParams.get('q') === 'SNL' && document.body.innerText.includes('Search results')`,
    'search results'
  );
  await screenshot(socket, context, '14-search');

  await evaluate(
    socket,
    context,
    `
      (() => {
        document.querySelector('.video-card .thumbnail-button').click();
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `Boolean(location.pathname.startsWith('/watch/') && document.querySelector('.player-shell video') && document.querySelector('.player-shell video').autoplay)`,
    'watch page'
  );
  await evaluate(
    socket,
    context,
    `
      (async () => {
        const video = document.querySelector('.player-shell video');
        video.muted = true;
        video.dispatchEvent(new Event('volumechange', { bubbles: true }));
        await video.play();
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      Boolean(
        !document.querySelector('.player-frame')?.classList.contains('cinematic') &&
        !document.querySelector('.player-frame')?.classList.contains('ultrawide-crop') &&
        localStorage.getItem('jellytube.ultrawideCrop') !== 'true' &&
        localStorage.getItem('jellytube.cinematicMode') !== 'true'
      )
    `,
    'watch display modes off by default'
  );
  await evaluate(
    socket,
    context,
    `
      (() => {
        document.querySelector('.ultrawide-control').click();
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      (() => {
        const frame = document.querySelector('.player-frame');
        const shell = document.querySelector('.player-shell');
        const video = document.querySelector('.player-shell video');
        if (!frame?.classList.contains('ultrawide-crop') || localStorage.getItem('jellytube.ultrawideCrop') !== 'true') {
          return false;
        }
        const bounds = shell?.getBoundingClientRect();
        if (!bounds?.height) return false;
        const ratio = bounds.width / bounds.height;
        window.__jellytubeUltrawideRatio = ratio;
        return Math.abs(ratio - 21 / 9) < 0.08 && getComputedStyle(video).objectFit === 'cover';
      })()
    `,
    'ultrawide crop mode',
    12000
  );
  await screenshot(socket, context, '15a-ultrawide-watch');
  await evaluate(socket, context, `document.querySelector('.ultrawide-control').click()`);
  await waitFor(
    socket,
    context,
    `
      (() => {
        const frame = document.querySelector('.player-frame');
        const shell = document.querySelector('.player-shell');
        const video = document.querySelector('.player-shell video');
        const bounds = shell?.getBoundingClientRect();
        if (!bounds?.height) return false;
        const ratio = bounds.width / bounds.height;
        return (
          !frame?.classList.contains('ultrawide-crop') &&
          localStorage.getItem('jellytube.ultrawideCrop') === 'false' &&
          Math.abs(ratio - 16 / 9) < 0.08 &&
          getComputedStyle(video).objectFit === 'contain'
        );
      })()
    `,
    'ultrawide crop toggle off',
    12000
  );
  await evaluate(
    socket,
    context,
    `
      (() => {
        document.querySelector('.cinematic-control').click();
        return true;
      })()
    `
  );
  await waitFor(
    socket,
    context,
    `
      (() => {
        const frame = document.querySelector('.player-frame');
        if (!frame?.classList.contains('cinematic') || localStorage.getItem('jellytube.cinematicMode') !== 'true') {
          return false;
        }
        const glow = document.querySelector('.cinematic-glow');
        const shellBounds = document.querySelector('.player-shell')?.getBoundingClientRect();
        const glowBounds = glow?.getBoundingClientRect();
        const glowStyle = glow ? getComputedStyle(glow) : null;
        if (
          !glowStyle?.filter.includes('blur') ||
          !glowBounds ||
          !shellBounds ||
          glowBounds.left >= shellBounds.left - 20 ||
          glowBounds.right <= shellBounds.right + 20 ||
          glowBounds.top >= shellBounds.top - 20 ||
          glowBounds.bottom <= shellBounds.bottom + 20
        ) {
          return false;
        }
        const left = getComputedStyle(frame).getPropertyValue('--cinematic-left').trim();
        window.__jellytubeCinematicLeft = left;
        return left && left !== 'rgba(255, 0, 51, 0.38)';
      })()
    `,
    'cinematic glow sampling',
    12000
  );
  await screenshot(socket, context, '15b-cinematic-watch');
  await evaluate(socket, context, `document.querySelector('.cinematic-control').click()`);
  await waitFor(
    socket,
    context,
    `!document.querySelector('.player-frame')?.classList.contains('cinematic') && localStorage.getItem('jellytube.cinematicMode') === 'false'`,
    'cinematic glow toggle off'
  );
  await screenshot(socket, context, '15-watch');

  await evaluate(socket, context, `history.back()`);
  await waitFor(
    socket,
    context,
    `location.pathname === '/search' && new URL(location.href).searchParams.get('q') === 'SNL' && document.body.innerText.includes('Search results')`,
    'browser back to search'
  );
  await screenshot(socket, context, '16-browser-back-search');

  await evaluate(socket, context, `history.forward()`);
  await waitFor(
    socket,
    context,
    `Boolean(location.pathname.startsWith('/watch/') && document.querySelector('.player-shell video'))`,
    'browser forward to watch'
  );
  await screenshot(socket, context, '17-browser-forward-watch');

  await setViewport(socket, context, 390, 900);
  await screenshot(socket, context, '18-watch-mobile');

  await send(socket, 'session.end', {}).catch(() => {});
  socket.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
