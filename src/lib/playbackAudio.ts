import { normalizeServerUrl } from './jellyfin';
import type { JellyfinMediaSource, JellyfinMediaStream } from './types';

export type PlaybackAudioOption = {
  id: string;
  label: string;
  detail: string;
  stream: JellyfinMediaStream;
  index: number;
};

type PlaybackAudioPreference = {
  language?: string;
  title?: string;
};

export function playbackAudioOptions(source: JellyfinMediaSource) {
  const options: PlaybackAudioOption[] = [];
  const indexes = new Set<number>();
  for (const stream of source.MediaStreams ?? []) {
    if (stream.Type !== 'Audio' || !Number.isInteger(stream.Index) || (stream.Index ?? -1) < 0) continue;
    const index = stream.Index as number;
    if (indexes.has(index)) continue;
    indexes.add(index);
    options.push({
      id: `audio-${index}`,
      label: audioLabel(stream, index),
      detail: audioDetail(stream),
      stream,
      index
    });
  }
  return options;
}

export function containerDefaultAudioStream(source: JellyfinMediaSource) {
  let firstAudio: JellyfinMediaStream | undefined;
  for (const stream of source.MediaStreams ?? []) {
    if (stream.Type !== 'Audio' || !Number.isInteger(stream.Index) || (stream.Index ?? -1) < 0) continue;
    firstAudio ??= stream;
    if (stream.IsDefault) return stream;
  }
  return firstAudio;
}

export function playbackAudioById(
  options: PlaybackAudioOption[],
  audioId: string | null | undefined
) {
  return options.find((option) => option.id === audioId) ?? options[0];
}

export function initialPlaybackAudioId(
  source: JellyfinMediaSource,
  options: PlaybackAudioOption[],
  rawPreference: string | null | undefined
) {
  const preference = parsePreference(rawPreference);
  if (preference) {
    const languageMatches = preference.language
      ? options.filter((option) => normalizedLanguage(option.stream.Language) === preference.language)
      : [];

    if (preference.language && preference.title) {
      const exactMatch = languageMatches.find((option) =>
        normalizedTitle(preferenceTitle(option.stream)) === preference.title
      );
      if (exactMatch) return exactMatch.id;
    }

    if (languageMatches.length) {
      return preferredOption(source, languageMatches)?.id;
    }

    if (preference.title) {
      const titleMatch = options.find((option) =>
        normalizedTitle(preferenceTitle(option.stream)) === preference.title
      );
      if (titleMatch) return titleMatch.id;
    }
  }

  return preferredOption(source, options)?.id;
}

export function serializePlaybackAudioPreference(option: PlaybackAudioOption) {
  const preference: PlaybackAudioPreference = {};
  const language = normalizedLanguage(option.stream.Language);
  const title = preferenceTitle(option.stream);
  if (language) preference.language = language;
  if (title) preference.title = title;
  return JSON.stringify(preference);
}

export function playbackAudioPreferenceKey(serverUrl: string, userId: string) {
  return `jellytube.playbackAudioPreference.${normalizeServerUrl(serverUrl)}.${userId}`;
}

function preferredOption(source: JellyfinMediaSource, options: PlaybackAudioOption[]) {
  return options.find((option) => option.index === source.DefaultAudioStreamIndex)
    ?? options.find((option) => option.stream.IsDefault)
    ?? options[0];
}

function parsePreference(rawPreference: string | null | undefined): PlaybackAudioPreference | undefined {
  if (!rawPreference) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawPreference);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const language = typeof record.language === 'string' ? normalizedLanguage(record.language) : '';
    const title = typeof record.title === 'string' ? normalizedTitle(record.title) : '';
    if (!language && !title) return undefined;
    return {
      ...(language ? { language } : {}),
      ...(title ? { title } : {})
    };
  } catch {
    return undefined;
  }
}

function normalizedLanguage(language: string | undefined) {
  return language?.trim().toLowerCase() ?? '';
}

function preferenceTitle(stream: JellyfinMediaStream) {
  return stream.Title?.trim() || stream.DisplayTitle?.trim() || '';
}

function normalizedTitle(title: string | undefined) {
  return title?.trim().toLocaleLowerCase() ?? '';
}

function audioLabel(stream: JellyfinMediaStream, index: number) {
  return stream.DisplayTitle?.trim()
    || stream.Title?.trim()
    || normalizedLanguage(stream.Language).toUpperCase()
    || `Audio ${index}`;
}

function audioDetail(stream: JellyfinMediaStream) {
  const parts = [
    normalizedLanguage(stream.Language).toUpperCase(),
    stream.IsDefault ? 'Default' : '',
    stream.Codec?.trim().toUpperCase() ?? ''
  ].filter(Boolean);
  return [...new Set(parts)].join(' · ');
}
