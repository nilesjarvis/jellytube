import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelDirectoryEntries,
  filterChannelDirectory
} from '../src/lib/channelDirectory';
import { compareByContentDateDesc, contentDate, relativeDate } from '../src/lib/dates';
import { episodeCollectionForItem } from '../src/lib/episodes';
import {
  canDirectPreview,
  directStreamExtension,
  isDirectPreviewLightweight,
  isHoverPreviewEligible,
  previewHlsOptions
} from '../src/lib/hoverPreview';
import { assertUserCanPlayMedia, browserDeviceProfile, JellyfinClient } from '../src/lib/jellyfin';
import {
  canDirectPlaySource,
  detectDirectPlayCodecs,
  mediaCapabilitiesVideoConfiguration,
  shouldPreferDirectPlayForAuto
} from '../src/lib/codecSupport';
import { actorsForItem } from '../src/lib/people';
import {
  channelName,
  compactMeta,
  dailyRecommendationSeed,
  continueWatching,
  displayTitle,
  groupByChannel,
  personalPlaybackActivity,
  rankRecommendations,
  shouldStartFromBeginning,
  watchRecommendationCandidates
} from '../src/lib/recommendations';
import { recommendationQualityReport } from '../src/lib/recommendationQuality';
import {
  isOrderedEpisodicSeries,
  projectRecommendations
} from '../src/lib/showRecommendations';
import {
  blendCinematicGlowPalette,
  cinematicColorsFromImageData,
  cinematicColorsFromPalette,
  cinematicGlowStyle,
  cinematicPaletteFromImageData,
  cinematicPalettesAreClose,
  type CinematicGlowPalette,
  shouldSampleCinematicGlow
} from '../src/lib/cinematicGlow';
import {
  playbackQualityById,
  playbackQualityOptions
} from '../src/lib/playbackQuality';
import { applyProgressiveResult } from '../src/lib/progressiveLoad';
import {
  DEFAULT_PLAYER_SOURCE_ASPECT_RATIO,
  initialPlayerAspectMode,
  PLAYER_ASPECT_OPTIONS,
  playerAspectById,
  playerSourceAspectRatio
} from '../src/lib/playerAspect';
import {
  containerDefaultAudioStream,
  initialPlaybackAudioId,
  playbackAudioById,
  playbackAudioOptions,
  playbackAudioPreferenceKey,
  serializePlaybackAudioPreference
} from '../src/lib/playbackAudio';
import { rankSearchResults } from '../src/lib/search';
import { showProgressForEpisodes } from '../src/lib/showProgress';
import {
  countdownSecondsRemaining,
  episodePlayingNextItem,
  seriesNextUpItem,
  shouldAdvancePlayingNext,
  shouldShowPlayingNext
} from '../src/lib/playingNext';
import {
  createSearchSuggestionScheduler,
  shouldFetchSearchSuggestions,
  suggestionNameLabel
} from '../src/lib/searchSuggestions';
import type { JellyfinItem, JellyfinMediaSource, JellyfinUser } from '../src/lib/types';

function item(overrides: Partial<JellyfinItem> & Pick<JellyfinItem, 'Id' | 'Name'>): JellyfinItem {
  return {
    Type: 'Video',
    ...overrides
  };
}

function performanceSensitiveAv1Source(): JellyfinMediaSource {
  return {
    Id: '807b2118963df43167bbd3917266aff5',
    Container: 'mp4',
    Bitrate: 12_625_990,
    SupportsDirectPlay: true,
    SupportsTranscoding: true,
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      {
        Type: 'Video',
        Codec: 'av1',
        Profile: 'Main',
        Level: 12,
        BitDepth: 8,
        Width: 3596,
        Height: 2160,
        BitRate: 12_491_673,
        AverageFrameRate: 24,
        Index: 0
      },
      { Type: 'Audio', Codec: 'opus', BitRate: 132_194, Index: 1, IsDefault: true }
    ]
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('progressive loads publish ready sections without waiting for slower sections', async () => {
  const fast = deferred<string>();
  const slow = deferred<string>();
  const applied: string[] = [];
  const fastLoad = applyProgressiveResult(fast.promise, () => true, (value) => applied.push(value));
  const slowLoad = applyProgressiveResult(slow.promise, () => true, (value) => applied.push(value));

  fast.resolve('fast');
  assert.equal(await fastLoad, 'ready');
  assert.deepEqual(applied, ['fast']);

  slow.resolve('slow');
  assert.equal(await slowLoad, 'ready');
  assert.deepEqual(applied, ['fast', 'slow']);
});

test('progressive loads isolate errors and ignore stale results', async () => {
  const failed = deferred<string>();
  const stale = deferred<string>();
  const applied: string[] = [];
  let current = true;
  const failedLoad = applyProgressiveResult(failed.promise, () => current, (value) => applied.push(value));
  const staleLoad = applyProgressiveResult(stale.promise, () => current, (value) => applied.push(value));

  failed.reject(new Error('unavailable'));
  assert.equal(await failedLoad, 'error');

  current = false;
  stale.resolve('old data');
  assert.equal(await staleLoad, 'stale');
  assert.deepEqual(applied, []);
});

function episodeItem(
  seriesId: string,
  season: number,
  index: number,
  overrides: Partial<JellyfinItem> = {}
) {
  const code = `S${String(season).padStart(2, '0')}E${String(index).padStart(2, '0')}`;
  return item({
    Id: overrides.Id ?? `${seriesId}-${code}`,
    Name: overrides.Name ?? `${code} - Episode ${index}`,
    Type: 'Episode',
    SeriesId: seriesId,
    SeriesName: overrides.SeriesName ?? `Series ${seriesId}`,
    ParentIndexNumber: season,
    IndexNumber: index,
    ...overrides
  });
}

test('Jellyfin user playback guard allows non-admin users when playback is not disabled', () => {
  const allowedUsers: JellyfinUser[] = [
    { Id: 'allowed', Name: 'Allowed viewer', Policy: { IsAdministrator: false, EnableMediaPlayback: true } },
    { Id: 'unspecified', Name: 'Default viewer', Policy: { IsAdministrator: false } }
  ];

  for (const user of allowedUsers) {
    assert.doesNotThrow(() => assertUserCanPlayMedia(user));
  }
});

test('Jellyfin user playback guard rejects users with media playback disabled', () => {
  assert.throws(
    () => assertUserCanPlayMedia({
      Id: 'disabled',
      Name: 'Disabled viewer',
      Policy: { IsAdministrator: true, EnableMediaPlayback: false }
    }),
    (error) => error instanceof Error
      && error.message === 'This Jellyfin account is not allowed to play media.'
  );
});

test('content dates prefer Jellyfin PremiereDate over import DateCreated', () => {
  const snl = item({
    Id: 'snl-s29e09',
    Name: 'Jennifer Aniston/Black Eyed Peas',
    Type: 'Episode',
    SeriesName: 'Saturday Night Live',
    SeriesId: 'snl',
    ParentIndexNumber: 29,
    IndexNumber: 9,
    PremiereDate: '2004-01-10T00:00:00.0000000Z',
    DateCreated: '2025-07-26T00:55:28.197786Z'
  });

  assert.equal(contentDate(snl), '2004-01-10T00:00:00.0000000Z');
  assert.equal(relativeDate('2026-05-05T00:00:00.000Z', Date.parse('2026-05-06T12:00:00.000Z')), 'yesterday');
});

test('compact metadata and channel grouping use release date instead of import date', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-05-06T12:00:00.000Z');
  try {
    const oldEpisode = item({
      Id: 'old',
      Name: 'Old episode',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      PremiereDate: '1975-10-11T00:00:00.0000000Z',
      DateCreated: '2026-05-06T00:00:00.000Z'
    });
    const newerEpisode = item({
      Id: 'newer',
      Name: 'Newer episode',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 2,
      IndexNumber: 1,
      PremiereDate: '1976-09-18T00:00:00.0000000Z',
      DateCreated: '2025-01-01T00:00:00.000Z'
    });

    assert.match(compactMeta(oldEpisode), /51 years ago/);
    assert.deepEqual(groupByChannel([oldEpisode, newerEpisode])[0].items.map((episode) => episode.Id), ['newer', 'old']);
  } finally {
    Date.now = originalNow;
  }
});

test('episode collections sort full series episodes by season, episode, then premiere date', () => {
  const episodes = [
    item({
      Id: 'snl-s29e10',
      Name: 'Jessica Simpson and Nick Lachey/G-Unit',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 29,
      IndexNumber: 10,
      PremiereDate: '2004-01-17T00:00:00.0000000Z'
    }),
    item({
      Id: 'snl-s29e08',
      Name: 'Elijah Wood/Jet',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 29,
      IndexNumber: 8,
      PremiereDate: '2003-12-13T00:00:00.0000000Z'
    }),
    item({
      Id: 'snl-s29e09',
      Name: 'Jennifer Aniston/Black Eyed Peas',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 29,
      IndexNumber: 9,
      PremiereDate: '2004-01-10T00:00:00.0000000Z'
    }),
    item({
      Id: 'snl-s01e01-late-import',
      Name: 'October 11 - George Carlin copy',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      PremiereDate: '1975-10-11T00:00:00.0000000Z',
      DateCreated: '2026-02-24T23:14:28.715099Z'
    }),
    item({
      Id: 'snl-s01e01-original-import',
      Name: 'October 11 - George Carlin',
      Type: 'Episode',
      SeriesName: 'Saturday Night Live',
      SeriesId: 'snl',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      PremiereDate: '1975-10-11T00:00:00.0000000Z',
      DateCreated: '2025-07-26T03:27:34.2052551Z'
    })
  ];

  const collection = episodeCollectionForItem(episodes[2], episodes);

  assert.ok(collection);
  assert.deepEqual(collection.allItems.map((episode) => episode.Id), [
    'snl-s01e01-original-import',
    'snl-s01e01-late-import',
    'snl-s29e08',
    'snl-s29e09',
    'snl-s29e10'
  ]);
});

test('episode titles stay concise inside a series context', () => {
  const snl = item({
    Id: 'snl-s29e09',
    Name: 'Jennifer Aniston/Black Eyed Peas',
    Type: 'Episode',
    SeriesName: 'Saturday Night Live',
    SeriesId: 'snl',
    ParentIndexNumber: 29,
    IndexNumber: 9
  });
  const archivedName = item({
    Id: 'archive-s01e02',
    Name: 'Archive Show S01E02 - The Clear Title',
    Type: 'Episode'
  });

  assert.equal(displayTitle(snl), 'Saturday Night Live S29E09 - Jennifer Aniston/Black Eyed Peas');
  assert.equal(displayTitle(snl, { context: 'series' }), 'Jennifer Aniston/Black Eyed Peas');
  assert.equal(displayTitle(archivedName), 'Archive Show S01E02 - The Clear Title');
  assert.equal(displayTitle(archivedName, { context: 'series' }), 'The Clear Title');
});

test('channel context removes repeated channel names from video titles', () => {
  const sketch = item({
    Id: 'snl-sketch',
    Name: 'The Stand Off - Saturday Night Live [P40DyAwN13U]',
    Type: 'Video'
  });
  const musicVideo = item({
    Id: 'wet-leg',
    Name: 'Wet Leg： Mangetout ｜ SNL UK [x3V9FUZ2ajk]',
    Type: 'MusicVideo'
  });

  assert.equal(displayTitle(sketch), 'The Stand Off - Saturday Night Live [P40DyAwN13U]');
  assert.equal(displayTitle(sketch, { context: 'channel', channel: 'Saturday Night Live' }), 'The Stand Off');
  assert.equal(displayTitle(musicVideo, { context: 'channel', channel: 'Wet Leg' }), 'Mangetout ｜ SNL UK');
});

test('recommendation context keeps titles concise in mixed feeds', () => {
  const homeland = item({
    Id: 'homeland',
    Name: 'Paean to the People',
    Type: 'Episode',
    SeriesName: 'Homeland',
    SeriesId: 'homeland-series',
    ParentIndexNumber: 7,
    IndexNumber: 12
  });
  const sketch = item({
    Id: 'snl-sketch',
    Name: 'The Stand Off - Saturday Night Live [P40DyAwN13U]',
    Type: 'Video'
  });

  assert.equal(displayTitle(homeland), 'Homeland S07E12 - Paean to the People');
  assert.equal(displayTitle(homeland, { context: 'recommendation', channel: 'Homeland' }), 'Paean to the People');
  assert.equal(displayTitle(sketch, { context: 'recommendation', channel: 'Saturday Night Live' }), 'The Stand Off');
});

test('short partially watched videos are restarted instead of resumed', () => {
  const short = item({
    Id: 'short-started',
    Name: 'Short clip',
    RunTimeTicks: 7 * 60 * 10_000_000,
    UserData: {
      PlaybackPositionTicks: 2 * 60 * 10_000_000,
      PlayedPercentage: 28,
      LastPlayedDate: '2026-05-06T12:00:00.000Z'
    }
  });
  const long = item({
    Id: 'long-started',
    Name: 'Long essay',
    RunTimeTicks: 24 * 60 * 10_000_000,
    UserData: {
      PlaybackPositionTicks: 5 * 60 * 10_000_000,
      PlayedPercentage: 21,
      LastPlayedDate: '2026-05-06T13:00:00.000Z'
    }
  });

  assert.equal(shouldStartFromBeginning(short), true);
  assert.equal(shouldStartFromBeginning(long), false);
  assert.deepEqual(continueWatching([short, long]).map((result) => result.Id), ['long-started']);
});

test('recommendations penalize recently finished items without hard excluding them', () => {
  const current = item({ Id: 'current', Name: 'Current video', contentKind: 'video' });
  const queued = item({ Id: 'queued', Name: 'Queued video', contentKind: 'video' });
  const finished = item({ Id: 'finished', Name: 'Finished video', contentKind: 'video' });
  const resumable = item({
    Id: 'resumable',
    Name: 'Long started video',
    contentKind: 'video',
    RunTimeTicks: 30 * 60 * 10_000_000,
    UserData: {
      PlaybackPositionTicks: 6 * 60 * 10_000_000,
      PlayedPercentage: 20
    }
  });
  const watchedYesterday = item({
    Id: 'watched-yesterday',
    Name: 'Recently completed video',
    contentKind: 'video',
    UserData: {
      Played: true,
      PlayCount: 1,
      LastPlayedDate: '2026-05-06T12:00:00.000Z'
    }
  });
  const candidate = item({ Id: 'candidate', Name: 'Fresh candidate', contentKind: 'video' });

  const ranked = rankRecommendations([current, queued, finished, resumable, watchedYesterday, candidate], {
    currentItem: current,
    queueItems: [queued],
    recentItemIds: ['finished'],
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    randomness: 0
  });

  assert.deepEqual(ranked.map((result) => result.Id), ['candidate', 'finished']);
});

test('music recommendations can include recently replayed music videos', () => {
  const playedMusic = item({
    Id: 'played-music',
    Name: 'Replayable Song',
    Type: 'MusicVideo',
    contentKind: 'musicVideo',
    UserData: {
      Played: true,
      PlayCount: 6,
      LastPlayedDate: '2026-05-07T11:00:00.000Z'
    }
  });
  const playedVideo = item({
    Id: 'played-video',
    Name: 'Completed standard video',
    contentKind: 'video',
    UserData: {
      Played: true,
      PlayCount: 2,
      LastPlayedDate: '2026-05-07T11:00:00.000Z'
    }
  });
  const candidate = item({ Id: 'candidate', Name: 'Unplayed music video', Type: 'MusicVideo', contentKind: 'musicVideo' });

  const ranked = rankRecommendations([playedMusic, playedVideo, candidate], {
    mode: 'music',
    recentItemIds: ['played-music'],
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    randomness: 0
  });

  assert.deepEqual(ranked.map((result) => result.Id), ['candidate', 'played-music']);
});

test('hover preview is limited to non-movie videos on fine pointer devices', () => {
  const video = item({ Id: 'video-preview', Name: 'Video', contentKind: 'video' });
  const music = item({ Id: 'music-preview', Name: 'Music', Type: 'MusicVideo', contentKind: 'musicVideo' });
  const movie = item({ Id: 'movie-preview', Name: 'Movie', Type: 'Movie', contentKind: 'movie' });

  assert.equal(isHoverPreviewEligible(video), true);
  assert.equal(isHoverPreviewEligible(music), true);
  assert.equal(isHoverPreviewEligible(movie), false);
  assert.equal(isHoverPreviewEligible(video, { poster: true }), false);
  assert.equal(isHoverPreviewEligible(video, { finePointer: false }), false);
  assert.equal(isHoverPreviewEligible(video, { reducedMotion: true }), false);
});

test('hover preview chooses direct playable sources and low-bitrate hls options', () => {
  const webm = {
    Id: 'source',
    Container: 'webm',
    SupportsDirectPlay: true,
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: 2,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'vp9' },
      { Type: 'Audio' as const, Codec: 'opus', Index: 1 }
    ]
  };
  const av1 = {
    ...webm,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'av1' },
      { Type: 'Audio' as const, Codec: 'opus', Index: 1 }
    ]
  };
  const lowBitrate1080pVp9 = {
    ...webm,
    Bitrate: 1_500_000,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'vp9', Width: 1920, Height: 1080, BitRate: 1_500_000 },
      { Type: 'Audio' as const, Codec: 'opus', Index: 1 }
    ]
  };
  const heavyWebm = {
    ...webm,
    Bitrate: 24_000_000,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'vp9', Width: 3840, Height: 2160, BitRate: 24_000_000 },
      { Type: 'Audio' as const, Codec: 'opus', Index: 1 }
    ]
  };
  const video = {
    canPlayType: (mime: string) =>
      mime.includes('webm') && !mime.includes('av01') ? 'probably' : ''
  };
  const av1Video = {
    canPlayType: (mime: string) => (mime.includes('av01') ? 'probably' : '')
  };

  assert.equal(directStreamExtension(webm), 'webm');
  assert.equal(canDirectPreview(webm, video), true);
  assert.equal(isDirectPreviewLightweight(webm), true);
  assert.equal(canDirectPreview(av1, video), false);
  assert.equal(canDirectPreview(av1, av1Video), true);
  assert.equal(isDirectPreviewLightweight(lowBitrate1080pVp9), true);
  assert.equal(canDirectPreview(heavyWebm, video), true);
  assert.equal(isDirectPreviewLightweight(heavyWebm), false);
  assert.deepEqual(previewHlsOptions(webm, 'preview-session'), {
    startTicks: 0,
    playSessionId: 'preview-session',
    audioStreamIndex: 1,
    subtitleStreamIndex: undefined,
    maxWidth: 640,
    maxHeight: 360,
    videoBitrate: 1500000,
    audioBitrate: 128000
  });
});

test('playback quality options use bitrate labels and filter above source resolution', () => {
  const source = {
    Id: 'source',
    Container: 'mp4',
    Bitrate: 9_500_000,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'h264', Width: 1280, Height: 720, BitRate: 9_000_000 },
      { Type: 'Audio' as const, Codec: 'aac', Index: 1 }
    ]
  };

  const options = playbackQualityOptions(source, { directAvailable: true });

  assert.deepEqual(options.map((option) => option.label), ['Auto', 'Original', '4 Mbps', '2 Mbps', '1 Mbps']);
  assert.equal(options[1].detail, '720p · 9.5 Mbps');
  assert.equal(playbackQualityById(options, 'hls-20000k')?.id, 'auto');
  assert.equal(playbackQualityById(options, 'hls-4000k')?.videoBitrate, 4_000_000);
});

test('player aspect modes expose non-cropping stretch targets and validate saved choices', () => {
  assert.deepEqual(
    PLAYER_ASPECT_OPTIONS.filter((option) => option.behavior === 'stretch').map((option) => option.id),
    ['stretch-4-3', 'stretch-16-9', 'stretch-21-9']
  );
  assert.equal(playerAspectById('stretch-21-9')?.label, 'Stretch to 21:9');
  assert.equal(initialPlayerAspectMode('stretch-16-9'), 'stretch-16-9');
  assert.equal(initialPlayerAspectMode('unsupported'), 'fit');
});

test('player aspect mode migrates the former ultrawide crop preference', () => {
  assert.equal(initialPlayerAspectMode(null, true), 'crop-21-9');
  assert.equal(initialPlayerAspectMode('stretch-21-9', true), 'stretch-21-9');
});

test('player source aspect follows intrinsic video dimensions with a safe fallback', () => {
  assert.equal(playerSourceAspectRatio(2560, 1080), 2560 / 1080);
  assert.equal(playerSourceAspectRatio(1080, 1920), 1080 / 1920);
  assert.equal(playerSourceAspectRatio(0, 1080), DEFAULT_PLAYER_SOURCE_ASPECT_RATIO);
  assert.equal(playerSourceAspectRatio(undefined, undefined, 2.4), 2.4);
});

test('playback audio options keep indexed audio streams and preserve duplicate labels', () => {
  const options = playbackAudioOptions({
    Id: 'source',
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'h264' },
      { Type: 'Audio', Index: 1, Language: 'eng', DisplayTitle: 'English', Codec: 'aac', IsDefault: true },
      { Type: 'Audio', Index: 2, Language: 'eng', DisplayTitle: 'English', Codec: 'ac3' },
      { Type: 'Audio', Index: 2, Language: 'spa', DisplayTitle: 'Duplicate index' },
      { Type: 'Audio', Language: 'fra', Title: 'Unindexed' },
      { Type: 'Audio', Index: 3, Language: 'jpn' },
      { Type: 'Audio', Index: 4 }
    ]
  });

  assert.deepEqual(options.map(({ id, label, detail, index }) => ({ id, label, detail, index })), [
    { id: 'audio-1', label: 'English', detail: 'ENG · Default · AAC', index: 1 },
    { id: 'audio-2', label: 'English', detail: 'ENG · AC3', index: 2 },
    { id: 'audio-3', label: 'JPN', detail: 'JPN', index: 3 },
    { id: 'audio-4', label: 'Audio 4', detail: '', index: 4 }
  ]);
  assert.equal(playbackAudioById(options, 'audio-2')?.index, 2);
  assert.equal(playbackAudioById(options, 'audio-missing')?.index, 1);
});

test('playback audio preference resolves exact matches then prioritizes language over cross-language titles', () => {
  const source = {
    Id: 'source',
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      { Type: 'Audio' as const, Index: 1, Language: 'eng', Title: 'Main', IsDefault: true },
      { Type: 'Audio' as const, Index: 2, Language: 'eng', Title: 'Commentary' },
      { Type: 'Audio' as const, Index: 3, Language: 'spa', Title: 'Commentary' },
      { Type: 'Audio' as const, Index: 4, Language: 'fra', Title: 'Surround' }
    ]
  };
  const options = playbackAudioOptions(source);

  assert.equal(
    initialPlaybackAudioId(source, options, JSON.stringify({ language: ' SPA ', title: 'Commentary' })),
    'audio-3'
  );
  assert.equal(
    initialPlaybackAudioId(source, options, JSON.stringify({ language: 'deu', title: 'Commentary' })),
    'audio-2'
  );
  assert.equal(
    initialPlaybackAudioId(source, options, JSON.stringify({ language: 'eng', title: 'Surround' })),
    'audio-1'
  );
});

test('playback audio preference falls back across items by language using source defaults first', () => {
  const source = {
    Id: 'next-item',
    DefaultAudioStreamIndex: 3,
    MediaStreams: [
      { Type: 'Audio' as const, Index: 1, Language: 'eng', Title: 'Main', IsDefault: true },
      { Type: 'Audio' as const, Index: 2, Language: 'spa', Title: 'Main' },
      { Type: 'Audio' as const, Index: 3, Language: 'eng', Title: 'Descriptive' }
    ]
  };
  const options = playbackAudioOptions(source);

  assert.equal(
    initialPlaybackAudioId(source, options, JSON.stringify({ language: 'ENG', title: 'Old commentary' })),
    'audio-3'
  );
});

test('playback audio preference safely falls back for malformed or stale values and invalid defaults', () => {
  const source = {
    Id: 'source',
    DefaultAudioStreamIndex: 99,
    MediaStreams: [
      { Type: 'Audio' as const, Index: 5, Language: 'fra' },
      { Type: 'Audio' as const, Index: 7, Language: 'eng', IsDefault: true }
    ]
  };
  const options = playbackAudioOptions(source);

  assert.equal(initialPlaybackAudioId(source, options, '{bad json'), 'audio-7');
  assert.equal(initialPlaybackAudioId(source, options, JSON.stringify({ language: 'deu', title: 'Missing' })), 'audio-7');
  assert.equal(initialPlaybackAudioId(source, options, JSON.stringify({ language: 12, index: 5 })), 'audio-7');
  assert.equal(initialPlaybackAudioId(source, options, null), 'audio-7');
  assert.equal(initialPlaybackAudioId({ ...source, DefaultAudioStreamIndex: 5 }, options, null), 'audio-5');
  const serverSelectedSource = {
    Id: 'server-selected',
    DefaultAudioStreamIndex: 2,
    MediaStreams: [
      { Type: 'Audio' as const, Index: 1, Language: 'eng', IsDefault: true },
      { Type: 'Audio' as const, Index: 2, Language: 'jpn' }
    ]
  };
  assert.equal(containerDefaultAudioStream(serverSelectedSource)?.Index, 1);
});

test('playback audio preferences serialize semantic identity without a stream index', () => {
  const option = playbackAudioOptions({
    Id: 'source',
    MediaStreams: [
      { Type: 'Audio', Index: 12, Language: ' ENG ', Title: ' Director commentary ', DisplayTitle: 'English commentary' }
    ]
  })[0];

  const serialized = serializePlaybackAudioPreference(option);
  assert.deepEqual(JSON.parse(serialized), { language: 'eng', title: 'Director commentary' });
  assert.equal(serialized.includes('12'), false);
  assert.equal(serialized.includes('index'), false);
});

test('playback audio preferences preserve DisplayTitle-only tracks case-insensitively', () => {
  const source = {
    Id: 'source',
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      { Type: 'Audio' as const, Index: 1, Language: 'eng', DisplayTitle: 'English AAC', IsDefault: true },
      { Type: 'Audio' as const, Index: 2, Language: 'eng', Title: '   ', DisplayTitle: 'English Stereo' }
    ]
  };
  const options = playbackAudioOptions(source);
  const serialized = serializePlaybackAudioPreference(options[1]);

  assert.deepEqual(JSON.parse(serialized), { language: 'eng', title: 'English Stereo' });
  assert.equal(initialPlaybackAudioId(source, options, serialized), 'audio-2');
  assert.equal(
    initialPlaybackAudioId(source, options, JSON.stringify({ language: 'ENG', title: 'english stereo' })),
    'audio-2'
  );
});

test('playback audio preference keys normalize servers and remain server and user scoped', () => {
  const normalized = playbackAudioPreferenceKey(' https://media.example.test/// ', 'user-a');

  assert.equal(normalized, playbackAudioPreferenceKey('https://media.example.test', 'user-a'));
  assert.notEqual(normalized, playbackAudioPreferenceKey('https://other.example.test', 'user-a'));
  assert.notEqual(normalized, playbackAudioPreferenceKey('https://media.example.test', 'user-b'));
});

test('watch recommendations prefer similar metadata over same-channel filler', () => {
  const current = item({
    Id: 'current-physics',
    Name: 'Quantum physics explained - Physics Channel',
    contentKind: 'video',
    RunTimeTicks: 18 * 60 * 10_000_000,
    Genres: ['Science'],
    Tags: ['physics', 'quantum']
  });
  const sameChannel = item({
    Id: 'same-channel',
    Name: 'Weekly mailbag - Physics Channel',
    contentKind: 'video',
    RunTimeTicks: 18 * 60 * 10_000_000
  });
  const similar = item({
    Id: 'similar',
    Name: 'Quantum physics experiment explained - Science Lab',
    contentKind: 'video',
    RunTimeTicks: 20 * 60 * 10_000_000,
    Genres: ['Science'],
    Tags: ['physics', 'quantum']
  });

  const ranked = rankRecommendations([sameChannel, similar], {
    currentItem: current,
    mode: 'watch',
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    randomness: 0
  });

  assert.deepEqual(ranked.map((result) => result.Id), ['similar', 'same-channel']);
  assert.deepEqual(
    watchRecommendationCandidates(ranked, current).map((result) => result.Id),
    ['similar', 'same-channel']
  );
});

test('recommendations vary within similarly relevant candidates when seeded differently', () => {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    item({
      Id: `candidate-${index + 1}`,
      Name: `Fresh candidate ${index + 1}`,
      contentKind: 'video',
      RunTimeTicks: 12 * 60 * 10_000_000,
      Genres: ['Science']
    })
  );

  const first = rankRecommendations(candidates, {
    mode: 'home',
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    randomSeed: 'first-refresh'
  }).map((result) => result.Id);
  const second = rankRecommendations(candidates, {
    mode: 'home',
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    randomSeed: 'second-refresh'
  }).map((result) => result.Id);

  assert.notDeepEqual(first, second);
  assert.deepEqual([...first].sort(), [...second].sort());
});

test('daily recommendation seeds are stable within a UTC day', () => {
  const morning = Date.parse('2026-05-07T00:00:01.000Z');
  const evening = Date.parse('2026-05-07T23:59:59.000Z');
  const nextDay = Date.parse('2026-05-08T00:00:00.000Z');

  assert.equal(
    dailyRecommendationSeed('user-1', 'home', morning),
    dailyRecommendationSeed('user-1', 'home', evening)
  );
  assert.notEqual(
    dailyRecommendationSeed('user-1', 'home', evening),
    dailyRecommendationSeed('user-1', 'home', nextDay)
  );
  assert.notEqual(
    dailyRecommendationSeed('user-1', 'home', morning),
    dailyRecommendationSeed('user-1', 'music', morning)
  );
});

test('Jellyfin similarity signals improve order without bypassing eligibility', () => {
  const related = item({ Id: 'related', Name: 'Related discovery', contentKind: 'video' });
  const plain = item({ Id: 'plain', Name: 'Plain discovery', contentKind: 'video' });
  const resumable = item({
    Id: 'resumable-related',
    Name: 'Unfinished related video',
    contentKind: 'video',
    RunTimeTicks: 30 * 60 * 10_000_000,
    UserData: { PlaybackPositionTicks: 10 * 60 * 10_000_000, PlayedPercentage: 33 }
  });
  const completed = item({
    Id: 'completed-related',
    Name: 'Completed related video',
    contentKind: 'video',
    UserData: { Played: true, PlayCount: 1 }
  });
  const ranked = rankRecommendations([plain, related, resumable, completed], {
    mode: 'home',
    randomness: 0,
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    relatedItemScores: new Map([
      ['related', 1],
      ['resumable-related', 1],
      ['completed-related', 1]
    ])
  });

  assert.deepEqual(ranked.map((result) => result.Id), ['related', 'plain']);
  assert.equal(ranked[0].reason, 'matches what you watch');
  assert.ok(ranked.every((result) => !result.reason?.toLowerCase().includes('jellyfin')));
});

test('recommendation reasons never present a recent-play penalty as positive evidence', () => {
  const recent = item({ Id: 'recent', Name: 'Recently sampled', contentKind: 'video' });
  const [ranked] = rankRecommendations([recent], {
    mode: 'home',
    recentItemIds: ['recent'],
    randomness: 0,
    now: Date.parse('2026-05-07T12:00:00.000Z')
  });

  assert.equal(ranked.reason, 'library discovery');
  assert.ok(!ranked.reasons?.some((reason) => reason.includes('recent')));
});

test('watch recommendation composition removes current-series episodes without reordering discovery', () => {
  const current = item({
    Id: 'show-current',
    Name: 'Current episode',
    Type: 'Episode',
    SeriesId: 'show-1',
    SeriesName: 'Show One'
  });
  const ranked = [
    item({ Id: 'external-first', Name: 'External first', SeriesId: 'show-2', SeriesName: 'Show Two' }),
    item({
      Id: 'same-series',
      Name: 'Next episode',
      Type: 'Episode',
      SeriesId: 'show-1',
      SeriesName: 'Show One',
      ParentIndexNumber: 1,
      IndexNumber: 2
    }),
    item({ Id: 'external-second', Name: 'External second' })
  ];

  assert.deepEqual(
    watchRecommendationCandidates(ranked, current).map((result) => result.Id),
    ['external-first', 'external-second']
  );
});

test('playback activity uses only anonymous or current-user rows', () => {
  const rows = [
    { item_name: 'By id', user_id: 'user-1', user_name: 'Other label' },
    { item_name: 'By name', user_id: 'plugin-7', user_name: 'Viewer' },
    { item_name: 'Anonymous aggregate' },
    { item_name: 'Other user', user_id: 'user-2', user_name: 'Someone else' }
  ];

  assert.deepEqual(
    personalPlaybackActivity(rows, 'USER-1', 'viewer').map((row) => row.item_name),
    ['By id', 'By name', 'Anonymous aggregate']
  );
});

test('recommendation quality report is deterministic and separates legacy coverage misses', () => {
  const target = item({
    Id: 'held-out-movie',
    Name: 'Held out movie',
    Type: 'Movie',
    contentKind: 'movie',
    DateCreated: '2026-05-01T00:00:00.000Z',
    UserData: { Played: true, PlayCount: 1, LastPlayedDate: '2026-05-06T12:00:00.000Z' }
  });
  const movieCandidate = item({
    Id: 'movie-candidate',
    Name: 'Movie candidate',
    Type: 'Movie',
    contentKind: 'movie',
    DateCreated: '2026-04-01T00:00:00.000Z'
  });
  const replay = item({
    Id: 'music-replay',
    Name: 'Music replay',
    Type: 'MusicVideo',
    contentKind: 'musicVideo',
    DateCreated: '2026-04-01T00:00:00.000Z',
    UserData: { Played: true, PlayCount: 2 }
  });
  const input = {
    catalog: [target, movieCandidate, replay],
    legacyCatalog: [movieCandidate, replay],
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    seed: 'quality-test',
    relatedItemScores: new Map([['music-replay', 1]])
  };

  const first = recommendationQualityReport(input);
  const second = recommendationQualityReport(input);
  assert.deepEqual(first, second);
  assert.equal(first.method, 'latest-play-proxy');
  assert.equal(first.backtest.signalMode, 'local-only');
  assert.equal(first.backtest.events, 1);
  assert.equal(first.backtest.full.targetPresent, 1);
  assert.equal(first.backtest.legacy.targetAbsent, 1);
  assert.equal(first.lists.top12.resumeLeakage.clear, true);
  assert.equal(first.lists.top12.completedLeakage.clear, true);
  assert.equal(first.lists.top12.replayExposure.count, 1);
  assert.equal(first.lists.top12.reasons.complete, true);
  assert.equal(first.lists.top12.relatedSignals.covered, 1);
});

test('ordered show classification requires sequence evidence and tolerates real duplicate rates', () => {
  const ordered = Array.from({ length: 7 }, (_, index) => episodeItem('ordered', 1, index + 1));
  const toleratedDuplicate = episodeItem('ordered', 1, 7, { Id: 'ordered-copy' });
  const clips = Array.from({ length: 8 }, (_, index) =>
    episodeItem('clips', 1, index + 1, {
      Name: `Weekly upload ${String(index + 1)}`
    })
  );
  const excessiveDuplicates = [
    ...Array.from({ length: 5 }, (_, index) => episodeItem('duplicate-heavy', 1, index + 1)),
    episodeItem('duplicate-heavy', 1, 5, { Id: 'duplicate-heavy-copy' })
  ];

  assert.equal(
    isOrderedEpisodicSeries([...ordered, toleratedDuplicate], {
      Id: 'ordered',
      Name: 'Ordered show',
      Type: 'Series',
      RecursiveItemCount: 8
    }),
    true
  );
  assert.equal(
    isOrderedEpisodicSeries(clips, {
      Id: 'clips',
      Name: 'Ordinary title archive',
      Type: 'Series',
      RecursiveItemCount: 8
    }),
    false
  );
  assert.equal(
    isOrderedEpisodicSeries(clips, {
      Id: 'clips',
      Name: 'Ordinary title archive',
      Type: 'Series',
      RecursiveItemCount: 8,
      ProviderIds: { Tvdb: '   ' }
    }),
    false
  );
  assert.equal(isOrderedEpisodicSeries(excessiveDuplicates), false);
  assert.equal(
    isOrderedEpisodicSeries(ordered, {
      Id: 'ordered',
      Name: 'Incomplete show',
      Type: 'Series',
      RecursiveItemCount: 8
    }),
    false
  );
});

test('recommendations collapse ordered episodes into one progress-aware show card', () => {
  const first = episodeItem('ordered', 1, 1, { UserData: { Played: true } });
  const second = episodeItem('ordered', 1, 2);
  const third = episodeItem('ordered', 1, 3);
  const clipFirst = {
    ...episodeItem('clips', 1, 1, { Id: 'clip-first', Name: 'Weekly clip S01E01' }),
    score: 100,
    reason: 'matches what you watch'
  };
  const clipSecond = {
    ...episodeItem('clips', 1, 2, { Id: 'clip-second', Name: 'Another clip S01E02' }),
    score: 70,
    reason: 'library discovery'
  };
  const representative = {
    ...third,
    score: 90,
    reason: 'more from a series you watch'
  };
  const unrelated = { ...item({ Id: 'plain-video', Name: 'Plain video' }), score: 80, reason: 'library discovery' };
  const rankedSecond = { ...second, score: 60, reason: 'more from a series you watch' };

  const projected = projectRecommendations(
    [clipFirst, representative, unrelated, rankedSecond, clipSecond],
    [clipFirst, clipSecond, third, first, second],
    [{ Id: 'ordered', Name: 'Ordered show', Type: 'Series', RecursiveItemCount: 3 }]
  );

  assert.deepEqual(projected.map((recommendation) => recommendation.kind), [
    'item',
    'show',
    'item',
    'item'
  ]);
  const firstRecommendation = projected[0];
  assert.equal(firstRecommendation.kind, 'item');
  if (firstRecommendation.kind !== 'item') assert.fail('Expected the clip recommendation to remain an item.');
  assert.strictEqual(firstRecommendation.item, clipFirst);
  const show = projected[1];
  assert.equal(show.kind, 'show');
  if (show.kind !== 'show') assert.fail('Expected ordered episodes to collapse into a show.');
  assert.equal(show.title, 'Ordered show');
  assert.equal(show.representative.Id, third.Id);
  assert.equal(show.reason, 'more from a series you watch');
  assert.deepEqual(show.episodes.map((episode) => episode.Id), [first.Id, second.Id, third.Id]);
  assert.equal(show.progress.kind, 'next');
  assert.equal(show.progress.primaryItem?.Id, second.Id);
  assert.equal(show.progress.label, 'Next S01E02');
  const lastRecommendation = projected[3];
  assert.equal(lastRecommendation.kind, 'item');
  if (lastRecommendation.kind !== 'item') assert.fail('Expected the second clip to remain an item.');
  assert.strictEqual(lastRecommendation.item, clipSecond);
  const quality = recommendationQualityReport({
    catalog: [first, second, third],
    seriesItems: [
      { Id: 'ordered', Name: 'Ordered show', Type: 'Series', RecursiveItemCount: 3 }
    ],
    now: Date.parse('2026-05-07T12:00:00.000Z'),
    seed: 'projected-quality'
  });
  assert.equal(quality.lists.presentation, 'home-projected');
  assert.equal(quality.lists.top12.size, 1);
  assert.equal(quality.lists.top12.showCards, 1);
  assert.equal(quality.lists.top12.itemCards, 0);
});

test('standard series metadata projects ordinary episode titles with resume progress', () => {
  const pilot = episodeItem('gossip-girl', 1, 1, {
    Name: 'Pilot',
    UserData: { Played: true }
  });
  const wildBrunch = episodeItem('gossip-girl', 1, 2, {
    Name: 'The Wild Brunch',
    UserData: { PlayedPercentage: 37, LastPlayedDate: '2026-05-06T12:00:00.000Z' }
  });
  const poisonIvy = episodeItem('gossip-girl', 1, 3, { Name: 'Poison Ivy' });
  const representative = {
    ...poisonIvy,
    score: 90,
    reason: 'more from a series you watch'
  };

  const projected = projectRecommendations(
    [representative, { ...wildBrunch, score: 80, reason: 'continue a series' }],
    [poisonIvy, pilot, wildBrunch],
    [{
      Id: 'gossip-girl',
      Name: 'Gossip Girl',
      Type: 'Series',
      RecursiveItemCount: 3,
      ProviderIds: { tVdB: ' 80547 ' }
    }]
  );

  assert.equal(projected.length, 1);
  const [show] = projected;
  assert.equal(show.kind, 'show');
  if (show.kind !== 'show') assert.fail('Expected canonical TV metadata to identify an ordered show.');
  assert.equal(show.title, 'Gossip Girl');
  assert.deepEqual(show.episodes.map((episode) => episode.Name), [
    'Pilot',
    'The Wild Brunch',
    'Poison Ivy'
  ]);
  assert.equal(show.progress.kind, 'resume');
  assert.equal(show.progress.primaryItem?.Id, wildBrunch.Id);
  assert.equal(show.progress.label, 'Resume S01E02');
});

test('ordered show projection deduplicates episode slots using the strongest playback state', () => {
  const original = episodeItem('duplicates', 1, 1, { Id: 'original-copy' });
  const watchedCopy = episodeItem('duplicates', 1, 1, {
    Id: 'watched-copy',
    UserData: { Played: true, PlayCount: 1, LastPlayedDate: '2026-05-06T12:00:00.000Z' }
  });
  const remaining = Array.from({ length: 6 }, (_, index) =>
    episodeItem('duplicates', 1, index + 2)
  );
  const representative = {
    ...remaining[0],
    score: 80,
    reason: 'more from a series you watch'
  };

  const [projected] = projectRecommendations(
    [representative],
    [original, watchedCopy, ...remaining],
    [{ Id: 'duplicates', Name: 'Duplicate show', Type: 'Series', RecursiveItemCount: 8 }]
  );

  assert.equal(projected.kind, 'show');
  if (projected.kind !== 'show') assert.fail('Expected tolerated duplicates to remain an ordered show.');
  assert.equal(projected.episodes.length, 7);
  assert.equal(projected.episodes[0].Id, 'watched-copy');
  assert.equal(projected.progress.kind, 'next');
  assert.equal(projected.progress.primaryItem?.IndexNumber, 2);
});

test('search ranks actual series episodes above unrelated title matches', () => {
  const homeland = item({
    Id: 'homeland',
    Name: 'Paean to the People',
    Type: 'Episode',
    SeriesName: 'Homeland',
    SeriesId: 'homeland-series',
    ParentIndexNumber: 7,
    IndexNumber: 12,
    PremiereDate: '2018-04-29T00:00:00.0000000Z'
  });
  const falsePositive = item({
    Id: 'das-boot',
    Name: 'In the Homeland',
    Type: 'Episode',
    SeriesName: 'Das Boot',
    SeriesId: 'das-boot',
    ParentIndexNumber: 2,
    IndexNumber: 4,
    PremiereDate: '2020-05-15T00:00:00.0000000Z'
  });

  assert.deepEqual(rankSearchResults([falsePositive, homeland], 'Homeland').map((result) => result.Id), [
    'homeland',
    'das-boot'
  ]);
});

test('channel names come from Jellyfin series and artist metadata where available', () => {
  assert.equal(
    channelName(
      item({
        Id: 'episode',
        Name: 'Paean to the People',
        Type: 'Episode',
        SeriesName: 'Homeland',
        SeriesId: 'homeland-series',
        ParentIndexNumber: 7,
        IndexNumber: 12
      })
    ),
    'Homeland'
  );
  assert.equal(
    channelName(
      item({
        Id: 'music',
        Name: 'Song Title',
        Type: 'MusicVideo',
        ArtistItems: [{ Name: 'The Artist' }]
      })
    ),
    'The Artist'
  );
  assert.equal(
    channelName(
      item({
        Id: 'music-title',
        Name: 'Wet Leg： Mangetout ｜ SNL UK [x3V9FUZ2ajk]',
        Type: 'MusicVideo'
      })
    ),
    'Wet Leg'
  );
  assert.equal(
    channelName(
      item({
        Id: 'video-title',
        Name: 'Conan Visits Intel Headquarters ｜ Late Night with Conan O’Brien [gXReifFHXbY]',
        Type: 'Video'
      })
    ),
    'Late Night with Conan O’Brien'
  );
  assert.equal(
    channelName(
      item({
        Id: 'movie',
        Name: 'The Movie',
        Type: 'Movie',
        contentKind: 'movie',
        sourceLibraryName: 'Movies'
      })
    ),
    'Movies'
  );
});

test('mixed date sorting still falls back to DateCreated when PremiereDate is absent', () => {
  const withPremiere = item({
    Id: 'premiere',
    Name: 'Premiere date',
    PremiereDate: '2024-01-01T00:00:00.000Z',
    DateCreated: '2020-01-01T00:00:00.000Z'
  });
  const createdOnly = item({
    Id: 'created',
    Name: 'Created only',
    DateCreated: '2025-01-01T00:00:00.000Z'
  });

  assert.deepEqual([withPremiere, createdOnly].sort(compareByContentDateDesc).map((entry) => entry.Id), [
    'created',
    'premiere'
  ]);
});

test('channel directory merges Jellyfin series with loaded channel groups without subscription state', () => {
  const saturdayNightLive = item({
    Id: 'snl-series',
    Name: 'Saturday Night Live',
    Type: 'Series',
    sourceLibraryName: 'Shows'
  });
  const saturdayNightLiveEpisode = item({
    Id: 'snl-new',
    Name: 'Cold Open',
    Type: 'Episode',
    SeriesName: 'Saturday Night Live',
    SeriesId: 'snl',
    PremiereDate: '2025-05-01T00:00:00.000Z'
  });
  const sabrina = item({
    Id: 'sabrina',
    Name: 'Sabrina Carpenter - Espresso',
    Type: 'MusicVideo',
    ArtistItems: [{ Name: 'Sabrina Carpenter' }],
    sourceLibraryName: 'Music Videos',
    PremiereDate: '2025-04-01T00:00:00.000Z'
  });

  const directory = channelDirectoryEntries([saturdayNightLiveEpisode, sabrina], [saturdayNightLive]);
  assert.deepEqual(directory.map((entry) => [entry.name, entry.kind, entry.itemCount]), [
    ['Saturday Night Live', 'show', 1],
    ['Sabrina Carpenter', 'music', 1]
  ]);
  assert.equal(directory[0].latestItem?.Id, 'snl-new');
  assert.equal(directory[0].seriesItem?.Id, 'snl-series');
});

test('channel directory filter matches show and source names', () => {
  const homeland = item({
    Id: 'homeland-series',
    Name: 'Homeland',
    Type: 'Series',
    sourceLibraryName: 'Shows'
  });
  const sabrina = item({
    Id: 'sabrina',
    Name: 'Sabrina Carpenter - Espresso',
    Type: 'MusicVideo',
    ArtistItems: [{ Name: 'Sabrina Carpenter' }],
    sourceLibraryName: 'Music Videos'
  });

  const directory = channelDirectoryEntries([sabrina], [homeland]);

  assert.deepEqual(filterChannelDirectory(directory, 'home').map((entry) => entry.name), ['Homeland']);
  assert.deepEqual(filterChannelDirectory(directory, 'music videos').map((entry) => entry.name), [
    'Sabrina Carpenter'
  ]);
});

test('cinematic glow sampling only runs for active visible playback', () => {
  const active = {
    enabled: true,
    playing: true,
    visible: true,
    readyState: 3,
    width: 1280,
    height: 720,
    blocked: false,
    buffering: false,
    loading: false
  };

  assert.equal(shouldSampleCinematicGlow(active), true);
  assert.equal(shouldSampleCinematicGlow({ ...active, enabled: false }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, playing: false }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, visible: false }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, readyState: 1 }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, width: 0 }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, blocked: true }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, buffering: true }), false);
  assert.equal(shouldSampleCinematicGlow({ ...active, loading: true }), false);
});

test('cinematic glow derives edge-biased colors from a frame', () => {
  const width = 8;
  const height = 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const x = (index / 4) % width;
    pixels[index] = x < 2 ? 220 : x >= 6 ? 15 : 35;
    pixels[index + 1] = x >= 2 && x < 6 ? 210 : 20;
    pixels[index + 2] = x >= 6 ? 230 : 25;
    pixels[index + 3] = 255;
  }

  const palette = cinematicPaletteFromImageData(pixels, width, height);
  assert.ok(palette.left.red > palette.left.blue);
  assert.ok(palette.right.blue > palette.right.red);
  assert.ok(palette.center.green > palette.center.red);

  const colors = cinematicColorsFromPalette(palette);
  assert.match(colors.left, /^rgba\(/);
  assert.match(colors.right, /^rgba\(/);
  assert.notEqual(colors.left, colors.right);
  assert.match(cinematicGlowStyle(colors), /--cinematic-left: rgba\(/);
});

test('cinematic glow bounds very dark and bright frames', () => {
  const blackFrame = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const whiteFrame = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);

  assert.match(cinematicColorsFromImageData(blackFrame, 2, 1).center, /rgba\(24, 24, 24, 0\.24\)/);
  assert.match(cinematicColorsFromImageData(whiteFrame, 2, 1).center, /rgba\(212, 212, 212, 0\.24\)/);
});

test('cinematic glow blends large color changes and skips tiny style updates', () => {
  const previous: CinematicGlowPalette = {
    left: { red: 20, green: 30, blue: 40, alpha: 0.2 },
    right: { red: 20, green: 30, blue: 40, alpha: 0.2 },
    center: { red: 20, green: 30, blue: 40, alpha: 0.1 },
    floor: { red: 20, green: 30, blue: 40, alpha: 0.2 }
  };
  const next: CinematicGlowPalette = {
    left: { red: 220, green: 30, blue: 40, alpha: 0.34 },
    right: { red: 20, green: 30, blue: 220, alpha: 0.34 },
    center: { red: 20, green: 210, blue: 40, alpha: 0.2 },
    floor: { red: 180, green: 120, blue: 40, alpha: 0.3 }
  };

  const blended = blendCinematicGlowPalette(previous, next, 0.25);
  assert.equal(blended.left.red, 70);
  assert.equal(blended.right.blue, 85);
  assert.equal(Math.round(blended.floor.alpha * 1000), 225);
  assert.equal(
    cinematicPalettesAreClose(previous, {
      ...previous,
      left: { ...previous.left, red: previous.left.red + 0.8, alpha: previous.left.alpha + 0.003 }
    }),
    true
  );
  assert.equal(cinematicPalettesAreClose(previous, blended), false);
});

test('show progress resumes the latest partially watched episode', () => {
  const episodes = [
    item({
      Id: 's01e01',
      Name: 'Show S01E01 - Pilot',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      RunTimeTicks: 1000,
      UserData: { Played: true, PlayedPercentage: 100 }
    }),
    item({
      Id: 's01e02',
      Name: 'Show S01E02 - Second',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 2,
      RunTimeTicks: 1000,
      UserData: {
        PlaybackPositionTicks: 450,
        LastPlayedDate: '2026-05-05T12:00:00.000Z'
      }
    }),
    item({
      Id: 's01e03',
      Name: 'Show S01E03 - Third',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 3
    })
  ];

  const progress = showProgressForEpisodes(episodes);
  assert.equal(progress.kind, 'resume');
  assert.equal(progress.primaryItem?.Id, 's01e02');
  assert.equal(progress.label, 'Resume S01E02');
  assert.equal(progress.watchedCount, 1);
});

test('show progress selects the next episode after the latest completed episode', () => {
  const episodes = [
    item({
      Id: 's01e01',
      Name: 'Show S01E01 - Pilot',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      UserData: { Played: true }
    }),
    item({
      Id: 's01e02',
      Name: 'Show S01E02 - Second',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 2,
      UserData: { Played: true }
    }),
    item({
      Id: 's01e03',
      Name: 'Show S01E03 - Third',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 3
    })
  ];

  const progress = showProgressForEpisodes(episodes);
  assert.equal(progress.kind, 'next');
  assert.equal(progress.primaryItem?.Id, 's01e03');
  assert.equal(progress.label, 'Next S01E03');
  assert.equal(progress.progressPercent, 67);
});

test('show progress starts at the first episode when there is no history', () => {
  const episodes = [
    item({
      Id: 's01e02',
      Name: 'Show S01E02 - Second',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 2
    }),
    item({
      Id: 's01e01',
      Name: 'Show S01E01 - Pilot',
      SeriesId: 'show',
      SeriesName: 'Show',
      ParentIndexNumber: 1,
      IndexNumber: 1
    })
  ];

  const progress = showProgressForEpisodes(episodes);
  assert.equal(progress.kind, 'start');
  assert.equal(progress.primaryItem?.Id, 's01e01');
  assert.equal(progress.label, 'Start S01E01');
});

test('playing next selects the next episode from the active season before the countdown appears', () => {
  const current = item({
    Id: 's01e02',
    Name: 'Show S01E02 - Second',
    SeriesId: 'show',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 2
  });
  const next = item({
    Id: 's01e03',
    Name: 'Show S01E03 - Third',
    SeriesId: 'show',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 3
  });

  assert.equal(episodePlayingNextItem(current, [current, next])?.Id, 's01e03');
  assert.equal(shouldShowPlayingNext({ currentTime: 1160, duration: 1200, nextItem: next, autoplayNext: true }), true);
  assert.equal(shouldShowPlayingNext({ currentTime: 1159, duration: 1200, nextItem: next, autoplayNext: true }), false);
  assert.equal(shouldShowPlayingNext({ currentTime: 1190, duration: 1200, nextItem: next, autoplayNext: true }), false);
  assert.equal(countdownSecondsRemaining(1160, 1200), 30);
  assert.equal(countdownSecondsRemaining(1170, 1200), 20);
  assert.equal(shouldAdvancePlayingNext({ currentTime: 1189, duration: 1200, nextItem: next, autoplayNext: true }), false);
  assert.equal(shouldAdvancePlayingNext({ currentTime: 1190, duration: 1200, nextItem: next, autoplayNext: true }), true);
});

test('playing next stays hidden without autoplay, without a next episode, or after the video ended', () => {
  const current = item({
    Id: 's01e01',
    Name: 'Show S01E01 - Pilot',
    SeriesId: 'show',
    SeriesName: 'Show',
    ParentIndexNumber: 1,
    IndexNumber: 1
  });

  assert.equal(episodePlayingNextItem(current, [current]), null);
  assert.equal(shouldShowPlayingNext({ currentTime: 1170, duration: 1200, nextItem: current, autoplayNext: false }), false);
  assert.equal(shouldShowPlayingNext({ currentTime: 1170, duration: 1200, nextItem: null, autoplayNext: true }), false);
  assert.equal(shouldShowPlayingNext({ currentTime: 1200, duration: 1200, nextItem: current, autoplayNext: true }), false);
  assert.equal(shouldAdvancePlayingNext({ currentTime: 1190, duration: 1200, nextItem: current, autoplayNext: false }), false);
  assert.equal(shouldAdvancePlayingNext({ currentTime: 1190, duration: 1200, nextItem: null, autoplayNext: true }), false);
  assert.equal(shouldAdvancePlayingNext({ currentTime: 1200, duration: 1200, nextItem: current, autoplayNext: true }), false);
});

test('series next up finds the server-selected episode for the show instead of the next old episode', () => {
  const oldEpisode = episodeItem('show', 1, 2);
  const serverNextUp = episodeItem('show', 3, 7);
  const anotherShow = episodeItem('other-show', 1, 4);

  assert.equal(seriesNextUpItem(oldEpisode, [anotherShow, oldEpisode, serverNextUp])?.Id, serverNextUp.Id);
  assert.equal(seriesNextUpItem(oldEpisode, [anotherShow, oldEpisode]), null);
});

test('search suggestions only fetch for supported routes and useful queries', () => {
  assert.equal(shouldFetchSearchSuggestions('a', 'home'), false);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'home'), true);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'search'), true);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'watch'), true);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'movies'), false);
});

test('search suggestion labels include series context for episodes only', () => {
  assert.equal(suggestionNameLabel({ id: 'e1', name: 'Pilot', type: 'Episode', seriesName: 'The Show', parentId: 'p1' }), 'The Show — Pilot');
  assert.equal(suggestionNameLabel({ id: 'm1', name: 'Pilot', type: 'Movie', seriesName: 'The Show', parentId: 'p1' }), 'Pilot');
});

test('search suggestion scheduler debounces stale queries and clears unsupported routes', async () => {
  const scheduler = createSearchSuggestionScheduler<string>();
  const requests: { query: string; aborted: boolean }[] = [];
  const results: string[][] = [];
  const clears: number[] = [];

  scheduler.schedule({
    query: 'ma',
    route: 'home',
    delayMs: 20,
    request: async (query, signal) => {
      requests.push({ query, aborted: signal.aborted });
      return [query];
    },
    onResults: (items) => results.push(items),
    onClear: () => clears.push(1)
  });

  scheduler.schedule({
    query: 'matrix',
    route: 'home',
    delayMs: 0,
    request: async (query, signal) => {
      requests.push({ query, aborted: signal.aborted });
      return [query];
    },
    onResults: (items) => results.push(items),
    onClear: () => clears.push(1)
  });

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(requests, [{ query: 'matrix', aborted: false }]);
  assert.deepEqual(results, [['matrix']]);
  assert.deepEqual(clears, []);

  scheduler.schedule({
    query: 'matrix',
    route: 'movies',
    delayMs: 0,
    request: async () => ['never'],
    onResults: (items) => results.push(items),
    onClear: () => clears.push(1)
  });

  assert.deepEqual(clears, [1]);
});

test('detectDirectPlayCodecs reflects what the browser can decode', () => {
  const modern = {
    canPlayType: (mime: string) => (/av01|avc1|vp09|vp9|vp8|hvc1|hev1/.test(mime) ? 'probably' : '')
  };
  const legacy = {
    canPlayType: (mime: string) =>
      /avc1|vp09|vp9|vp8/.test(mime) && !/av01|hvc1|hev1/.test(mime) ? 'probably' : ''
  };

  assert.deepEqual(detectDirectPlayCodecs(modern), {
    h264: true,
    hevc: true,
    vp8: true,
    vp9: true,
    av1: true
  });
  assert.deepEqual(detectDirectPlayCodecs(legacy), {
    h264: true,
    hevc: false,
    vp8: true,
    vp9: true,
    av1: false
  });
});

test('device profile advertises av1/hevc direct play only when the browser supports them', () => {
  const modernCodecs = { h264: true, hevc: true, vp8: true, vp9: true, av1: true };
  const legacyCodecs = { h264: true, hevc: false, vp8: true, vp9: true, av1: false };

  const modernVideoCodecs = browserDeviceProfile(140_000_000, modernCodecs)
    .DirectPlayProfiles.map((profile) => profile.VideoCodec)
    .join('|');
  assert.ok(modernVideoCodecs.includes('av1'), 'av1 should be advertised for a capable browser');
  assert.ok(modernVideoCodecs.includes('hevc'), 'hevc should be advertised for a capable browser');

  const legacyProfile = browserDeviceProfile(140_000_000, legacyCodecs);
  const legacyVideoCodecs = legacyProfile.DirectPlayProfiles.map((profile) => profile.VideoCodec).join('|');
  assert.ok(!legacyVideoCodecs.includes('av1'), 'av1 must not be advertised without decode support');
  assert.ok(!legacyVideoCodecs.includes('hevc'), 'hevc must not be advertised without decode support');
  // Transcoding stays available as the fallback for anything not direct-playable.
  assert.ok(legacyProfile.TranscodingProfiles.length > 0);
});

test('canDirectPlaySource direct-plays av1 only on browsers that decode it', () => {
  const av1Webm = {
    Id: 'source',
    Container: 'webm',
    SupportsDirectPlay: true,
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      { Type: 'Video' as const, Codec: 'av1' },
      { Type: 'Audio' as const, Codec: 'opus', Index: 1 }
    ]
  };
  const av1Capable = { canPlayType: (mime: string) => (mime.includes('av01') ? 'probably' : '') };
  const av1Incapable = {
    canPlayType: (mime: string) => (mime.includes('webm') && !mime.includes('av01') ? 'probably' : '')
  };

  assert.equal(canDirectPlaySource(av1Webm, av1Capable), true);
  assert.equal(canDirectPlaySource(av1Webm, av1Incapable), false);
  // A source Jellyfin already refused for direct play is never forced.
  assert.equal(canDirectPlaySource({ ...av1Webm, SupportsDirectPlay: false }, av1Capable), false);
});

test('media capabilities query describes the exact demanding av1 stream', () => {
  assert.deepEqual(mediaCapabilitiesVideoConfiguration(performanceSensitiveAv1Source()), {
    type: 'file',
    video: {
      contentType: 'video/mp4; codecs="av01.0.12M.08"',
      width: 3596,
      height: 2160,
      bitrate: 12_491_673,
      framerate: 24
    }
  });
});

test('Auto avoids demanding direct play when decoding is not power efficient', async () => {
  let queriedContentType = '';
  const preferDirect = await shouldPreferDirectPlayForAuto(performanceSensitiveAv1Source(), {
    async decodingInfo(configuration) {
      queriedContentType = configuration.video.contentType;
      return { supported: true, smooth: true, powerEfficient: false };
    }
  });

  assert.equal(queriedContentType, 'video/mp4; codecs="av01.0.12M.08"');
  assert.equal(preferDirect, false);
});

test('Auto keeps demanding direct play when the browser confirms efficient decoding', async () => {
  const preferDirect = await shouldPreferDirectPlayForAuto(performanceSensitiveAv1Source(), {
    async decodingInfo() {
      return { supported: true, smooth: true, powerEfficient: true };
    }
  });

  assert.equal(preferDirect, true);
});

test('Auto conservatively transcodes demanding av1 without Media Capabilities support', async () => {
  assert.equal(await shouldPreferDirectPlayForAuto(performanceSensitiveAv1Source(), null), false);

  const ordinaryAv1: JellyfinMediaSource = {
    ...performanceSensitiveAv1Source(),
    Bitrate: 5_000_000,
    MediaStreams: [
      {
        Type: 'Video',
        Codec: 'av1',
        Width: 1920,
        Height: 1080,
        BitRate: 4_800_000,
        AverageFrameRate: 24
      },
      { Type: 'Audio', Codec: 'opus', Index: 1 }
    ]
  };
  assert.equal(await shouldPreferDirectPlayForAuto(ordinaryAv1, null), true);
});

test('actor extraction keeps valid cast in server order and deduplicates people', () => {
  const lead = { Id: 'actor-1', Name: 'Avery Example', Type: 'Actor', Role: 'Lead' };
  assert.deepEqual(
    actorsForItem(item({
      Id: 'movie',
      Name: 'Movie',
      Type: 'Movie',
      People: [
        lead,
        { Id: 'director-1', Name: 'Drew Director', Type: 'Director' },
        { ...lead, Role: 'Duplicate credit' },
        { Id: 'actor-2', Name: '', Type: 'Actor' },
        { Name: 'Missing identifier', Type: 'Actor' },
        { Id: 'actor-3', Name: 'Morgan Guest', Type: 'Actor' }
      ]
    })),
    [lead, { Id: 'actor-3', Name: 'Morgan Guest', Type: 'Actor' }]
  );
  assert.deepEqual(actorsForItem(item({ Id: 'empty', Name: 'Empty' })), []);
});

test('Jellyfin discovery requests keep detail fields isolated and tokens out of query strings', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const requests: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => 'test-device',
      setItem: () => undefined
    }
  });
  globalThis.fetch = async (input) => {
    requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify({ Items: [], TotalRecordCount: 0, Id: 'item', Name: 'Item', Type: 'Movie' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const client = new JellyfinClient('http://jellyfin.test', 'access-token', 'user-1');
    await client.getItems({
      parentId: 'library-1',
      itemTypes: 'Movie,Series,Episode',
      personIds: 'person-1',
      limit: 240,
      sortBy: 'PremiereDate',
      sortOrder: 'Descending'
    });
    await client.getItems({ parentId: 'library-1' });
    await client.getItem('movie-1');
    await client.getSimilarItems('movie-1', 36);
    await client.getNextUp({ parentId: 'shows-1', seriesId: 'series-1', limit: 18 });

    const actorWorkUrl = new URL(requests[0]);
    assert.equal(actorWorkUrl.searchParams.get('ParentId'), 'library-1');
    assert.equal(actorWorkUrl.searchParams.get('Recursive'), 'true');
    assert.equal(actorWorkUrl.searchParams.get('IncludeItemTypes'), 'Movie,Series,Episode');
    assert.equal(actorWorkUrl.searchParams.get('PersonIds'), 'person-1');
    assert.equal(actorWorkUrl.searchParams.get('Limit'), '240');
    assert.equal(actorWorkUrl.searchParams.get('SortBy'), 'PremiereDate');
    assert.ok(!actorWorkUrl.searchParams.get('Fields')?.split(',').includes('People'));

    const normalListUrl = new URL(requests[1]);
    assert.equal(normalListUrl.searchParams.has('PersonIds'), false);
    assert.ok(!normalListUrl.searchParams.get('Fields')?.split(',').includes('People'));

    const detailUrl = new URL(requests[2]);
    assert.equal(detailUrl.pathname, '/Users/user-1/Items/movie-1');
    assert.ok(detailUrl.searchParams.get('Fields')?.split(',').includes('People'));
    assert.ok(detailUrl.searchParams.get('Fields')?.split(',').includes('MediaSources'));

    const similarUrl = new URL(requests[3]);
    assert.equal(similarUrl.pathname, '/Items/movie-1/Similar');
    assert.equal(similarUrl.searchParams.get('userId'), 'user-1');
    assert.equal(similarUrl.searchParams.get('Limit'), '36');
    assert.ok(!similarUrl.searchParams.get('Fields')?.split(',').includes('People'));
    assert.equal(similarUrl.searchParams.has('api_key'), false);

    const nextUpUrl = new URL(requests[4]);
    assert.equal(nextUpUrl.pathname, '/Shows/NextUp');
    assert.equal(nextUpUrl.searchParams.get('userId'), 'user-1');
    assert.equal(nextUpUrl.searchParams.get('parentId'), 'shows-1');
    assert.equal(nextUpUrl.searchParams.get('seriesId'), 'series-1');
    assert.equal(nextUpUrl.searchParams.get('Limit'), '18');
    assert.equal(nextUpUrl.searchParams.get('EnableResumable'), 'true');
    assert.equal(nextUpUrl.searchParams.get('EnableRewatching'), 'false');
    assert.equal(nextUpUrl.searchParams.get('EnableTotalRecordCount'), 'false');
    assert.equal(nextUpUrl.searchParams.has('api_key'), false);

    assert.equal(client.getPersonImageUrl({ Id: 'person-1', Name: 'No image' }), '');
    assert.equal(client.getPersonImageUrl({ Name: 'No id', PrimaryImageTag: 'tag' }), '');
    const imageUrl = new URL(client.getPersonImageUrl({ Id: 'person-1', PrimaryImageTag: 'tag' }, 320));
    assert.equal(imageUrl.pathname, '/Items/person-1/Images/Primary');
    assert.equal(imageUrl.searchParams.get('fillWidth'), '320');
    assert.equal(imageUrl.searchParams.get('quality'), '90');
    assert.equal(imageUrl.searchParams.get('api_key'), 'access-token');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
});

test('Jellyfin playback requests carry selected audio indexes through negotiation and HLS', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => 'test-device',
      setItem: () => undefined
    }
  });
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    });
    return new Response(JSON.stringify({ MediaSources: [], PlaySessionId: 'session' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const client = new JellyfinClient('http://jellyfin.test', 'access-token', 'user-1');
    await client.getPlaybackInfo('video-1', 50_000_000, 2);
    await client.getPlaybackInfo('video-1', 0, -1);

    assert.equal(requests[0].body.AudioStreamIndex, 2);
    assert.equal('AudioStreamIndex' in requests[1].body, false);

    const selectedUrl = new URL(client.getHlsUrl('video-1', 'source-1', { audioStreamIndex: 2 }));
    const defaultUrl = new URL(client.getHlsUrl('video-1', 'source-1'));
    assert.equal(selectedUrl.searchParams.get('AudioStreamIndex'), '2');
    assert.equal(defaultUrl.searchParams.has('AudioStreamIndex'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
});
