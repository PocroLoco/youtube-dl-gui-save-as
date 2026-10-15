import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { useMediaStore } from './media/media';
import { useMediaGroupStore } from './media/group';
import { MediaState, useMediaStateStore } from './media/state';
import { useMediaProgressStore } from './media/progress';
import { useMediaDestinationStore } from './media/destination';
import { useMediaDiagnosticsStore } from './media/diagnostics';
import { useMediaOptionsStore } from './media/options';
import { useMediaSaveAsStore } from './media/saveAs';
import { DownloadOptions, SaveAsChoice, TrackType } from '../tauri/types/media';
import { BridgeItem, BridgeItemState, BridgeRequest } from '../tauri/types/bridge';

const REPORT_INTERVAL_MS = 600;
const MAX_REPORTED = 30;
const CANCELLED_TTL_MS = 10 * 60 * 1000;

/**
 * Downloads sent from the browser extension: always "Save as" first, then
 * download straight there, and keep the extension posted on progress.
 */
export const useBridgeStore = defineStore('bridge', () => {
  const mediaStore = useMediaStore();
  const groupStore = useMediaGroupStore();
  const stateStore = useMediaStateStore();
  const progressStore = useMediaProgressStore();
  const destinationStore = useMediaDestinationStore();
  const diagnosticsStore = useMediaDiagnosticsStore();
  const optionsStore = useMediaOptionsStore();
  const saveAsStore = useMediaSaveAsStore();

  const requestByGroup = new Map<string, string>();
  const waitingForSaveAs = new Set<string>();
  const firstSeen = new Map<string, number>();
  const cancelled = new Map<string, BridgeItem & { at: number }>();
  let draining = false;
  let drainAgain = false;
  let reporter: ReturnType<typeof setInterval> | undefined;
  let lastReport = '';

  async function drain(): Promise<void> {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        const requests = await invoke<BridgeRequest[]>('bridge_take_pending');
        for (const request of requests) {
          void handleRequest(request).catch((e) => {
            console.error('Browser download failed', e);
          });
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  }

  function optionsFor(groupId: string, audioOnly: boolean): DownloadOptions {
    const base = mediaStore.getDownloadOptions(groupId);
    if (!audioOnly || base.trackType === TrackType.audio) return base;
    return { trackType: TrackType.audio };
  }

  function track(groupId: string, requestId: string) {
    requestByGroup.set(groupId, requestId);
    if (!firstSeen.has(groupId)) firstSeen.set(groupId, Date.now());
  }

  async function handleRequest(request: BridgeRequest): Promise<void> {
    const [groupId] = await mediaStore.addUrlBatch([request.url], false, true, true);
    track(groupId, request.requestId);

    let readyIds: string[];
    try {
      readyIds = await mediaStore.waitForGroupReady(groupId);
    } catch {
      // Couldn't read the link; the group shows the error and so does the extension.
      return;
    }
    if (readyIds.length === 0) return;

    for (const id of readyIds) {
      track(id, request.requestId);
      const group = groupStore.findGroupById(id);
      if (group) group.fromBrowser = true;
      waitingForSaveAs.add(id);
    }

    let choice: SaveAsChoice | null = null;
    try {
      if (readyIds.length === 1) {
        const id = readyIds[0];
        const group = groupStore.findGroupById(id);
        const items = Object.values(group.items).filter(
          item => !item.entries && stateStore.getState(item.id) !== MediaState.done,
        );
        choice = await saveAsStore.askWhereToSave(group, items, optionsFor(id, request.audioOnly));
      } else {
        // A playlist that was split into separate videos: one folder for all.
        choice = await saveAsStore.askForFolder(optionsFor(readyIds[0], request.audioOnly).trackType);
      }
    } finally {
      for (const id of readyIds) waitingForSaveAs.delete(id);
      // If you were in the browser, go back there.
      if (!request.windowWasFocused) {
        void invoke('bridge_step_back', { hideWindow: !request.windowWasVisible }).catch(() => undefined);
      }
    }

    if (!choice) {
      // Cancelled, like closing a browser's save window: nothing downloads or stays behind.
      const first = groupStore.findGroupById(readyIds[0]);
      cancelled.set(request.requestId, {
        id: `request-${request.requestId}`,
        requestId: request.requestId,
        title: first?.title ?? request.url,
        url: request.url,
        thumbnail: first?.thumbnail,
        state: 'cancelled',
        at: Date.now(),
      });
      for (const id of readyIds) {
        if (groupStore.findGroupById(id)) mediaStore.deleteGroup(id);
        requestByGroup.delete(id);
        firstSeen.delete(id);
      }
      return;
    }

    for (const id of readyIds) {
      if (!groupStore.findGroupById(id)) continue;
      saveAsStore.setChoice(id, choice);
      const options = optionsFor(id, request.audioOnly);
      optionsStore.setOptions(id, options);
      await mediaStore.downloadGroup(id, options);
    }
  }

  function stateOf(groupId: string): BridgeItemState {
    if (waitingForSaveAs.has(groupId)) return 'saveAs';
    switch (stateStore.getGroupState(groupId)) {
      case MediaState.playlistSelection:
        return 'choosing';
      case MediaState.configure:
        return 'ready';
      case MediaState.downloading:
      case MediaState.downloadingList:
        return 'downloading';
      case MediaState.paused:
      case MediaState.pausedList:
        return 'paused';
      case MediaState.error:
        return 'error';
      case MediaState.done:
        return 'done';
      default:
        return 'fetching';
    }
  }

  function round(value: number | undefined): number | undefined {
    return value == null || Number.isNaN(value) ? undefined : Math.round(value * 10) / 10;
  }

  function describeGroup(groupId: string): BridgeItem | undefined {
    const group = groupStore.findGroupById(groupId);
    if (!group) return;
    const state = stateOf(groupId);
    const isList = group.isCombined || Object.keys(group.items).length > 1;
    const item: BridgeItem = {
      id: groupId,
      requestId: requestByGroup.get(groupId),
      title: group.title ?? group.url,
      url: group.url,
      thumbnail: group.thumbnail,
      state,
    };

    if (isList) {
      const progress = progressStore.findGroupProgress(groupId);
      if (progress?.total) {
        item.done = progress.done ?? 0;
        item.total = progress.total;
        item.percent = round((100 * item.done) / item.total);
      }
      item.speedBps = round(progress?.speedBps);
    } else {
      const progress = progressStore.findDownloadProgress(groupId);
      item.percent = round(progress?.percentage);
      item.speedBps = round(progress?.speedBps);
      item.etaSecs = round(progress?.etaSecs);
      item.stage = progress?.stage;
    }
    if (state === 'done') item.percent = 100;
    if (state !== 'downloading') {
      delete item.speedBps;
      delete item.etaSecs;
    }

    item.path = destinationStore.getPrimaryDestination(groupId)?.path;
    if (state === 'error') {
      item.error = diagnosticsStore.findLastFatalByGroupId(groupId)?.message?.slice(0, 300);
    }
    return item;
  }

  function snapshot(): BridgeItem[] {
    const now = Date.now();
    for (const [requestId, item] of cancelled) {
      if (now - item.at > CANCELLED_TTL_MS) cancelled.delete(requestId);
    }

    const order = groupStore.groupOrder;
    const entries: { at: number; index: number; item: BridgeItem }[] = [];
    order.forEach((groupId, index) => {
      if (!firstSeen.has(groupId)) firstSeen.set(groupId, now);
      const item = describeGroup(groupId);
      if (item) entries.push({ at: firstSeen.get(groupId) ?? now, index, item });
    });
    for (const { at, ...item } of cancelled.values()) {
      entries.push({ at, index: -1, item });
    }
    for (const groupId of [...firstSeen.keys()]) {
      if (!groupStore.findGroupById(groupId)) {
        firstSeen.delete(groupId);
        requestByGroup.delete(groupId);
      }
    }

    entries.sort((a, b) => b.at - a.at || a.index - b.index);
    return entries.slice(0, MAX_REPORTED).map(entry => entry.item);
  }

  async function report(): Promise<void> {
    const items = snapshot();
    const serialized = JSON.stringify(items);
    if (serialized === lastReport) return;
    lastReport = serialized;
    try {
      await invoke('bridge_status_set', { items });
    } catch (e) {
      lastReport = '';
      console.warn('Could not update the browser extension', e);
    }
  }

  function startReporting(): void {
    if (reporter) return;
    reporter = setInterval(() => void report(), REPORT_INTERVAL_MS);
    void report();
  }

  return {
    drain,
    handleRequest,
    snapshot,
    startReporting,
  };
});
