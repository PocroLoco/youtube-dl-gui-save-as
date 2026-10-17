// The format picker: has the app read the video's formats, lets you pick
// Video + Audio / Audio only / Video only and a quality, then hands the pick
// back to the app, which asks where to save it and downloads.
// Used by the toolbar popup and by the small picker window.

import { cleanVideoUrl, formatDuration } from '../shared.js';
import { createClipControls, forgetDraft } from './clip.js';

const TRACKS = [
  { value: 'both', label: 'Video + Audio' },
  { value: 'audio', label: 'Audio only' },
  { value: 'video', label: 'Video only' },
];

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M11 4h2v9.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V4Zm-6 14h14v2H5v-2Z"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error) }));
}

async function lastChoice() {
  try {
    const { lastChoice: saved } = await chrome.storage.local.get('lastChoice');
    return saved ?? null;
  } catch {
    return null;
  }
}

/** The option to start on: what you picked last time, or the closest to it. */
function preselect(options, track, saved) {
  if (!options.length) return null;
  if (!saved || saved.trackType !== track) return options[0];
  if (track === 'audio') {
    if (saved.abr == null) return options[0];
    return options.find(o => o.abr === saved.abr)
      ?? options.find(o => o.abr != null && o.abr <= saved.abr)
      ?? options[0];
  }
  return options.find(o => o.height === saved.height && (o.fps ?? null) === (saved.fps ?? null))
    ?? options.find(o => o.height === saved.height)
    ?? options.find(o => o.height <= saved.height)
    ?? options[0];
}

/**
 * Some videos come without a quality list (a plain video file, or a site
 * that doesn't say). Offer "Best available" so video is still an option,
 * unless it's clearly audio (it lists audio bitrates and no video).
 */
function withVideoFallback(choices) {
  const video = choices?.video ?? [];
  const audio = choices?.audio ?? [{ label: 'Best' }];
  const audioOnlySource = audio.some(option => option.abr != null);
  if (video.length || audioOnlySource) return { video, audio };
  return { video: [{ label: 'Best available' }], audio };
}

/**
 * Shows the picker in `root` for `url`.
 * - tabId: the tab playing the video, so a clip can start "now".
 * - onPicked(requestId): a format was sent to the app.
 * - onAppMissing(): the app isn't running (the host decides how to start it).
 */
export function mountPicker(root, { url, title, tabId, onPicked, onAppMissing }) {
  root.replaceChildren();
  root.classList.add('picker');

  let requestId = null;
  let port = null;
  let saved = null;
  let track = 'both';
  let selected = null;
  let choices = null;
  let fallbackUrl = null;
  let lastRendered = '';
  let destroyed = false;
  let clipControls = null;
  let currentItem = null;
  let goButton = null;
  const draftKey = cleanVideoUrl(url) ?? url;

  const view = el('div', 'picker-view');
  root.append(view);

  function showLoading(message) {
    lastRendered = 'loading';
    const box = el('div', 'picker-message');
    box.append(el('div', 'spinner'), el('div', 'picker-message-title', message));
    if (title) box.append(el('div', 'picker-message-sub', title));
    view.replaceChildren(box);
  }

  function showProblem(heading, detail, { retry = true } = {}) {
    lastRendered = 'problem';
    const box = el('div', 'picker-message');
    box.append(el('div', 'picker-message-title', heading));
    if (detail) box.append(el('div', 'picker-message-sub', detail));
    if (retry) {
      const again = el('button', 'secondary', 'Try again');
      again.type = 'button';
      again.addEventListener('click', () => void start());
      box.append(again);
    }
    view.replaceChildren(box);
  }

  function optionsFor(kind) {
    if (!choices) return [];
    return kind === 'audio' ? choices.audio : choices.video;
  }

  function updateGo() {
    if (!goButton) return;
    goButton.disabled = !selected || !!clipControls?.blocked;
    goButton.lastChild.textContent = clipControls?.on ? 'Download clip' : 'Download';
  }

  /** Clips are for one video; a playlist downloads whole. */
  async function setUpClip(item) {
    if (item.total > 1 || clipControls) return;
    const controls = await createClipControls({ duration: item.duration, tabId, draftKey, onChange: updateGo });
    if (destroyed || lastRendered !== 'pick') return;
    clipControls = controls;
    renderPicker(currentItem ?? item);
  }

  function renderPicker(item) {
    lastRendered = 'pick';
    currentItem = item;
    const card = el('div', 'picker-card');

    // What's being downloaded.
    const head = el('div', 'picker-head');
    const thumb = el('img', 'picker-thumb');
    thumb.alt = '';
    thumb.referrerPolicy = 'no-referrer';
    if (item.thumbnail && /^https:\/\//.test(item.thumbnail)) thumb.src = item.thumbnail;
    else thumb.classList.add('empty');
    thumb.addEventListener('error', () => {
      thumb.removeAttribute('src');
      thumb.classList.add('empty');
    }, { once: true });
    const meta = el('div', 'picker-meta');
    const name = el('div', 'picker-title', item.title ?? title ?? url);
    name.title = name.textContent;
    const subParts = [];
    if (item.total > 1) subParts.push(`${item.total} videos`);
    if (item.uploader) subParts.push(item.uploader);
    if (item.duration && !(item.total > 1)) subParts.push(formatDuration(item.duration));
    meta.append(name, el('div', 'picker-sub', subParts.join(' · ')));
    head.append(thumb, meta);

    // Video + Audio / Audio only / Video only.
    const tracks = el('div', 'segmented');
    tracks.setAttribute('role', 'radiogroup');
    tracks.setAttribute('aria-label', 'What to download');
    for (const option of TRACKS) {
      const button = el('button', option.value === track ? 'active' : '', option.label);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(option.value === track));
      button.disabled = optionsFor(option.value).length === 0;
      button.addEventListener('click', () => {
        if (track === option.value) return;
        const wasAudio = track === 'audio';
        track = option.value;
        if (wasAudio !== (track === 'audio') || !selected) {
          selected = preselect(optionsFor(track), track, saved);
        }
        renderPicker(item);
      });
      tracks.append(button);
    }

    // Quality.
    const qualityLabel = el('div', 'picker-label', track === 'audio' ? 'Audio quality' : 'Quality');
    const qualities = el('div', 'chips');
    qualities.setAttribute('role', 'radiogroup');
    qualities.setAttribute('aria-label', qualityLabel.textContent);
    const options = optionsFor(track);
    for (const option of options) {
      const isOn = option === selected;
      const chip = el('button', isOn ? 'chip active' : 'chip', option.label);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(isOn));
      chip.addEventListener('click', () => {
        selected = option;
        renderPicker(item);
      });
      qualities.append(chip);
    }
    if (!options.length) qualities.append(el('div', 'picker-sub', 'No formats found.'));

    const go = el('button', 'primary download');
    go.type = 'button';
    go.innerHTML = ICON_DOWNLOAD;
    go.append(document.createTextNode('Download'));
    go.addEventListener('click', () => void pick(go));
    goButton = go;
    updateGo();

    card.append(head, tracks, qualityLabel, qualities);
    if (clipControls && !(item.total > 1)) card.append(clipControls.element);
    card.append(go, el('p', 'picker-note', 'You’ll pick where to save it next.'));
    view.replaceChildren(card);
  }

  async function pick(button) {
    if (!selected || !requestId || clipControls?.blocked) return;
    button.disabled = true;
    const choice = {
      trackType: track,
      height: track === 'audio' ? undefined : selected.height,
      fps: track === 'audio' ? undefined : selected.fps,
      abr: track === 'audio' ? selected.abr : undefined,
    };
    const clip = currentItem?.total > 1 ? undefined : clipControls?.value;
    const result = await send({ type: 'choose', requestId, ...choice, clip });
    if (!result?.ok) {
      button.disabled = false;
      showProblem('Couldn’t send it to the app', result?.error);
      return;
    }
    try {
      await chrome.storage.local.set({ lastChoice: choice });
    } catch {
      // Remembering the pick is just a convenience.
    }
    if (clip) forgetDraft(draftKey);
    lastRendered = 'sent';
    const box = el('div', 'picker-message');
    box.append(el('div', 'picker-message-title', 'Choose where to save it'), el('div', 'picker-message-sub', 'Open Video Downloader is asking now.'));
    view.replaceChildren(box);
    onPicked?.(requestId);
  }

  function onStatus(status) {
    if (destroyed || !requestId || lastRendered === 'sent') return;
    if (!status.connected) {
      if (lastRendered !== 'problem') showProblem('Open Video Downloader closed', 'Open it again, then try again.');
      return;
    }
    const items = (status.items ?? []).filter(item => item.requestId === requestId);
    const item = items[0];
    if (!item) return;
    if (item.state === 'pick' && item.choices) {
      if (lastRendered !== 'pick') {
        choices = withVideoFallback(item.choices);
        if (saved?.trackType && optionsFor(saved.trackType).length) track = saved.trackType;
        else if (!choices.video.length) track = 'audio';
        selected = preselect(optionsFor(track), track, saved);
        renderPicker(item);
        void setUpClip(item);
      }
    } else if (item.state === 'error') {
      if (fallbackUrl) {
        // The tidied-up link didn't work; try the page's own link.
        const retryWith = fallbackUrl;
        fallbackUrl = null;
        void start({ url: retryWith, exact: true });
        return;
      }
      if (lastRendered !== 'problem') {
        showProblem('No video found here', item.error ? item.error.replace(/^ERROR:\s*/, '') : 'This page may not have a video Open Video Downloader can get.');
      }
    }
  }

  async function start(target = { url }) {
    showLoading('Getting formats…');
    saved = await lastChoice();
    const result = await send({ type: 'prepare', url: target.url, title, exact: target.exact });
    if (destroyed) return;
    if (result?.needsLaunch) {
      showProblem('Open Video Downloader isn’t running', null, { retry: false });
      onAppMissing?.();
      return;
    }
    if (!result?.ok) {
      showProblem('Couldn’t read this page', result?.error);
      return;
    }
    if (port) port.disconnect();
    requestId = result.requestId;
    if (!target.exact) fallbackUrl = result.fallbackUrl ?? null;
    // While this is open the app keeps the formats; closing it lets the app drop them.
    port = chrome.runtime.connect({ name: `picker:${requestId}` });
    port.onMessage.addListener((message) => {
      if (message?.type === 'status') onStatus(message);
    });
  }

  void start();

  return {
    destroy() {
      destroyed = true;
      port?.disconnect();
      port = null;
    },
    get requestId() {
      return requestId;
    },
  };
}
