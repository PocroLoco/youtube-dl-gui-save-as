import { cleanVideoUrl, describe, isDownloadablePage } from '../shared.js';

const $ = id => document.getElementById(id);

const ICONS = {
  open: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7L8 5Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>',
};

let activeTab = null;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function showPage() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = activeTab?.url && cleanVideoUrl(activeTab.url);
  const usable = !!url && isDownloadablePage(url);
  $('page').hidden = !usable;
  $('page-unavailable').hidden = usable;
  if (usable) $('page-title').textContent = activeTab.title || url;
}

async function download(audioOnly) {
  $('download-video').disabled = true;
  $('download-audio').disabled = true;
  const result = await send({ type: 'download', fromPopup: true, audioOnly });
  // If the app had to be started, a new tab opened and this popup is gone.
  if (result?.ok) {
    $('page-title').textContent = 'Sent — choose where to save it.';
  } else if (result && !result.needsLaunch) {
    $('page-title').textContent = result.error ?? 'Couldn’t send it.';
  }
  setTimeout(() => {
    $('download-video').disabled = false;
    $('download-audio').disabled = false;
  }, 1500);
}

function render({ connected, items }) {
  const connection = $('connection');
  connection.classList.toggle('on', connected);
  connection.classList.toggle('off', !connected);
  $('connection-text').textContent = connected ? 'Connected' : 'App not running — Download starts it';

  const list = $('list');
  list.replaceChildren();
  const shown = (items ?? []).slice(0, 20);
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

$('download-video').addEventListener('click', () => void download(false));
$('download-audio').addEventListener('click', () => void download(true));
$('open-app').addEventListener('click', async () => {
  await send({ type: 'show-app' });
  window.close();
});

const port = chrome.runtime.connect({ name: 'status' });
port.onMessage.addListener((message) => {
  if (message?.type === 'status') render(message);
});

void showPage();
