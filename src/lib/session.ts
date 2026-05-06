import { contentKindForCollection, itemTypesForCollection } from './jellyfin';
import type { AppSession, SelectedLibrary } from './types';

const SESSION_KEY = 'jellytube.session.v1';

export function loadSession(): AppSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppSession>;
    if (
      !parsed.serverUrl ||
      !parsed.accessToken ||
      !parsed.userId
    ) {
      return null;
    }
    const selectedLibraries =
      Array.isArray(parsed.selectedLibraries) && parsed.selectedLibraries.length > 0
        ? (parsed.selectedLibraries as SelectedLibrary[])
        : legacySelectedLibrary(parsed);
    if (selectedLibraries.length === 0) return null;

    return {
      ...(parsed as AppSession),
      selectedLibraries,
      themeMode: parsed.themeMode ?? 'system'
    };
  } catch {
    return null;
  }
}

export function saveSession(session: AppSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function legacySelectedLibrary(parsed: Partial<AppSession>): SelectedLibrary[] {
  if (!parsed.selectedLibraryId || !parsed.selectedLibraryName) return [];
  const collectionType = parsed.selectedLibraryType ?? 'homevideos';
  const contentKind = contentKindForCollection(collectionType);
  if (!contentKind) return [];
  return [
    {
      id: parsed.selectedLibraryId,
      name: parsed.selectedLibraryName,
      collectionType,
      contentKind,
      itemTypes: itemTypesForCollection(collectionType)
    }
  ];
}
