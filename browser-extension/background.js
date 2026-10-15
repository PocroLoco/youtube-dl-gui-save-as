import {
  ACTIVE_STATES,
  AppNotRunning,
  FINAL_STATES,
  OPEN_APP_LINK,
  api,
  cleanVideoUrl,
  downloadLink,
  findApp,
  isDownloadablePage,
} from './shared.js';

const FAST_POLL_MS = 700;
const SLOW_POLL_MS = 1500;
// How long a sent download is followed before giving up on it.
const FOLLOW_FOR_MS = 6 * 60 * 60 * 1000;

/** Latest answer from the app, pushed to the popup and YouTube tabs. */
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
    latest = { connected: true, version: status.version, items: status.items ?? [], checkedAt: Date.now() };
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
  return latest;
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

// ---------- Starting downloads ----------

/**
 * Sends a download to the app. If the app isn't running, returns a link that
 * starts it with the download attached; the caller opens that link.
 */
async function startDownload({ url, title, audioOnly }) {
  const clean = cleanVideoUrl(url);
  if (!clean || !isDownloadablePage(clean)) return { ok: false, error: 'This page can’t be downloaded.' };
  const requestId = crypto.randomUUID();
  await follow(requestId, { url: clean, title, audioOnly: !!audioOnly });

  try {
    const result = await api('/v1/download', { url: clean, requestId, audioOnly: !!audioOnly });
    if (!result?.ok) throw new Error(result?.error ?? 'The app said no.');
    void keepWatching();
    return { ok: true, requestId };
  } catch (e) {
    if (!(e instanceof AppNotRunning)) {
      const followed = await getFollowed();
      delete followed[requestId];
      await setFollowed(followed);
      return { ok: false, error: String(e.message ?? e) };
    }
    void keepWatching();
    return { ok: false, needsLaunch: true, requestId, link: downloadLink({ url: clean, requestId, audioOnly }) };
  }
}

/**
 * Opens a small page that starts the app with a link. Chrome asks once
 * whether to allow it ("Always allow" makes it instant from then on).
 */
async function openLaunchPage(link, fromTab) {
  const page = chrome.runtime.getURL(`launch/launch.html#${encodeURIComponent(link)}`);
  await chrome.tabs.create({
    url: page,
    active: true,
    ...(fromTab ? { index: fromTab.index + 1, openerTabId: fromTab.id } : {}),
  });
}

async function downloadFromTab(tab, { url, audioOnly } = {}) {
  const result = await startDownload({ url: url ?? tab.url, title: url ? undefined : tab.title, audioOnly });
  if (result.needsLaunch) await openLaunchPage(result.link, tab);
  else if (!result.ok) {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Couldn’t send the download',
      message: result.error ?? '',
    });
  }
  return result;
}

// ---------- Right-click menu and keyboard shortcut ----------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const page = ['page', 'frame', 'video', 'audio'];
    chrome.contextMenus.create({ id: 'ovd', title: 'Open Video Downloader', contexts: [...page, 'link'] });
    chrome.contextMenus.create({ id: 'page-video', parentId: 'ovd', title: 'Download this video', contexts: page });
    chrome.contextMenus.create({ id: 'page-audio', parentId: 'ovd', title: 'Download audio only', contexts: page });
    chrome.contextMenus.create({ id: 'link-video', parentId: 'ovd', title: 'Download linked video', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'link-audio', parentId: 'ovd', title: 'Download linked audio only', contexts: ['link'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const audioOnly = info.menuItemId.endsWith('-audio');
  const url = info.menuItemId.startsWith('link-') ? info.linkUrl : info.pageUrl;
  void downloadFromTab(tab, { url, audioOnly });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'download-video') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) await downloadFromTab(target);
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

// ---------- Popup and YouTube tabs ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'status') return;
  listeners.add(port);
  port.onDisconnect.addListener(() => listeners.delete(port));
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
    case 'download':
      // From the YouTube button: the page opens the link itself if needed,
      // so Chrome can offer "Always allow youtube.com" for it.
      if (sender.tab && !message.fromPopup) return reply(startDownload(message));
      return reply((async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return downloadFromTab(tab, message);
      })());
    case 'status':
      return reply((async () => (Date.now() - latest.checkedAt < 1000 ? latest : refresh()))());
    case 'open':
      return reply(openItem(message.id, !!message.reveal));
    case 'show-app':
      return reply((async () => {
        try {
          return await api('/v1/show');
        } catch {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await openLaunchPage(OPEN_APP_LINK, tab);
          return { ok: true, launching: true };
        }
      })());
    case 'help':
      return reply((async () => {
        await chrome.tabs.create({ url: chrome.runtime.getURL('launch/launch.html#help') });
        return { ok: true };
      })());
    case 'find-app':
      return reply(findApp());
    default:
      return false;
  }
});
