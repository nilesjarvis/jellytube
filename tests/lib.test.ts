import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelDirectoryEntries,
  filterChannelDirectory
} from '../src/lib/channelDirectory';
import { compareByContentDateDesc, contentDate, relativeDate } from '../src/lib/dates';
import { episodeCollectionForItem } from '../src/lib/episodes';
import { channelName, compactMeta, displayTitle, groupByChannel } from '../src/lib/recommendations';
import { rankSearchResults } from '../src/lib/search';
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
