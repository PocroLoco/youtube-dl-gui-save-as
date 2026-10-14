import { TrackType } from './media.ts';

export interface PathPreferences {
  audioDownloadDir: string | null;
  videoDownloadDir: string | null;
  videoDirectoryTemplate: string | null;
  audioDirectoryTemplate: string | null;
  askDownloadLocation: boolean;
}

export const defaultPathPreferences: PathPreferences = {
  audioDownloadDir: null,
  videoDownloadDir: null,
  videoDirectoryTemplate: null,
  audioDirectoryTemplate: null,
  askDownloadLocation: false,
};

export interface RecentPreferences {
  recent: Record<string, string[]>;
}

export const defaultRecentPreferences: RecentPreferences = {
  recent: {},
};

export interface FormatPreferences {
  trackType: TrackType;
}

export const defaultFormatPreferences: FormatPreferences = {
  trackType: TrackType.both,
};

export interface Preferences {
  paths: PathPreferences;
  recents: RecentPreferences;
  formats: FormatPreferences;
}

export const defaultPreferences: Preferences = {
  paths: defaultPathPreferences,
  recents: defaultRecentPreferences,
  formats: defaultFormatPreferences,
};
