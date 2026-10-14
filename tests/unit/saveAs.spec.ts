import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockWindows } from '@tauri-apps/api/mocks';
import { installTauriMock } from '../utils/tauriMock.ts';
import { useMediaStore } from '../../src/stores/media/media';
import { SAVE_AS_RECENTS_KEY } from '../../src/stores/media/saveAs';
import { useMediaGroupStore } from '../../src/stores/media/group';
import { useMediaOptionsStore } from '../../src/stores/media/options';
import { useMediaStateStore, MediaState } from '../../src/stores/media/state';
import { useSettingsStore } from '../../src/stores/settings';
import { usePreferencesStore } from '../../src/stores/preferences';
import { defaultSettings } from '../../src/tauri/types/config';
import { AudioFormat, TrackType, VideoContainer, type DownloadOptions, type SaveAsChoice } from '../../src/tauri/types/media';
import type { Group } from '../../src/tauri/types/group';

const { notify, notifyGroup } = vi.hoisted(() => ({
  notify: vi.fn(),
  notifyGroup: vi.fn(),
}));

vi.mock('../../src/tauri/notifications', () => ({
  notify,
  notifyGroup,
}));

type DialogCall = {
  cmd: string;
  options: {
    title?: string;
    directory?: boolean;
    defaultPath?: string;
    canCreateDirectories?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  };
};

type DownloadCall = {
  groupId: string;
  items: Array<{ id: string; overrides?: { output?: { saveAs?: SaveAsChoice } } }>;
};

type Answer = string | null | Promise<string | null>;

const videoOptions: DownloadOptions = { trackType: TrackType.both };

const baseGroup = {
  processed: 1,
  errored: 0,
  audioCodecs: [],
  videoCodecs: [],
  audioTracks: [],
  videoTracks: [],
  formats: [],
  filesize: 0,
};

function videoGroup(groupId: string, title: string): Group {
  return {
    ...baseGroup,
    id: groupId,
    url: `https://example.com/${groupId}`,
    title,
    total: 1,
    isCombined: false,
    items: {
      [`${groupId}-item`]: {
        id: `${groupId}-item`,
        isLeader: true,
        url: `https://example.com/${groupId}`,
        title,
        audioCodecs: [],
        formats: [],
        filesize: 0,
      },
    },
  };
}

function playlistGroup(groupId: string): Group {
  const item = (n: number) => ({
    id: `${groupId}-${n}`,
    url: `https://example.com/v${n}`,
    title: `Video ${n}`,
    audioCodecs: [],
    formats: [],
    filesize: 0,
  });
  return {
    ...baseGroup,
    id: groupId,
    url: 'https://example.com/playlist',
    title: 'My Playlist',
    total: 2,
    isCombined: true,
    items: {
      [`${groupId}-leader`]: {
        id: `${groupId}-leader`,
        isLeader: true,
        url: 'https://example.com/playlist',
        title: 'My Playlist',
        audioCodecs: [],
        formats: [],
        filesize: 0,
        entries: [],
      },
      [`${groupId}-1`]: item(1),
      [`${groupId}-2`]: item(2),
    },
  };
}

function setup(answers: Answer[]) {
  const dialogs: DialogCall[] = [];
  const downloads: DownloadCall[] = [];
  const answer = (cmd: string, args: unknown) => {
    dialogs.push({ cmd, ...(args as { options: DialogCall['options'] }) });
    return answers.shift() ?? null;
  };
  mockWindows('main');
  installTauriMock({
    'plugin:dialog|save': answer,
    'plugin:dialog|open': answer,
    'media_download': (_cmd, args) => {
      downloads.push(args as unknown as DownloadCall);
      return 'ok';
    },
    'preferences_set': () => preferencesStore.preferences,
  });

  const settingsStore = useSettingsStore();
  Object.assign(settingsStore.settings, structuredClone(defaultSettings));
  settingsStore.settings.output.downloadDir = '/Users/me/Downloads';
  settingsStore.settings.output.video.container = VideoContainer.mp4;

  const preferencesStore = usePreferencesStore();
  // The store's defaults are a shared object, so reset what other tests touched.
  preferencesStore.preferences.paths.askDownloadLocation = true;
  preferencesStore.preferences.recents.recent = {};

  const groupStore = useMediaGroupStore();
  const stateStore = useMediaStateStore();
  const optionsStore = useMediaOptionsStore();
  const mediaStore = useMediaStore();

  const addGroup = (group: Group, options = videoOptions) => {
    groupStore.createGroup(group);
    stateStore.setGroupState(group.id, MediaState.configure);
    optionsStore.setOptions(group.id, options);
  };

  return { dialogs, downloads, preferencesStore, stateStore, mediaStore, addGroup };
}

const saveAsOf = (call: DownloadCall | undefined) => call?.items[0]?.overrides?.output?.saveAs;

describe('save as before download', () => {
  beforeEach(() => {
    notify.mockReset();
    notifyGroup.mockReset();
  });

  it('downloads like before when the setting is off', async () => {
    const { dialogs, downloads, preferencesStore, mediaStore, addGroup } = setup([]);
    preferencesStore.preferences.paths.askDownloadLocation = false;
    addGroup(videoGroup('g1', 'Beach Day'));

    await mediaStore.downloadGroup('g1', videoOptions);

    expect(dialogs).toHaveLength(0);
    expect(downloads).toHaveLength(1);
    expect(saveAsOf(downloads[0])).toBeUndefined();
  });

  it('asks with a Save As window first, then downloads straight to the picked file', async () => {
    const { dialogs, downloads, mediaStore, addGroup } = setup(['/Users/me/Movies/Summer/Beach 2026.mp4']);
    addGroup(videoGroup('g1', 'Beach Day'));

    await mediaStore.downloadGroup('g1', videoOptions);

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].cmd).toBe('plugin:dialog|save');
    expect(dialogs[0].options.defaultPath).toBe('/Users/me/Downloads/Beach Day.mp4');
    expect(dialogs[0].options.canCreateDirectories).toBe(true);
    expect(dialogs[0].options.filters).toEqual([{ name: 'MP4', extensions: ['mp4'] }]);
    expect(downloads).toHaveLength(1);
    expect(saveAsOf(downloads[0])).toEqual({ filePath: '/Users/me/Movies/Summer/Beach 2026.mp4' });
  });

  it('downloads nothing when Save As is cancelled', async () => {
    const { dialogs, downloads, stateStore, mediaStore, addGroup } = setup([null]);
    addGroup(videoGroup('g1', 'Beach Day'));

    await mediaStore.downloadGroup('g1', videoOptions);

    expect(dialogs).toHaveLength(1);
    expect(downloads).toHaveLength(0);
    expect(stateStore.getGroupState('g1')).toBe(MediaState.configure);
  });

  it('resumes into the same file without asking again', async () => {
    const { dialogs, downloads, stateStore, mediaStore, addGroup } = setup(['/Users/me/Movies/clip.mp4']);
    addGroup(videoGroup('g1', 'Beach Day'));

    await mediaStore.downloadGroup('g1', videoOptions);
    stateStore.setGroupState('g1', MediaState.paused);
    await mediaStore.downloadGroup('g1', videoOptions);

    expect(dialogs).toHaveLength(1);
    expect(downloads).toHaveLength(2);
    expect(saveAsOf(downloads[1])).toEqual({ filePath: '/Users/me/Movies/clip.mp4' });
  });

  it('asks for each video of "Download all" one window at a time', async () => {
    let answerFirst: (value: string | null) => void = () => {};
    const first = new Promise<string | null>((resolve) => {
      answerFirst = resolve;
    });
    const { dialogs, downloads, mediaStore, addGroup } = setup([first, '/Users/me/Movies/two.mp4']);
    addGroup(videoGroup('g1', 'One'));
    addGroup(videoGroup('g2', 'Two'));

    const all = mediaStore.downloadAllGroups();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(dialogs).toHaveLength(1);

    answerFirst('/Users/me/Movies/one.mp4');
    await all;

    expect(dialogs).toHaveLength(2);
    // The second window opens in the folder picked in the first one.
    expect(dialogs[1].options.defaultPath).toMatch(/^\/Users\/me\/Movies\/(One|Two)\.mp4$/);
    expect(downloads.map(saveAsOf)).toEqual(expect.arrayContaining([
      { filePath: '/Users/me/Movies/one.mp4' },
      { filePath: '/Users/me/Movies/two.mp4' },
    ]));
  });

  it('asks for a folder when a download produces several files', async () => {
    const { dialogs, downloads, preferencesStore, mediaStore, addGroup } = setup(['/Volumes/External/Playlists']);
    addGroup(playlistGroup('p1'));

    await mediaStore.downloadGroup('p1', videoOptions);

    expect(dialogs[0].cmd).toBe('plugin:dialog|open');
    expect(dialogs[0].options.directory).toBe(true);
    expect(saveAsOf(downloads[0])).toEqual({ dir: '/Volumes/External/Playlists' });
    expect(preferencesStore.getRecentPaths(SAVE_AS_RECENTS_KEY)[0]).toBe('/Volumes/External/Playlists');
  });

  it('suggests the audio format as the extension for audio downloads', async () => {
    const { dialogs, addGroup, mediaStore } = setup([null]);
    const settingsStore = useSettingsStore();
    settingsStore.settings.output.audio.format = AudioFormat.mp3;
    const audioOptions = { trackType: TrackType.audio };
    addGroup(videoGroup('g1', 'Song'), audioOptions);

    await mediaStore.downloadGroup('g1', audioOptions);

    expect(dialogs[0].options.defaultPath).toBe('/Users/me/Downloads/Song.mp3');
    expect(dialogs[0].options.filters).toEqual([{ name: 'MP3', extensions: ['mp3'] }]);
  });

  it('removes characters that are not allowed in file names', async () => {
    const { dialogs, addGroup, mediaStore } = setup([null]);
    addGroup(videoGroup('g1', 'AC/DC: Live? "1991"'));

    await mediaStore.downloadGroup('g1', videoOptions);

    expect(dialogs[0].options.defaultPath).toBe('/Users/me/Downloads/AC DC Live 1991.mp4');
  });
});
