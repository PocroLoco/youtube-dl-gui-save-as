import { describe, expect, it } from 'vitest';
import { mockWindows } from '@tauri-apps/api/mocks';
import { installTauriMock } from '../utils/tauriMock.ts';
import { useBridgeStore } from '../../src/stores/bridge';
import { useMediaStore } from '../../src/stores/media/media';
import { useMediaGroupStore } from '../../src/stores/media/group';
import { useMediaStateStore, MediaState } from '../../src/stores/media/state';
import { useMediaProgressStore } from '../../src/stores/media/progress';
import { useMediaDestinationStore } from '../../src/stores/media/destination';
import { useSettingsStore } from '../../src/stores/settings';
import { usePreferencesStore } from '../../src/stores/preferences';
import { defaultSettings } from '../../src/tauri/types/config';
import { AudioFormat, TrackType, VideoContainer, type SaveAsChoice } from '../../src/tauri/types/media';
import { ProgressCategory, ProgressStage } from '../../src/tauri/types/progress';
import type { BridgeRequest } from '../../src/tauri/types/bridge';

type DialogCall = { cmd: string; options: { defaultPath?: string; filters?: Array<{ extensions: string[] }> } };
type DownloadCall = {
  groupId: string;
  items: Array<{ format: { trackType: TrackType }; overrides?: { output?: { saveAs?: SaveAsChoice } } }>;
};

function setup(answers: Array<string | null>, { askSetting = false } = {}) {
  const dialogs: DialogCall[] = [];
  const downloads: DownloadCall[] = [];
  const stepBacks: Array<{ hideWindow: boolean }> = [];
  const notifications: unknown[] = [];
  const answer = (cmd: string, args: unknown) => {
    dialogs.push({ cmd, ...(args as { options: DialogCall['options'] }) });
    return answers.shift() ?? null;
  };

  const mediaStore = useMediaStore();
  mockWindows('main');
  installTauriMock({
    'plugin:dialog|save': answer,
    'plugin:dialog|open': answer,
    // Pretend yt-dlp read the link and found one video.
    'media_info': (_cmd, args) => {
      const { url, id, groupId } = args as { url: string; id: string; groupId: string };
      setTimeout(() => {
        mediaStore.processMediaAddPayload({
          groupId,
          total: 1,
          item: {
            id,
            url,
            title: 'Cats: The Movie',
            thumbnail: 'https://i.ytimg.com/cat.jpg',
            audioCodecs: [],
            formats: [],
            filesize: 0,
          },
        });
      }, 0);
      return null;
    },
    'media_download': (_cmd, args) => {
      downloads.push(args as unknown as DownloadCall);
      return 'ok';
    },
    'bridge_step_back': (_cmd, args) => {
      stepBacks.push(args as { hideWindow: boolean });
      return null;
    },
    'notify': (_cmd, args) => {
      notifications.push(args);
      return null;
    },
    'preferences_set': () => preferencesStore.preferences,
  });

  const settingsStore = useSettingsStore();
  Object.assign(settingsStore.settings, structuredClone(defaultSettings));
  settingsStore.settings.output.downloadDir = '/Users/me/Downloads';
  settingsStore.settings.output.video.container = VideoContainer.mp4;
  settingsStore.settings.output.audio.format = AudioFormat.mp3;

  const preferencesStore = usePreferencesStore();
  preferencesStore.preferences.paths.askDownloadLocation = askSetting;
  preferencesStore.preferences.recents.recent = {};

  return {
    dialogs,
    downloads,
    stepBacks,
    notifications,
    mediaStore,
    bridgeStore: useBridgeStore(),
    groupStore: useMediaGroupStore(),
    stateStore: useMediaStateStore(),
  };
}

function request(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return {
    requestId: 'req-1',
    url: 'https://www.youtube.com/watch?v=cat',
    audioOnly: false,
    windowWasVisible: false,
    windowWasFocused: false,
    ...overrides,
  };
}

describe('downloads from the browser', () => {
  it('always asks "Save as" first, even with the setting off, then downloads straight there', async () => {
    const { dialogs, downloads, notifications, bridgeStore } = setup(['/Users/me/Movies/cats.mp4']);

    await bridgeStore.handleRequest(request());

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].cmd).toBe('plugin:dialog|save');
    expect(dialogs[0].options.defaultPath).toBe('/Users/me/Downloads/Cats The Movie.mp4');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].items[0].overrides?.output?.saveAs).toEqual({ filePath: '/Users/me/Movies/cats.mp4' });
    // The extension shows its own notifications, so the app stays quiet.
    expect(notifications).toHaveLength(0);
  });

  it('goes back to the browser after Save As when the app was in the background', async () => {
    const hidden = setup(['/Users/me/a.mp4']);
    await hidden.bridgeStore.handleRequest(request({ requestId: 'r-hidden' }));
    expect(hidden.stepBacks).toEqual([{ hideWindow: true }]);

    const behind = setup(['/Users/me/b.mp4']);
    await behind.bridgeStore.handleRequest(request({ requestId: 'r-behind', windowWasVisible: true }));
    expect(behind.stepBacks).toEqual([{ hideWindow: false }]);

    const inFront = setup(['/Users/me/c.mp4']);
    await inFront.bridgeStore.handleRequest(
      request({ requestId: 'r-front', windowWasVisible: true, windowWasFocused: true }),
    );
    expect(inFront.stepBacks).toEqual([]);
  });

  it('downloads nothing and keeps nothing when Save As is cancelled', async () => {
    const { downloads, groupStore, bridgeStore } = setup([null]);
    const before = groupStore.groupOrder.length;

    await bridgeStore.handleRequest(request({ requestId: 'r-cancel' }));

    expect(downloads).toHaveLength(0);
    expect(groupStore.groupOrder.length).toBe(before);
    const item = bridgeStore.snapshot().find(i => i.requestId === 'r-cancel');
    expect(item?.state).toBe('cancelled');
    expect(item?.title).toBe('Cats: The Movie');
  });

  it('downloads audio only when asked', async () => {
    const { dialogs, downloads, bridgeStore } = setup(['/Users/me/Music/cats.mp3']);

    await bridgeStore.handleRequest(request({ requestId: 'r-audio', audioOnly: true }));

    expect(dialogs[0].options.defaultPath).toBe('/Users/me/Downloads/Cats The Movie.mp3');
    expect(dialogs[0].options.filters?.[0].extensions).toEqual(['mp3']);
    expect(downloads[0].items[0].format.trackType).toBe(TrackType.audio);
  });

  it('reports progress and the finished file to the extension', async () => {
    const { downloads, bridgeStore, stateStore } = setup(['/Users/me/Movies/cats.mp4']);
    await bridgeStore.handleRequest(request({ requestId: 'r-progress' }));
    const groupId = downloads[0].groupId;
    const itemId = Object.keys(useMediaGroupStore().findGroupById(groupId).items)[0];

    useMediaProgressStore().processMediaProgressPayload({
      id: itemId,
      groupId,
      category: ProgressCategory.video,
      percentage: 41.66,
      speedBps: 2_000_000,
      etaSecs: 12,
    });
    useMediaProgressStore().processMediaProgressStagePayload({ id: itemId, groupId, stage: ProgressStage.downloading });

    let item = bridgeStore.snapshot().find(i => i.requestId === 'r-progress');
    expect(item).toMatchObject({ state: 'downloading', percent: 41.7, speedBps: 2_000_000, etaSecs: 12, title: 'Cats: The Movie' });

    useMediaDestinationStore().addDestination(groupId, { path: '/Users/me/Movies/cats.mp4', confidence: 1 });
    stateStore.setGroupState(groupId, MediaState.done);

    item = bridgeStore.snapshot().find(i => i.requestId === 'r-progress');
    expect(item).toMatchObject({ state: 'done', percent: 100, path: '/Users/me/Movies/cats.mp4' });
    expect(item?.speedBps).toBeUndefined();
  });
});
