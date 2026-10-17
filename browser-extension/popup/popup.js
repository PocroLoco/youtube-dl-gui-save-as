import { OPEN_APP_LINK, cleanVideoUrl, describe, finishPendingUpdate, isDownloadablePage, isKnownVideoPage } from '../shared.js';
import { mountPicker } from '../ui/picker.js';

const $ = id => document.getElementById(id);

const ICONS = {
  open: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7L8 5Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>',
};

let activeTab = null;
let pageUrl = null;
let picker = null;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function pageMessage(...children) {
  const box = document.createElement('div');
  box.className = 'page-message';
  box.append(...children);
  $('page').replaceChildren(box);
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function button(label, onClick, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

/** The app is closed: a small window starts it, then shows the picker. */
function offerToStart() {
  pageMessage(
    text('p', 'page-title', activeTab?.title || pageUrl),
    text('p', '', 'Open Video Downloader isn’t running. Start it and pick the format there.'),
    button('Start and download', async () => {
      await send({ type: 'open-picker-window', url: activeTab?.url ?? pageUrl, title: activeTab?.title, tabId: activeTab?.id });
      window.close();
    }, 'primary'),
  );
}

/**
 * Picking a clip means going back and forth to the video, which closes this
 * popup. So "Clip" moves the picker to Chrome's side panel, which stays open.
 * Has to start inside the click; returns a promise (or nothing if the side
 * panel isn't available, and the clip is picked right here).
 */
function openClipPanel() {
  const tabId = activeTab?.id;
  if (tabId == null || !chrome.sidePanel?.open) return undefined;
  const key = `panel:${tabId}`;
  const told = chrome.storage.session.set({ [key]: { url: activeTab.url, title: activeTab.title, at: Date.now() } });
  void chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/panel.html', enabled: true });
  return Promise.all([chrome.sidePanel.open({ tabId }), told]);
}

function showPicker() {
  picker?.destroy();
  picker = mountPicker($('page'), {
    // The tab's own link; the extension tidies it up (and can fall back to it).
    url: activeTab?.url ?? pageUrl,
    title: activeTab?.title,
    tabId: activeTab?.id,
    onAppMissing: offerToStart,
    onClipOn: openClipPanel,
    onHandedOff: () => window.close(),
  });
}

async function showPage() {
  // popup.html#url=…&title=…&tabId=… stands in for the current tab (used by the extension's tests).
  const forced = new URLSearchParams(location.hash.slice(1));
  [activeTab] = forced.get('url')
    ? [{ url: forced.get('url'), title: forced.get('title') ?? undefined, id: forced.get('tabId') ? Number(forced.get('tabId')) : undefined }]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  pageUrl = activeTab?.url ? cleanVideoUrl(activeTab.url) : null;
  if (!pageUrl || !isDownloadablePage(pageUrl)) {
    pageMessage(text('p', '', 'Open a video page (YouTube, Shorts, TikTok, …) and click here to download it.'));
    return;
  }
  const app = await send({ type: 'find-app' });
  if (app?.port && await finishPendingUpdate((await send({ type: 'status' }))?.info)) {
    pageMessage(
      text('p', 'page-title', 'Finishing an update…'),
      text('p', '', 'Click the extension again in a second.'),
    );
    return;
  }
  if (!app?.port) {
    offerToStart();
  } else if (isKnownVideoPage(pageUrl)) {
    showPicker();
  } else if (/(^|\.)youtube\.com$/.test(new URL(pageUrl).hostname) && !new URL(pageUrl).pathname.startsWith('/playlist')) {
    // YouTube's home, search, channel pages… (a whole feed isn't what you want).
    pageMessage(text('p', '', 'Open a video or Short, then click here to download it.'));
  } else {
    // Unknown site: only look for a video when asked.
    pageMessage(
      text('p', 'page-title', activeTab.title || pageUrl),
      button('Find video on this page', showPicker, 'primary'),
    );
  }
}

let bannerKey = '';

/** "Update ready" from the app, or a hint when this copy can't update itself. */
async function renderBanner({ connected, info }) {
  const banner = $('banner');
  const mine = chrome.runtime.getManifest().version;
  const wanted = info?.extensionVersion;
  let reloadAttempt;
  try {
    ({ reloadAttempt } = await chrome.storage.local.get('reloadAttempt'));
  } catch {
    reloadAttempt = undefined;
  }

  const stuck = connected && wanted && wanted !== mine && reloadAttempt?.version === wanted;
  const key = `${connected && info?.updateReady ? info.updateReady : ''}|${stuck ? wanted : ''}`;
  if (key === bannerKey) return;
  bannerKey = key;

  const rows = [];
  if (connected && info?.updateReady) {
    const restart = button('Restart app', async () => {
      restart.disabled = true;
      const result = await send({ type: 'restart-app' });
      if (!result?.ok) {
        restart.disabled = false;
        note.textContent = result?.error === 'busy'
          ? 'Finish the downloads in progress first.'
          : 'Couldn’t restart it. Quit and reopen the app instead.';
      }
    }, 'primary');
    const row = document.createElement('div');
    row.className = 'row';
    row.append(text('p', '', `Version ${info.updateReady} is installed.`), restart);
    const note = text('p', 'small', 'Restart the app to start using it (or it switches over next time it opens).');
    rows.push(row, note);
  }
  if (stuck) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      text('p', '', 'This copy of the extension can’t update itself.'),
      button('Show folder', () => void send({ type: 'reveal-extension' })),
    );
    rows.push(row, text('p', 'small', 'Remove it in chrome://extensions, then load the app’s “Chrome Extension” folder instead. From then on it updates with the app.'));
  }
  banner.replaceChildren(...rows);
  banner.hidden = rows.length === 0;
}

function render({ connected, items, info }) {
  void renderBanner({ connected, info });
  const connection = $('connection');
  connection.classList.toggle('on', connected);
  connection.classList.toggle('off', !connected);
  $('connection-text').textContent = connected ? 'Connected' : 'App not running';

  const list = $('list');
  list.replaceChildren();
  // The page being picked right now is shown above, not in the list.
  const shown = (items ?? []).filter(item => item.state !== 'pick' && !item.pending).slice(0, 20);
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = connected ? 'Nothing downloading yet.' : 'Nothing to show while the app is closed.';

  for (const item of shown) {
    const li = document.createElement('li');
    li.className = item.state;

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    thumb.referrerPolicy = 'no-referrer';
    const placeholder = () => {
      thumb.classList.add('placeholder');
      thumb.src = '../icons/icon-48.png';
    };
    if (item.thumbnail && /^https:\/\//.test(item.thumbnail)) {
      thumb.src = item.thumbnail;
      thumb.addEventListener('error', placeholder, { once: true });
    } else {
      placeholder();
    }

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title ?? item.url ?? 'Video';
    title.title = title.textContent;
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = describe(item);
    status.title = status.textContent;
    info.append(title, status);

    if (['downloading', 'paused', 'fetching', 'saveAs'].includes(item.state)) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      if (item.state === 'downloading' && item.percent != null) fill.style.width = `${Math.min(100, item.percent)}%`;
      else if (item.state === 'paused' && item.percent != null) fill.style.width = `${item.percent}%`;
      else bar.classList.add('indeterminate');
      bar.append(fill);
      info.append(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    if (item.state === 'done' && item.hasFile) {
      li.classList.add('openable');
      li.title = item.total > 1 ? 'Show in folder' : 'Open';
      li.addEventListener('click', () => void send({ type: 'open', id: item.id, reveal: item.total > 1 }));
      const addButton = (icon, label, reveal) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'icon-button';
        button.innerHTML = ICONS[icon];
        button.title = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          void send({ type: 'open', id: item.id, reveal });
        });
        actions.append(button);
      };
      if (!(item.total > 1)) addButton('open', 'Open', false);
      addButton('folder', 'Show in folder', true);
    }

    li.append(thumb, info, actions);
    list.append(li);
  }
}

$('open-app').addEventListener('click', async () => {
  const result = await send({ type: 'show-app' });
  if (!result?.ok) {
    // Not running: this link starts it (Chrome may ask the first time).
    const a = document.createElement('a');
    a.href = OPEN_APP_LINK;
    document.body.append(a);
    a.click();
    a.remove();
  }
  setTimeout(() => window.close(), 300);
});

const port = chrome.runtime.connect({ name: 'status' });
port.onMessage.addListener((message) => {
  if (message?.type === 'status') render(message);
});

void showPage();
