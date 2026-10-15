// Talks to the Open Video Downloader (Save As) app on this computer.
// The app listens on 127.0.0.1 only, and only answers this extension.

export const PORTS = [43517, 43518, 43519];
export const APP_ID = 'open-video-downloader-save-as';
export const LINK_SCHEME = 'ovd-save-as';
export const DOWNLOAD_PAGE = 'https://github.com/PocroLoco/youtube-dl-gui-save-as#readme';

export class AppNotRunning extends Error {
  constructor() {
    super('Open Video Downloader is not running');
    this.name = 'AppNotRunning';
  }
}

let knownPort = null;

// Always POST: Chrome only sends the extension's Origin header (which the app
// checks) on POST requests.
async function send(port, path, { body = {}, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Finds the app. Returns { port, version } or null when it isn't running. */
export async function findApp() {
  const order = knownPort ? [knownPort, ...PORTS.filter(p => p !== knownPort)] : PORTS;
  for (const port of order) {
    try {
      const { status, data } = await send(port, '/v1/ping', { timeoutMs: 1500 });
      if (status === 200 && data?.app === APP_ID) {
        knownPort = port;
        return { port, version: data.version };
      }
    } catch {
      // Nothing there, or something else is using the port.
    }
  }
  knownPort = null;
  return null;
}

/** Calls the app. Throws AppNotRunning when it isn't running. */
export async function api(path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = knownPort ?? (await findApp())?.port;
    if (!port) throw new AppNotRunning();
    try {
      const { data } = await send(port, path, { body });
      return data;
    } catch {
      knownPort = null;
    }
  }
  throw new AppNotRunning();
}

/** A link that starts the app (when it's closed) and hands it the download. */
export function downloadLink({ url, requestId, audioOnly }) {
  const params = new URLSearchParams({ url, id: requestId });
  if (audioOnly) params.set('audio', '1');
  return `${LINK_SCHEME}://download?${params}`;
}

export const OPEN_APP_LINK = `${LINK_SCHEME}://open`;

/** Trims a YouTube link down to just the video (no playlist, timestamp, etc.). */
export function cleanVideoUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtube.com') {
    const v = url.searchParams.get('v');
    if (url.pathname === '/watch' && v) return `https://www.youtube.com/watch?v=${v}`;
    const short = url.pathname.match(/^\/(shorts|live)\/([\w-]{6,})/);
    if (short) {
      return short[1] === 'shorts'
        ? `https://www.youtube.com/shorts/${short[2]}`
        : `https://www.youtube.com/watch?v=${short[2]}`;
    }
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (id) return `https://www.youtube.com/watch?v=${id}`;
  }
  return url.toString();
}

/** Pages a download makes no sense for. */
export function isDownloadablePage(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return false;
    return !['chromewebstore.google.com', 'chrome.google.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

export const ACTIVE_STATES = new Set(['fetching', 'saveAs', 'downloading']);
export const FINAL_STATES = new Set(['done', 'error', 'cancelled']);

function formatBytes(bytesPerSecond) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatEta(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/** One line describing where a download is at. */
export function describe(item) {
  switch (item.state) {
    case 'fetching':
      return 'Getting video info…';
    case 'choosing':
      return 'Pick the videos in the app';
    case 'saveAs':
      return 'Choose where to save it…';
    case 'ready':
      return 'Waiting in the app';
    case 'paused':
      return item.percent != null ? `Paused at ${Math.floor(item.percent)}%` : 'Paused';
    case 'downloading': {
      if (item.stage && !['initializing', 'downloading'].includes(item.stage)) return 'Finishing up…';
      const parts = [];
      if (item.total > 1) parts.push(`${item.done ?? 0} of ${item.total}`);
      else if (item.percent != null) parts.push(`${Math.floor(item.percent)}%`);
      if (item.speedBps) parts.push(formatBytes(item.speedBps));
      if (item.etaSecs) parts.push(formatEta(item.etaSecs));
      return parts.join(' · ') || 'Downloading…';
    }
    case 'done':
      return item.fileName ?? (item.total > 1 ? `${item.total} files` : 'Done');
    case 'error':
      return item.error ? `Failed: ${item.error}` : 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}
