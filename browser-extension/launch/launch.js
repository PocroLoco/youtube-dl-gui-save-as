import { DOWNLOAD_PAGE, LINK_SCHEME, findApp } from '../shared.js';

const WAIT_MS = 45 * 1000;
const $ = id => document.getElementById(id);

const target = decodeURIComponent(location.hash.slice(1));
const link = target.startsWith(`${LINK_SCHEME}://`) ? target : null;
$('get-app').href = DOWNLOAD_PAGE;

function openLink() {
  if (!link) return;
  // Clicking a link (rather than navigating away) keeps this page on screen.
  const a = document.createElement('a');
  a.href = link;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showHelp(title, message) {
  $('title').textContent = title;
  $('message').textContent = message;
  $('spinner').hidden = true;
  $('actions').hidden = false;
  $('retry').hidden = !link;
  $('hint').hidden = false;
}

async function closeSelf() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.openerTabId != null) {
    await chrome.tabs.update(tab.openerTabId, { active: true }).catch(() => undefined);
  }
  if (tab?.id != null) await chrome.tabs.remove(tab.id);
}

let watching = false;

/** Waits for the app to answer, then gets out of the way. Keeps waiting after
 * showing help, so installing or opening the app by hand still finishes up. */
async function waitForApp() {
  if (watching) return;
  watching = true;
  const startedAt = Date.now();
  let helpShown = false;
  for (;;) {
    if (await findApp()) {
      $('title').textContent = link ? 'Connected' : 'You’re all set';
      $('message').textContent = link
        ? 'Open Video Downloader is taking it from here.'
        : 'Open Video Downloader is running. Use the Download button on YouTube, or right-click any page.';
      $('spinner').hidden = true;
      $('actions').hidden = true;
      $('hint').hidden = true;
      if (link) setTimeout(() => void closeSelf(), 900);
      return;
    }
    if (!helpShown && Date.now() - startedAt > WAIT_MS) {
      helpShown = true;
      showHelp(
        'Couldn’t reach Open Video Downloader',
        'Make sure the Save As version of the app is installed, then try again.',
      );
    }
    await new Promise(resolve => setTimeout(resolve, helpShown ? 2000 : 1000));
  }
}

$('retry').addEventListener('click', () => {
  $('title').textContent = 'Starting Open Video Downloader…';
  $('message').textContent = 'If Chrome asks, click Open Open Video Downloader.';
  $('spinner').hidden = false;
  $('actions').hidden = true;
  openLink();
});

if (link) {
  openLink();
  void waitForApp();
} else {
  void waitForApp();
  showHelp(
    'Get Open Video Downloader (Save As)',
    'This extension sends videos to the Open Video Downloader (Save As) app on your computer. Install it, open it once, and the Download button starts working.',
  );
}
