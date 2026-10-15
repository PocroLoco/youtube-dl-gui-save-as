// Adds a "Download" button next to Like/Share on YouTube. Clicking it sends the
// video to the Open Video Downloader (Save As) app, which asks where to save it
// and downloads it there. The button then shows progress and opens the file.
(() => {
  if (window.__ovdSaveAsButton) return;
  window.__ovdSaveAsButton = true;

  const HOST_ID = 'ovd-save-as-download';
  const LAUNCH_TIMEOUT_MS = 30 * 1000;
  const FINAL = new Set(['done', 'error', 'cancelled']);
  const ACTIVE = new Set(['fetching', 'saveAs', 'downloading']);

  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11 4h2v9.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V4Zm-6 14h14v2H5v-2Z"/></svg>';
  const ICON_DONE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z"/></svg>';
  const ICON_ERROR = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11 7h2v6h-2V7Zm0 8h2v2h-2v-2Zm1-13a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"/></svg>';
  const ICON_CHEVRON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5H7Z"/></svg>';

  const STYLE = `
    :host { all: initial; }
    .wrap { position: relative; display: inline-flex; font-family: "Roboto", "Arial", sans-serif; }
    button {
      all: unset;
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      line-height: 36px;
      white-space: nowrap;
      color: var(--yt-spec-text-primary, #0f0f0f);
      background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.05));
    }
    button:hover { background: var(--yt-spec-button-chip-background-hover, rgba(0, 0, 0, 0.1)); }
    button:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
    .main { padding: 0 14px 0 12px; border-radius: 18px 0 0 18px; max-width: 260px; }
    .more { padding: 0 8px 0 6px; border-radius: 0 18px 18px 0; border-left: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1)); }
    .solo .main { border-radius: 18px; padding-right: 16px; }
    .solo .more { display: none; }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 0;
      background: rgba(62, 166, 255, 0.28);
      transition: width 0.4s ease;
      pointer-events: none;
    }
    .label { position: relative; overflow: hidden; text-overflow: ellipsis; }
    .icon { position: relative; display: inline-flex; }
    .done .icon { color: #2ba640; }
    .error .icon { color: #e53935; }
    .spin .icon { animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .menu {
      position: absolute;
      top: 42px;
      right: 0;
      z-index: 2300;
      min-width: 190px;
      padding: 8px 0;
      border-radius: 12px;
      background: var(--yt-spec-menu-background, #fff);
      box-shadow: 0 4px 32px rgba(0, 0, 0, 0.1), 0 0 0 1px var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
    }
    .menu[hidden] { display: none; }
    .menu button {
      display: flex;
      width: 100%;
      height: 36px;
      padding: 0 16px;
      border-radius: 0;
      background: transparent;
      font-weight: 400;
    }
    .menu button:hover { background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1)); }
    :host(.floating) .wrap { box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); border-radius: 18px; }
    :host(.floating) button { background: var(--yt-spec-base-background, #fff); }
  `;

  let host = null;
  let parts = null;
  let port = null;
  let firstMissingAt = 0;
  let placeTimer = null;
  // What this tab sent, by video link: { requestId, phase, sentAt, error }.
  const sent = new Map();
  let statusItems = [];

  function videoUrl() {
    const url = new URL(location.href);
    const v = url.searchParams.get('v');
    if (url.pathname === '/watch' && v) return `https://www.youtube.com/watch?v=${v}`;
    const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (shorts) return `https://www.youtube.com/shorts/${shorts[1]}`;
    const live = url.pathname.match(/^\/live\/([\w-]{6,})/);
    if (live) return `https://www.youtube.com/watch?v=${live[1]}`;
    return null;
  }

  function videoTitle() {
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim() || undefined;
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error) }));
  }

  // ---------- Where the button goes ----------

  function visible(element) {
    return !!element && element.getClientRects().length > 0;
  }

  function findSpot() {
    const candidates = [
      ...document.querySelectorAll('ytd-watch-metadata #top-level-buttons-computed'),
      ...document.querySelectorAll('#above-the-fold #top-level-buttons-computed'),
      ...document.querySelectorAll('ytd-video-primary-info-renderer #top-level-buttons-computed'),
    ];
    const row = candidates.find(visible);
    if (row) return { parent: row, insert: () => row.append(host) };
    const actions = [...document.querySelectorAll('ytd-watch-metadata #actions-inner, ytd-watch-metadata #actions')].find(visible);
    if (actions) return { parent: actions, insert: () => actions.prepend(host) };
    return null;
  }

  function place() {
    const url = videoUrl();
    if (!url) {
      host?.remove();
      return;
    }
    if (!host) build();

    const spot = location.pathname.startsWith('/shorts/') ? null : findSpot();
    if (spot) {
      firstMissingAt = 0;
      host.classList.remove('floating');
      host.style.cssText = 'display:inline-flex;align-items:center;margin-left:8px;flex:none;';
      if (host.parentElement !== spot.parent) spot.insert();
    } else {
      firstMissingAt ||= Date.now();
      // YouTube is still drawing the page; give it a moment before floating.
      const shouldFloat = location.pathname.startsWith('/shorts/') || Date.now() - firstMissingAt > 4000;
      if (shouldFloat && (!host.isConnected || !host.classList.contains('floating'))) {
        host.classList.add('floating');
        host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483000;display:inline-flex;';
        document.body.append(host);
      }
    }
    render();
  }

  function schedulePlace() {
    if (placeTimer) return;
    placeTimer = setTimeout(() => {
      placeTimer = null;
      place();
    }, 250);
  }

  // ---------- The button ----------

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <button class="main" type="button">
          <span class="fill"></span>
          <span class="icon"></span>
          <span class="label">Download</span>
        </button>
        <button class="more" type="button" aria-haspopup="menu" aria-label="More download options">${ICON_CHEVRON}</button>
        <div class="menu" role="menu" hidden></div>
      </div>`;
    parts = {
      wrap: shadow.querySelector('.wrap'),
      main: shadow.querySelector('.main'),
      more: shadow.querySelector('.more'),
      fill: shadow.querySelector('.fill'),
      icon: shadow.querySelector('.icon'),
      label: shadow.querySelector('.label'),
      menu: shadow.querySelector('.menu'),
    };
    parts.main.addEventListener('click', onMainClick);
    parts.more.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    document.addEventListener('click', (event) => {
      if (!event.composedPath().includes(host)) closeMenu();
    }, true);
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  /** The app's view of the current video, if it has one. */
  function currentItem() {
    const url = videoUrl();
    const mine = sent.get(url);
    if (mine) {
      const items = statusItems.filter(item => item.requestId === mine.requestId);
      if (items.length) return items[0];
    }
    return statusItems.find(item => item.url === url && item.state !== 'cancelled');
  }

  function view() {
    const url = videoUrl();
    const mine = sent.get(url);
    const item = currentItem();

    if (mine?.phase === 'sending') return { label: 'Sending…', spin: true };
    if (mine?.phase === 'not-found') return { label: 'Get the app', kind: 'error', title: 'Open Video Downloader (Save As) didn’t answer. Click for help.' };
    if (mine?.phase === 'failed') return { label: 'Failed — retry', kind: 'error', title: mine.error };
    if (!item) {
      if (mine?.phase === 'starting') return { label: 'Starting app…', spin: true };
      if (mine && !mine.final) return { label: 'Sending…', spin: true };
      return { label: 'Download', title: 'Download with Open Video Downloader' };
    }

    switch (item.state) {
      case 'fetching':
        return { label: 'Preparing…', spin: true };
      case 'saveAs':
        return { label: 'Choose where to save…', spin: true, title: 'Pick a name and folder in the window that opened' };
      case 'choosing':
        return { label: 'Finish in the app', title: 'Open Video Downloader needs you to pick videos' };
      case 'ready':
        return { label: 'Waiting in app' };
      case 'paused':
        return { label: 'Paused', percent: item.percent };
      case 'downloading': {
        if (item.stage && !['initializing', 'downloading'].includes(item.stage)) return { label: 'Finishing…', spin: true, percent: 100 };
        const pct = item.percent != null ? Math.floor(item.percent) : null;
        const label = item.total > 1 ? `${item.done ?? 0} of ${item.total}` : pct != null ? `${pct}%` : 'Downloading…';
        return { label, percent: item.percent, title: 'Downloading — click to see it in the app' };
      }
      case 'done':
        return item.hasFile
          ? { label: item.total > 1 ? 'Show files' : 'Open', kind: 'done', title: item.fileName ?? 'Open the downloaded file' }
          : { label: 'Downloaded', kind: 'done' };
      case 'error':
        return { label: 'Failed — retry', kind: 'error', title: item.error ?? 'The download failed' };
      default:
        return { label: 'Download' };
    }
  }

  function render() {
    if (!parts) return;
    const v = view();
    parts.label.textContent = v.label;
    parts.main.title = v.title ?? '';
    parts.icon.innerHTML = v.kind === 'done' ? ICON_DONE : v.kind === 'error' ? ICON_ERROR : ICON_DOWNLOAD;
    parts.wrap.classList.toggle('done', v.kind === 'done');
    parts.wrap.classList.toggle('error', v.kind === 'error');
    parts.wrap.classList.toggle('spin', !!v.spin);
    parts.fill.style.width = v.percent != null ? `${Math.min(100, v.percent)}%` : '0';
    if (!parts.menu.hidden) fillMenu();
  }

  function menuItems() {
    const item = currentItem();
    if (item && ACTIVE.has(item.state)) {
      return [['See it in the app', () => send({ type: 'show-app' })]];
    }
    if (item?.state === 'done' && item.hasFile) {
      return [
        ['Open', () => send({ type: 'open', id: item.id, reveal: item.total > 1 })],
        ['Show in folder', () => send({ type: 'open', id: item.id, reveal: true })],
        ['Download again', () => startDownload(false)],
        ['Download audio only', () => startDownload(true)],
      ];
    }
    return [
      ['Download video', () => startDownload(false)],
      ['Download audio only', () => startDownload(true)],
    ];
  }

  function fillMenu() {
    parts.menu.replaceChildren(
      ...menuItems().map(([label, action]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.textContent = label;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          closeMenu();
          void action();
        });
        return button;
      }),
    );
  }

  function toggleMenu() {
    if (parts.menu.hidden) {
      fillMenu();
      parts.menu.hidden = false;
      parts.menu.querySelector('button')?.focus();
    } else {
      closeMenu();
    }
  }

  function closeMenu() {
    if (parts && !parts.menu.hidden) parts.menu.hidden = true;
  }

  async function onMainClick() {
    closeMenu();
    const mine = sent.get(videoUrl());
    if (mine?.phase === 'not-found') {
      await send({ type: 'help' });
      return;
    }
    const item = currentItem();
    if (item?.state === 'done' && item.hasFile) {
      await send({ type: 'open', id: item.id, reveal: item.total > 1 });
    } else if (item && !FINAL.has(item.state)) {
      await send({ type: 'show-app' });
    } else if (mine && !mine.final && mine.phase !== 'failed') {
      // Already on its way.
    } else {
      await startDownload(false);
    }
  }

  // ---------- Sending ----------

  function openLink(link) {
    // Opened from this page, right after your click, so Chrome can offer
    // "Always allow www.youtube.com to open links of this type".
    const a = document.createElement('a');
    a.href = link;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function startDownload(audioOnly) {
    const url = videoUrl();
    if (!url) return;
    const entry = { phase: 'sending', sentAt: Date.now(), final: false };
    sent.set(url, entry);
    render();

    const result = await send({ type: 'download', url, title: videoTitle(), audioOnly });
    if (result?.ok) {
      entry.requestId = result.requestId;
      entry.phase = 'sent';
    } else if (result?.needsLaunch) {
      entry.requestId = result.requestId;
      entry.phase = 'starting';
      openLink(result.link);
    } else {
      entry.phase = 'failed';
      entry.error = result?.error ?? 'Couldn’t reach the extension';
      entry.final = true;
    }
    render();
    watch();
  }

  // ---------- Following progress ----------

  function needsWatching() {
    const url = videoUrl();
    const mine = sent.get(url);
    const item = currentItem();
    if (item) return !FINAL.has(item.state);
    return !!mine && !mine.final;
  }

  function onStatus(status) {
    statusItems = status.items ?? [];
    const now = Date.now();
    for (const entry of sent.values()) {
      if (entry.final || !entry.requestId) continue;
      const items = statusItems.filter(item => item.requestId === entry.requestId);
      if (items.length && items.every(item => FINAL.has(item.state))) {
        entry.final = true;
        if (items.every(item => item.state === 'cancelled')) entry.phase = 'cancelled';
      } else if (!items.length && entry.phase === 'starting' && now - entry.sentAt > LAUNCH_TIMEOUT_MS) {
        entry.phase = 'not-found';
        entry.final = true;
      }
    }
    // A cancelled "Save as" puts the button back the way it was.
    for (const [url, entry] of sent) {
      if (entry.phase === 'cancelled') sent.delete(url);
    }
    render();
    if (!needsWatching()) unwatch();
  }

  function watch() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'status' });
    } catch {
      return;
    }
    port.onMessage.addListener((message) => {
      if (message?.type === 'status') onStatus(message);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker restarted; pick the thread back up.
      if (needsWatching()) setTimeout(watch, 1000);
    });
  }

  function unwatch() {
    if (!port) return;
    const old = port;
    port = null;
    old.disconnect();
  }

  async function checkOnce() {
    const status = await send({ type: 'status' });
    if (status && 'items' in status) onStatus(status);
    if (needsWatching()) watch();
  }

  // ---------- Keeping up with YouTube's page changes ----------

  document.addEventListener('yt-navigate-finish', () => {
    closeMenu();
    firstMissingAt = 0;
    place();
    void checkOnce();
  });
  new MutationObserver(() => {
    if (!host || !host.isConnected) {
      schedulePlace();
    } else if (host.classList.contains('floating') && !location.pathname.startsWith('/shorts/')) {
      schedulePlace();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  place();
  void checkOnce();
})();
