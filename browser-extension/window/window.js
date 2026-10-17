// A small window for downloading when the toolbar popup can't do it on its
// own: from the right-click menu, the keyboard shortcut, or when the app has
// to be started first. Starts the app if needed, shows the format picker,
// and closes once the download is on its way.
import { DOWNLOAD_PAGE, START_APP_LINK } from '../shared.js';
import { mountPicker } from '../ui/picker.js';

const WAIT_MS = 45 * 1000;
const main = document.getElementById('main');
let params = {};
try {
  params = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
} catch {
  params = {};
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error) }));
}

function statusBox({ title, message, spinner = false, actions = [] }) {
  const box = document.createElement('div');
  box.className = 'status-box';
  if (spinner) {
    const spin = document.createElement('div');
    spin.className = 'spinner';
    box.append(spin);
  }
  const h1 = document.createElement('h1');
  h1.textContent = title;
  box.append(h1);
  if (message) {
    const p = document.createElement('p');
    p.textContent = message;
    box.append(p);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    row.append(...actions);
    box.append(row);
  }
  main.replaceChildren(box);
}

function button(label, onClick, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function getAppLink() {
  const a = document.createElement('a');
  a.className = 'button';
  a.href = DOWNLOAD_PAGE;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Get the app';
  return a;
}

function startApp() {
  // Opening the link (rather than navigating away) keeps this window on screen.
  const a = document.createElement('a');
  a.href = START_APP_LINK;
  document.body.append(a);
  a.click();
  a.remove();
}

async function closeSoon() {
  const win = await chrome.windows.getCurrent();
  setTimeout(() => void chrome.windows.remove(win.id).catch(() => undefined), 1200);
}

/** After the pick: wait until "Save as" is done, then get out of the way. */
function followUntilSaved(requestId) {
  const port = chrome.runtime.connect({ name: 'status' });
  port.onMessage.addListener((status) => {
    const item = (status.items ?? []).find(i => i.requestId === requestId);
    if (!item || ['pick', 'saveAs', 'fetching'].includes(item.state)) return;
    port.disconnect();
    if (item.state === 'cancelled') {
      statusBox({ title: 'Cancelled', message: 'Nothing was downloaded.' });
    } else {
      statusBox({ title: 'Downloading', message: 'Follow it from the extension’s toolbar icon.' });
    }
    void closeSoon();
  });
}

function showPicker() {
  mountPicker(main, {
    url: params.url,
    title: params.title,
    tabId: Number.isInteger(params.tabId) ? params.tabId : undefined,
    onPicked: followUntilSaved,
    onAppMissing: () => void waitForApp(true),
  });
}

async function waitForApp(launch) {
  if (launch) startApp();
  statusBox({
    title: 'Starting Open Video Downloader…',
    message: 'If Chrome asks, click Open Open Video Downloader. Tick Always allow so it starts by itself next time.',
    spinner: true,
  });
  const startedAt = Date.now();
  let helpShown = false;
  for (;;) {
    const app = await send({ type: 'find-app' });
    if (app?.port) {
      showPicker();
      return;
    }
    if (!helpShown && Date.now() - startedAt > WAIT_MS) {
      helpShown = true;
      statusBox({
        title: 'Couldn’t reach Open Video Downloader',
        message: 'Make sure the Save As version of the app is installed. On a Mac, open it once from Applications first.',
        actions: [button('Try again', () => void waitForApp(true), 'primary'), getAppLink()],
      });
    }
    await new Promise(resolve => setTimeout(resolve, helpShown ? 2000 : 1000));
  }
}

if (params.url) {
  const app = await send({ type: 'find-app' });
  if (app?.port) showPicker();
  else void waitForApp(true);
} else {
  statusBox({
    title: 'Get Open Video Downloader (Save As)',
    message: 'This extension sends videos to the Open Video Downloader (Save As) app on your computer. Install it and open it once.',
    actions: [getAppLink()],
  });
}
