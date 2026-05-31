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
import {
  channelName,
  compactMeta,
  continueWatching,
  displayTitle,
  groupByChannel,
  rankRecommendations,
  shouldStartFromBeginning
} from '../src/lib/recommendations';
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
import { rankSearchResults } from '../src/lib/search';
import { showProgressForEpisodes } from '../src/lib/showProgress';
import {
  countdownSecondsRemaining,
  episodePlayingNextItem,
  shouldShowPlayingNext
} from '../src/lib/playingNext';
import {
  createSearchSuggestionScheduler,
  shouldFetchSearchSuggestions,
  suggestionNameLabel
} from '../src/lib/searchSuggestions';
import type { JellyfinItem } from '../src/lib/types';

function item(overrides: Partial<JellyfinItem> & Pick<JellyfinItem, 'Id' | 'Name'>): JellyfinItem {
  return {
    Type: 'Video',
    ...overrides
  };
}

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
  assert.equal(shouldShowPlayingNext({ currentTime: 1170, duration: 1200, nextItem: next, autoplayNext: true }), true);
  assert.equal(shouldShowPlayingNext({ currentTime: 1080, duration: 1200, nextItem: next, autoplayNext: true }), false);
  assert.equal(countdownSecondsRemaining(1170, 1200), 30);
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
});

test('search suggestions only fetch for supported routes and useful queries', () => {
  assert.equal(shouldFetchSearchSuggestions('a', 'home'), false);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'watch'), false);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'home'), true);
  assert.equal(shouldFetchSearchSuggestions('matrix', 'search'), true);
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
    route: 'watch',
    delayMs: 0,
    request: async () => ['never'],
    onResults: (items) => results.push(items),
    onClear: () => clears.push(1)
  });

  assert.deepEqual(clears, [1]);
});
