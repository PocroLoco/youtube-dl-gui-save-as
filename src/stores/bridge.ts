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
import { DownloadOptions, MediaFormat, SaveAsChoice, TrackType } from '../tauri/types/media';
import {
  BridgeChoice,
  BridgeChoices,
  BridgeClip,
  BridgeCommand,
  BridgeItem,
  BridgeItemState,
  BridgeRequest,
} from '../tauri/types/bridge';
import { approxAudio, approxVideo, sortFormats } from '../helpers/formats';
import { formatSecondsAsClock, toSeconds } from '../helpers/partialDownload';

const REPORT_INTERVAL_MS = 600;
const MAX_REPORTED = 30;
const CANCELLED_TTL_MS = 10 * 60 * 1000;
// Same as "Best" in the app's own audio picker.
const BEST_AUDIO: MediaFormat = Object.freeze({
  id: 'best',
  audioCodecs: [],
  videoCodecs: [],
  audioTrackIds: [],
  videoTrackIds: [],
});

/**
 * Downloads sent from the browser extension: the extension shows the video's
 * formats, you pick one in the browser, then "Save as" and the download goes
 * straight there. The extension is kept posted on progress.
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
  const pickingGroups = new Set<string>();
  const waitingForChoice = new Map<string, {
    groupIds: string[];
    resolve: (choice: BridgeChoice | null) => void;
  }>();
  const cancelledEarly = new Set<string>();
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
        const commands = await invoke<BridgeCommand[]>('bridge_take_pending');
        for (const command of commands ?? []) {
          if (command.kind === 'download') {
            void handleRequest(command).catch((e) => {
              console.error('Browser download failed', e);
            });
          } else if (command.kind === 'choose') {
            resolveChoice(command.requestId, command);
          } else if (command.kind === 'cancel') {
            resolveChoice(command.requestId, null);
          }
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  }

  /** A format picked in the browser (or null: the picker was closed). */
  function resolveChoice(requestId: string, choice: BridgeChoice | null) {
    const waiting = waitingForChoice.get(requestId);
    if (waiting) {
      waitingForChoice.delete(requestId);
      waiting.resolve(choice);
    } else if (!choice) {
      // Closed while the formats were still loading.
      cancelledEarly.add(requestId);
    }
  }

  function waitForChoice(requestId: string, groupIds: string[]): Promise<BridgeChoice | null> {
    return new Promise((resolve) => {
      waitingForChoice.set(requestId, { groupIds, resolve });
    });
  }

  function optionsFor(groupId: string, audioOnly: boolean): DownloadOptions {
    const base = mediaStore.getDownloadOptions(groupId);
    if (!audioOnly || base.trackType === TrackType.audio) return base;
    return { trackType: TrackType.audio };
  }

  /** Turns the browser's pick into the same options the app's own picker makes. */
  function optionsFromChoice(groupId: string, choice: BridgeChoice): DownloadOptions {
    const formats = groupStore.findGroupById(groupId)?.formats ?? [];
    if (choice.trackType === TrackType.audio) {
      const audio = formats.filter(format => format.abr);
      const match = choice.abr == null
        ? undefined
        : audio.find(format => format.abr === choice.abr) ?? approxAudio(audio, choice.abr);
      return { trackType: TrackType.audio, ...(match ?? BEST_AUDIO) };
    }
    const video = formats.filter(format => format.height);
    const match = video.find(format => format.height === choice.height && (format.fps ?? undefined) === choice.fps)
      ?? approxVideo(video, choice.height, choice.fps);
    return { trackType: choice.trackType, ...(match ?? {}) };
  }

  /**
   * A clip picked in the browser becomes the app's own "download part of the
   * video" setting, with exact cuts so it starts and ends where you said.
   */
  function applyClip(groupId: string, clip: BridgeClip | undefined) {
    const group = groupStore.findGroupById(groupId);
    if (!clip || !group) return;
    const start = Math.max(0, Math.floor(clip.start));
    let end = Math.ceil(clip.end);
    if (group.duration) end = Math.min(end, Math.ceil(group.duration));
    if (end <= start) return;
    // The whole thing anyway: a normal download.
    if (start === 0 && group.duration && end >= Math.floor(group.duration)) return;
    const current = optionsStore.getOverrides(groupId);
    optionsStore.setOverrides(groupId, {
      ...current,
      output: {
        ...current?.output,
        preciseCuts: true,
        partialDownload: {
          section: { id: 'browser-clip', start: formatSecondsAsClock(start), end: formatSecondsAsClock(end) },
        },
      },
    });
  }

  function clipOf(groupId: string): BridgeClip | undefined {
    const section = optionsStore.getOverrides(groupId)?.output?.partialDownload?.section;
    if (!section) return undefined;
    const start = toSeconds(section.start);
    const end = toSeconds(section.end);
    return start == null || end == null ? undefined : { start, end };
  }

  /** The formats to offer in the browser, labelled like the app's own picker. */
  function choicesFor(groupIds: string[]): BridgeChoices {
    const formats = groupIds.flatMap(id => groupStore.findGroupById(id)?.formats ?? []);
    const seenVideo = new Set<string>();
    const video: BridgeChoices['video'] = [];
    for (const format of sortFormats(formats.filter(f => f.height))) {
      const key = `${format.height}|${format.fps ?? ''}`;
      if (seenVideo.has(key)) continue;
      seenVideo.add(key);
      video.push({
        height: format.height!,
        fps: format.fps ?? undefined,
        label: format.fps ? `${format.height}p${format.fps}` : `${format.height}p`,
      });
    }
    const seenAudio = new Set<number>();
    const audio: BridgeChoices['audio'] = [{ label: 'Best' }];
    for (const format of sortFormats(formats.filter(f => f.abr))) {
      if (seenAudio.has(format.abr!)) continue;
      seenAudio.add(format.abr!);
      audio.push({ abr: format.abr, label: `${format.abr}kbps` });
    }
    return { video, audio };
  }

  function track(groupId: string, requestId: string) {
    requestByGroup.set(groupId, requestId);
    if (!firstSeen.has(groupId)) firstSeen.set(groupId, Date.now());
  }

  /** Drops a browser download that didn't go ahead, leaving nothing behind. */
  function discard(groupIds: string[]) {
    for (const id of groupIds) {
      if (groupStore.findGroupById(id)) mediaStore.deleteGroup(id);
      requestByGroup.delete(id);
      firstSeen.delete(id);
    }
  }

  async function handleRequest(request: BridgeRequest): Promise<void> {
    const picking = request.chooseFormat === true;
    const [groupId] = await mediaStore.addUrlBatch([request.url], false, true, { fromBrowser: true, hidden: picking });
    track(groupId, request.requestId);

    let readyIds: string[];
    try {
      readyIds = await mediaStore.waitForGroupReady(groupId);
    } catch {
      // Couldn't read the link. The extension shows the error; once its picker
      // closes, nothing stays behind in the app.
      if (picking) {
        if (!cancelledEarly.delete(request.requestId)) await waitForChoice(request.requestId, [groupId]);
        discard([groupId]);
      }
      return;
    }
    if (readyIds.length === 0) return;
    if (cancelledEarly.delete(request.requestId)) {
      discard(readyIds);
      return;
    }

    for (const id of readyIds) {
      track(id, request.requestId);
      const group = groupStore.findGroupById(id);
      if (group) {
        group.fromBrowser = true;
        if (picking) group.hidden = true;
      }
    }

    let pickedOptions: ((groupId: string) => DownloadOptions) | undefined;
    if (picking) {
      // Wait for a format to be picked in the browser.
      for (const id of readyIds) pickingGroups.add(id);
      const choice = await waitForChoice(request.requestId, readyIds);
      for (const id of readyIds) pickingGroups.delete(id);
      if (!choice) {
        discard(readyIds);
        return;
      }
      for (const id of readyIds) {
        const group = groupStore.findGroupById(id);
        if (group) group.hidden = false;
      }
      pickedOptions = id => optionsFromChoice(id, choice);
      // A clip only makes sense for one video, not a playlist.
      const single = readyIds.length === 1 && !groupStore.findGroupById(readyIds[0])?.isCombined;
      if (single) applyClip(readyIds[0], choice.clip);
    }
    const optionsOf = pickedOptions ?? (id => optionsFor(id, request.audioOnly));

    for (const id of readyIds) waitingForSaveAs.add(id);

    let choice: SaveAsChoice | null = null;
    try {
      if (readyIds.length === 1) {
        const id = readyIds[0];
        const group = groupStore.findGroupById(id);
        const items = Object.values(group.items).filter(
          item => !item.entries && stateStore.getState(item.id) !== MediaState.done,
        );
        choice = await saveAsStore.askWhereToSave(group, items, optionsOf(id));
      } else {
        // A playlist that was split into separate videos: one folder for all.
        choice = await saveAsStore.askForFolder(optionsOf(readyIds[0]).trackType);
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
      discard(readyIds);
      return;
    }

    for (const id of readyIds) {
      if (!groupStore.findGroupById(id)) continue;
      saveAsStore.setChoice(id, choice);
      const options = optionsOf(id);
      optionsStore.setOptions(id, options);
      await mediaStore.downloadGroup(id, options);
    }
  }

  function stateOf(groupId: string): BridgeItemState {
    if (waitingForSaveAs.has(groupId)) return 'saveAs';
    if (pickingGroups.has(groupId)) return 'pick';
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
      duration: group.duration,
      uploader: group.uploader,
      state,
      pending: group.hidden || undefined,
      clip: clipOf(groupId),
    };

    if (state === 'pick') {
      const requestId = requestByGroup.get(groupId);
      const waiting = requestId ? waitingForChoice.get(requestId) : undefined;
      item.choices = choicesFor(waiting?.groupIds ?? [groupId]);
      if (waiting && waiting.groupIds.length > 1) item.total = waiting.groupIds.length;
      else if (group.isCombined) item.total = Object.values(group.items).filter(i => !i.isLeader).length;
      return item;
    }

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
