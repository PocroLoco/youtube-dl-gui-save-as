// Chrome's side panel, for making a clip: unlike the toolbar popup it stays
// open while you play, pause and scrub the video on the page. Opened from the
// popup when you pick "Clip", for that one tab.
import { finishPendingUpdate } from '../shared.js';
import { mountPicker } from '../ui/picker.js';

const main = document.getElementById('main');
let tabId = null;
let context = null;

function send(message) {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error) }));
}

function button(label, onClick, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function message(title, text, actions = []) {
  const box = document.createElement('div');
  box.className = 'panel-message';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  box.append(h1);
  if (text) {
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    row.append(...actions);
    box.append(row);
  }
  main.classList.remove('picker');
  main.replaceChildren(box);
}

async function closePanel() {
  try {
    if (tabId != null) await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch {
    // Closing below anyway.
  }
  window.close();
}

/** After a pick: once "Save as" is done, offer another clip from the same video. */
function followUntilSaved(requestId) {
  const port = chrome.runtime.connect({ name: 'status' });
  port.onMessage.addListener((status) => {
    const item = (status.items ?? []).find(i => i.requestId === requestId);
    if (!item || ['pick', 'saveAs', 'fetching'].includes(item.state)) return;
    port.disconnect();
    const another = button('Make another clip', () => void showPicker(), 'primary');
    const done = button('Close', () => void closePanel());
    if (item.state === 'cancelled') {
      message('Cancelled', 'Nothing was downloaded.', [another, done]);
    } else {
      message('Downloading your clip', 'Follow it from the extension’s toolbar icon.', [another, done]);
    }
  });
}

async function showPicker() {
  const app = await send({ type: 'find-app' });
  if (!app?.port) {
    message('Open Video Downloader isn’t running', 'Start it, then click the extension icon again.', [button('Close', () => void closePanel())]);
    return;
  }
  if (await finishPendingUpdate((await send({ type: 'status' }))?.info)) {
    message('Finishing an update…', 'Click the extension icon again in a second.');
    return;
  }
  mountPicker(main, {
    url: context.url,
    title: context.title,
    tabId,
    startInClip: true,
    onPicked: followUntilSaved,
    onAppMissing: () => message('Open Video Downloader isn’t running', 'Start it, then click the extension icon again.'),
  });
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id ?? null;
try {
  // The popup says which video (the panel can't always read the tab's address).
  const key = `panel:${tabId}`;
  context = (await chrome.storage.session.get(key))[key] ?? null;
} catch {
  context = null;
}
if (!context?.url && tab?.url) context = { url: tab.url, title: tab.title };
if (context?.url) {
  void showPicker();
} else {
  message('Open a video first', 'Then click the extension icon and pick Clip.', [button('Close', () => void closePanel())]);
}
