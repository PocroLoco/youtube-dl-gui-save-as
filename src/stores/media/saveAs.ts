import { defineStore } from 'pinia';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { i18n } from '../../i18n';
import { usePreferencesStore } from '../preferences';
import { useSettingsStore } from '../settings';
import { useMediaOptionsStore } from './options';
import { DownloadOptions, MediaItem, SaveAsChoice, TrackType } from '../../tauri/types/media';
import { Group } from '../../tauri/types/group';

export const SAVE_AS_RECENTS_KEY = 'saveAsDir';

function splitPath(path: string): { dir: string; separator: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return {
    dir: index >= 0 ? path.slice(0, index) : '',
    separator: index >= 0 ? path[index] : '/',
  };
}

function separatorFor(dir: string): string {
  return dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
}

function toFileName(title: string | undefined): string {
  const cleaned = (title ?? '')
    // Characters that aren't allowed in file names on macOS/Windows/Linux.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned || 'video';
}

/**
 * Browser-style "Save as": before a download starts, ask where it should go.
 * One window at a time, and each group remembers its answer so pause/resume
 * keeps writing to the same place.
 */
export const useMediaSaveAsStore = defineStore('media-save-as', () => {
  const preferencesStore = usePreferencesStore();
  const settingsStore = useSettingsStore();
  const optionsStore = useMediaOptionsStore();
  const choices = new Map<string, SaveAsChoice>();
  const prompting = new Set<string>();
  let promptQueue: Promise<unknown> = Promise.resolve();

  function isEnabled(): boolean {
    return preferencesStore.preferences.paths?.askDownloadLocation === true;
  }

  function getChoice(groupId: string): SaveAsChoice | undefined {
    return choices.get(groupId);
  }

  function forget(groupId: string): void {
    choices.delete(groupId);
  }

  function isPrompting(groupId: string): boolean {
    return prompting.has(groupId);
  }

  function startDir(trackType: TrackType): string | undefined {
    const paths = preferencesStore.preferences.paths;
    const trackDir = trackType === TrackType.audio ? paths?.audioDownloadDir : paths?.videoDownloadDir;
    return preferencesStore.getRecentPaths(SAVE_AS_RECENTS_KEY)[0]
      ?? trackDir
      ?? settingsStore.settings.output?.downloadDir
      ?? undefined;
  }

  function expectedExtension(groupId: string, trackType: TrackType): string {
    const output = optionsStore.getOverrides(groupId)?.output;
    if (trackType === TrackType.audio) {
      return output?.audio?.format ?? settingsStore.settings.output?.audio?.format ?? '';
    }
    return output?.video?.container ?? settingsStore.settings.output?.video?.container ?? '';
  }

  async function bringWindowForward(): Promise<void> {
    try {
      // Also un-hides the app on macOS (after a browser download stepped back).
      await invoke('bring_window_forward');
    } catch {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.unminimize();
        await appWindow.show();
        await appWindow.setFocus();
      } catch (e) {
        console.warn('Could not focus window for save dialog', e);
      }
    }
  }

  async function prompt(group: Group, items: MediaItem[], options: DownloadOptions): Promise<SaveAsChoice | null> {
    await bringWindowForward();
    const dir = startDir(options.trackType);
    const isSingleFile = items.length === 1 && !group.isCombined;

    if (isSingleFile) {
      const extension = expectedExtension(group.id, options.trackType);
      const name = toFileName(items[0].title ?? group.title) + (extension ? `.${extension}` : '');
      const filePath = await save({
        title: i18n.global.t('location.askDownloadLocation.dialogTitle'),
        defaultPath: dir ? `${dir}${separatorFor(dir)}${name}` : name,
        canCreateDirectories: true,
        filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
      });
      if (!filePath) return null;
      await preferencesStore.addRecentPath(SAVE_AS_RECENTS_KEY, splitPath(filePath).dir);
      return { filePath };
    }

    return pickFolder(options.trackType);
  }

  async function pickFolder(trackType: TrackType): Promise<SaveAsChoice | null> {
    const folder = await open({
      title: i18n.global.t('location.askDownloadLocation.folderDialogTitle'),
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      defaultPath: startDir(trackType),
    });
    if (typeof folder !== 'string' || folder.length === 0) return null;
    await preferencesStore.addRecentPath(SAVE_AS_RECENTS_KEY, folder);
    return { dir: folder };
  }

  /** Runs one dialog at a time, in the order they were asked for. */
  function enqueuePrompt<T>(run: () => Promise<T>): Promise<T> {
    const result = promptQueue.then(run, run);
    promptQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Shows the "Save as" window for a group and remembers the answer.
   * Returns null when the user cancels.
   */
  function askWhereToSave(group: Group, items: MediaItem[], options: DownloadOptions): Promise<SaveAsChoice | null> {
    prompting.add(group.id);
    return enqueuePrompt(() => prompt(group, items, options)).then((choice) => {
      if (choice) choices.set(group.id, choice);
      return choice;
    }).finally(() => {
      prompting.delete(group.id);
    });
  }

  /**
   * Asks for one folder for several downloads at once (a playlist sent from
   * the browser). Returns null when the user cancels.
   */
  function askForFolder(trackType: TrackType): Promise<SaveAsChoice | null> {
    return enqueuePrompt(async () => {
      await bringWindowForward();
      return pickFolder(trackType);
    });
  }

  function setChoice(groupId: string, choice: SaveAsChoice): void {
    choices.set(groupId, choice);
  }

  return {
    isEnabled,
    isPrompting,
    getChoice,
    setChoice,
    forget,
    askWhereToSave,
    askForFolder,
  };
});
