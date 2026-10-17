import {
  ACTIVE_STATES,
  AppNotRunning,
  FINAL_STATES,
  api,
  cleanVideoUrl,
  findApp,
  isDownloadablePage,
} from './shared.js';

const FAST_POLL_MS = 700;
const SLOW_POLL_MS = 1500;
// How long a sent download is followed before giving up on it.
const FOLLOW_FOR_MS = 6 * 60 * 60 * 1000;

/** Latest answer from the app, pushed to the popup and picker windows. */
let latest = { connected: false, items: [], checkedAt: 0 };
let polling = false;
const listeners = new Set();

// ---------- Downloads we sent, kept across service worker restarts ----------

async function getFollowed() {
  const { followed } = await chrome.storage.session.get('followed');
  return followed ?? {};
}

async function setFollowed(followed) {
  await chrome.storage.session.set({ followed });
}

async function follow(requestId, info) {
  const followed = await getFollowed();
  followed[requestId] = { ...info, sentAt: Date.now(), finished: false };
  await setFollowed(followed);
}

// ---------- Talking to the app ----------

async function refresh() {
  try {
    const status = await api('/v1/status');
    latest = {
      connected: true,
      version: status.version,
      info: status.info ?? {},
      items: status.items ?? [],
      checkedAt: Date.now(),
    };
  } catch (error) {
    if (!(error instanceof AppNotRunning)) console.debug('Status check failed', error);
    latest = { connected: false, items: [], checkedAt: Date.now() };
  }
  for (const port of listeners) {
    try {
      port.postMessage({ type: 'status', ...latest });
    } catch {
      listeners.delete(port);
    }
  }
  await updateBadge();
  await notifyFinished();
  await reloadIfUpdated();
  return latest;
}

// ---------- Updating itself ----------

// The app carries this extension's files and puts new ones in its folder
// whenever the app updates. When the app reports a different version than the
// one running here, reload to pick the new files up. (If this copy was loaded
// from some other folder, reloading changes nothing; the popup then explains.)
const RELOAD_RETRY_MS = 6 * 60 * 60 * 1000;

async function reloadIfUpdated() {
  const wanted = latest.info?.extensionVersion;
  if (!latest.connected || !wanted || wanted === chrome.runtime.getManifest().version) return;
  // Don't pull the rug out from under an open popup or picker.
  if (listeners.size > 0) return;
  const followed = await getFollowed();
  if (Object.values(followed).some(f => !f.chosen)) return;
  const { reloadAttempt } = await chrome.storage.local.get('reloadAttempt');
  if (reloadAttempt?.version === wanted && Date.now() - reloadAttempt.at < RELOAD_RETRY_MS) return;
  await chrome.storage.local.set({ reloadAttempt: { version: wanted, at: Date.now() } });
  chrome.runtime.reload();
}

async function hasOpenRequests() {
  const followed = await getFollowed();
  const now = Date.now();
  return Object.values(followed).some(f => !f.finished && now - f.sentAt < FOLLOW_FOR_MS);
}

/** Keeps checking while something is going on, then goes quiet. */
async function keepWatching() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      await refresh();
      const busy = latest.items.some(item => ACTIVE_STATES.has(item.state));
      const open = await hasOpenRequests();
      if (!busy && !open && listeners.size === 0) break;
      await new Promise(resolve => setTimeout(resolve, busy || listeners.size > 0 ? FAST_POLL_MS : SLOW_POLL_MS));
    }
  } finally {
    polling = false;
  }
}

async function updateBadge() {
  const active = latest.items.filter(item => ACTIVE_STATES.has(item.state));
  let text = '';
  if (active.length === 1) {
    const [item] = active;
    text = item.state === 'downloading' && item.percent != null && !(item.total > 1) ? `${Math.floor(item.percent)}%` : '…';
  } else if (active.length > 1) {
    text = String(active.length);
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text });
}

// ---------- "Done" notifications for downloads sent from here ----------

async function notifyFinished() {
  if (!latest.connected) return;
  const followed = await getFollowed();
  let changed = false;
  const now = Date.now();

  for (const [requestId, info] of Object.entries(followed)) {
    if (!info.chosen) continue;
    if (info.finished) {
      if (now - info.sentAt > FOLLOW_FOR_MS) {
        delete followed[requestId];
        changed = true;
      }
      continue;
    }
    const items = latest.items.filter(item => item.requestId === requestId);
    if (items.length === 0) continue;
    if (!items.every(item => FINAL_STATES.has(item.state))) continue;

    info.finished = true;
    changed = true;
    const done = items.filter(item => item.state === 'done');
    const failed = items.filter(item => item.state === 'error');
    if (done.length > 0) {
      const first = done[0];
      info.openId = first.id;
      await chrome.notifications.create(`done:${requestId}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: done.length > 1 ? `Downloaded ${done.length} videos` : 'Download finished',
        message: done.length > 1 ? first.title ?? '' : first.title ?? first.fileName ?? '',
        contextMessage: done.length > 1 ? 'Click to show them' : 'Click to open',
        buttons: done.length > 1 ? [{ title: 'Show in folder' }] : [{ title: 'Open' }, { title: 'Show in folder' }],
        priority: 1,
      });
      info.multiple = done.length > 1;
    } else if (failed.length > 0) {
      await chrome.notifications.create(`failed:${requestId}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Download failed',
        message: failed[0].title ?? info.url,
        contextMessage: failed[0].error ?? '',
        priority: 1,
      });
    }
    // Cancelled: you closed the save window yourself, nothing to tell.
  }
  if (changed) await setFollowed(followed);
}

async function openItem(id, reveal) {
  try {
    const result = await api('/v1/open', { id, reveal });
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof AppNotRunning ? 'app-not-running' : String(e) };
  }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const [kind, requestId] = notificationId.split(':');
  chrome.notifications.clear(notificationId);
  const info = (await getFollowed())[requestId];
  if (kind === 'done' && info?.openId) await openItem(info.openId, info.multiple);
  else await api('/v1/show').catch(() => undefined);
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const [, requestId] = notificationId.split(':');
  chrome.notifications.clear(notificationId);
  const info = (await getFollowed())[requestId];
  if (!info?.openId) return;
  const reveal = info.multiple || buttonIndex === 1;
  await openItem(info.openId, reveal);
});

// ---------- Picking a format, then downloading ----------

// A closed picker is cancelled after a short grace period, so reopening the
// popup on the same video right away reuses the formats already read.
const CANCEL_AFTER_MS = 20 * 1000;
const cancelTimers = new Map();
const requestForUrl = new Map();

async function unfollow(requestId) {
  const followed = await getFollowed();
  delete followed[requestId];
  await setFollowed(followed);
}

/**
 * Has the app read the video's formats. Returns { ok, requestId }, or
 * { needsLaunch: true } when the app isn't running.
 */
async function prepare({ url, title, exact }) {
  // `exact`: use the page's own link as-is (when the tidied-up one didn't work).
  const clean = exact ? url : cleanVideoUrl(url);
  if (!clean || !isDownloadablePage(clean)) return { ok: false, error: 'This page can’t be downloaded.' };
  // Rumble Shorts get rewritten to the regular video link; if that ever fails,
  // the picker retries with the Shorts link itself.
  const fallbackUrl = !exact && /^https?:\/\/(www\.)?rumble\.com\/shorts\//.test(url) ? url : undefined;

  const reuse = requestForUrl.get(clean);
  if (reuse && cancelTimers.has(reuse)) {
    clearTimeout(cancelTimers.get(reuse));
    cancelTimers.delete(reuse);
    return { ok: true, requestId: reuse, fallbackUrl };
  }

  const requestId = crypto.randomUUID();
  await follow(requestId, { url: clean, title, chosen: false });
  try {
    const result = await api('/v1/download', { url: clean, requestId, chooseFormat: true });
    if (!result?.ok) throw new Error(result?.error ?? 'The app said no.');
    requestForUrl.set(clean, requestId);
    void keepWatching();
    return { ok: true, requestId, fallbackUrl };
  } catch (e) {
    await unfollow(requestId);
    if (e instanceof AppNotRunning) return { ok: false, needsLaunch: true };
    return { ok: false, error: String(e.message ?? e) };
  }
}

async function choose({ requestId, trackType, height, fps, abr, clip }) {
  const part = clip && Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start
    ? { start: Math.max(0, clip.start), end: clip.end }
    : undefined;
  try {
    const result = await api('/v1/choose', { requestId, trackType, height, fps, abr, clip: part });
    if (!result?.ok) return { ok: false, error: result?.error ?? 'The app said no.' };
  } catch (e) {
    return { ok: false, error: e instanceof AppNotRunning ? 'Open Video Downloader isn’t running.' : String(e) };
  }
  const followed = await getFollowed();
  if (followed[requestId]) {
    followed[requestId].chosen = true;
    await setFollowed(followed);
    for (const [url, id] of requestForUrl) if (id === requestId) requestForUrl.delete(url);
  }
  void keepWatching();
  return { ok: true };
}

/** The picker closed. If nothing was picked, let the app drop it. */
async function pickerClosed(requestId) {
  const info = (await getFollowed())[requestId];
  if (!info || info.chosen) return;
  clearTimeout(cancelTimers.get(requestId));
  cancelTimers.set(requestId, setTimeout(async () => {
    cancelTimers.delete(requestId);
    const latestInfo = (await getFollowed())[requestId];
    if (latestInfo?.chosen) return;
    for (const [url, id] of requestForUrl) if (id === requestId) requestForUrl.delete(url);
    await unfollow(requestId);
    await api('/v1/cancel', { requestId }).catch(() => undefined);
  }, CANCEL_AFTER_MS));
}

/** A small window with the picker (it also starts the app when needed). */
async function openPickerWindow({ url, title, tabId }) {
  // tabId: the tab playing the video, so a clip can start where it is now.
  const page = chrome.runtime.getURL(`window/window.html#${encodeURIComponent(JSON.stringify({ url, title, tabId }))}`);
  const width = 400;
  const height = 600;
  let position = {};
  try {
    const current = await chrome.windows.getLastFocused();
    if (current?.left != null && current.width) {
      position = { left: Math.max(0, current.left + current.width - width - 24), top: (current.top ?? 0) + 72 };
    }
  } catch {
    // Let Chrome place it.
  }
  await chrome.windows.create({ url: page, type: 'popup', width, height, focused: true, ...position });
}

// ---------- Right-click menu and keyboard shortcut ----------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'page',
      title: 'Download with Open Video Downloader',
      contexts: ['page', 'frame', 'video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'link',
      title: 'Download link with Open Video Downloader',
      contexts: ['link'],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'link' ? info.linkUrl : info.pageUrl;
  const isPage = info.menuItemId !== 'link';
  if (url) void openPickerWindow({ url, title: isPage ? tab?.title : undefined, tabId: isPage ? tab?.id : undefined });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'download-video') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.url && isDownloadablePage(target.url)) await openPickerWindow({ url: target.url, title: target.title, tabId: target.id });
});

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  chrome.alarms.create('watch', { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('watch', { periodInMinutes: 0.5 });
  void keepWatching();
});

// A safety net in case Chrome put the service worker to sleep mid-download.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'watch') void keepWatching();
});

// ---------- Popup, picker window ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'status' && !port.name.startsWith('picker:')) return;
  listeners.add(port);
  port.onDisconnect.addListener(() => {
    listeners.delete(port);
    if (port.name.startsWith('picker:')) void pickerClosed(port.name.slice('picker:'.length));
    if (listeners.size === 0) setTimeout(() => void reloadIfUpdated(), 1500);
  });
  // Fresh enough? Show it now; otherwise the next check sends it in a moment.
  if (Date.now() - latest.checkedAt < 3000) port.postMessage({ type: 'status', ...latest });
  void keepWatching();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  };

  switch (message?.type) {
    case 'prepare':
      return reply(prepare(message));
    case 'choose':
      return reply(choose(message));
    case 'open-picker-window':
      return reply(openPickerWindow(message).then(() => ({ ok: true })));
    case 'status':
      return reply((async () => (Date.now() - latest.checkedAt < 1000 ? latest : refresh()))());
    case 'open':
      return reply(openItem(message.id, !!message.reveal));
    case 'show-app':
      return reply((async () => {
        try {
          return await api('/v1/show');
        } catch {
          return { ok: false, error: 'app-not-running' };
        }
      })());
    case 'find-app':
      return reply(findApp());
    case 'restart-app':
      return reply(api('/v1/restart').catch(() => ({ ok: false, error: 'app-not-running' })));
    case 'reveal-extension':
      return reply(api('/v1/reveal-extension').catch(() => ({ ok: false, error: 'app-not-running' })));
    default:
      return false;
  }
});

// Each time the service worker starts: catch up on downloads and updates.
void keepWatching();
