// "Whole video / Clip" in the picker: pick a start and an end (type them,
// drag the slider, or grab where the video on the page is right now), and
// only that part gets downloaded.

const DEFAULT_LENGTH = 60;
const DRAFT_PREFIX = 'clip:';
// Long enough to scrub to the end you want; not so long that a video you
// come back to later opens with an old clip.
const DRAFT_TTL_MS = 30 * 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 754 → "12:34", 3723 → "1:02:03". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "12:34", "1:02:03", "754" or "12m34s" → seconds; null if it isn't a time. */
export function parseClock(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return null;
  const units = value.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// ---------- The video on the page ----------
// These run inside the page (only after you clicked the extension, so Chrome
// lets it), and only read or move the video player.

function pageVideoInfo() {
  const area = (video) => {
    const box = video.getBoundingClientRect();
    return box.width * box.height;
  };
  const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 || v.currentTime > 0);
  if (!videos.length) return null;
  const playing = videos.filter(v => !v.paused && !v.ended);
  const pool = playing.length ? playing : videos;
  const video = pool.reduce((best, next) => (area(next) > area(best) ? next : best));
  return {
    current: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  };
}

function pagePreview(start, end) {
  const area = (video) => {
    const box = video.getBoundingClientRect();
    return box.width * box.height;
  };
  const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 || v.currentTime > 0);
  if (!videos.length) return false;
  const playing = videos.filter(v => !v.paused && !v.ended);
  const pool = playing.length ? playing : videos;
  const video = pool.reduce((best, next) => (area(next) > area(best) ? next : best));

  const previous = window.__ovdClipPreview;
  if (previous) previous.video.removeEventListener('timeupdate', previous.stop);
  // Pause when the clip's end is reached (but not if you jumped past it yourself).
  const stop = () => {
    if (video.currentTime >= end && video.currentTime < end + 1.5) {
      video.pause();
      video.removeEventListener('timeupdate', stop);
    }
  };
  video.currentTime = start;
  video.addEventListener('timeupdate', stop);
  window.__ovdClipPreview = { video, stop };
  void video.play()?.catch?.(() => undefined);
  return true;
}

async function runInTab(tabId, func, args = []) {
  if (tabId == null || !chrome.scripting) return null;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return result?.result ?? null;
  } catch {
    // Not allowed on this page (or the tab is gone).
    return null;
  }
}

// ---------- Remembering the clip while you scrub the video ----------

async function loadDraft(key) {
  try {
    const stored = await chrome.storage.session.get(DRAFT_PREFIX + key);
    const draft = stored[DRAFT_PREFIX + key];
    return draft && Date.now() - (draft.at ?? 0) < DRAFT_TTL_MS ? draft : null;
  } catch {
    return null;
  }
}

function saveDraft(key, draft) {
  try {
    void chrome.storage.session.set({ [DRAFT_PREFIX + key]: draft }).catch(() => undefined);
  } catch {
    // Only a convenience.
  }
}

export function forgetDraft(key) {
  try {
    void chrome.storage.session.remove(DRAFT_PREFIX + key).catch(() => undefined);
  } catch {
    // Only a convenience.
  }
}

/**
 * The clip controls. `duration` is the video's length if known; `tabId` is
 * the tab playing it (for "Now" and "Preview"). onChange() fires whenever
 * the clip, or whether it's on, changes.
 */
export async function createClipControls({ duration, tabId, draftKey, onChange }) {
  const [pageVideo, draft] = await Promise.all([
    runInTab(tabId, pageVideoInfo),
    draftKey ? loadDraft(draftKey) : null,
  ]);
  const length = duration || pageVideo?.duration || null;
  const hasPage = !!pageVideo;

  const clip = { on: false, start: 0, end: length ? Math.min(length, DEFAULT_LENGTH) : DEFAULT_LENGTH };
  if (draft && Number.isFinite(draft.start) && Number.isFinite(draft.end)) {
    Object.assign(clip, { on: !!draft.on, start: draft.start, end: draft.end });
  }
  let problem = null;

  const root = el('div', 'clip');

  // Whole video / Clip.
  const toggle = el('div', 'segmented two');
  toggle.setAttribute('role', 'radiogroup');
  toggle.setAttribute('aria-label', 'How much to download');
  const wholeButton = el('button', '', 'Whole video');
  const clipButton = el('button', '', 'Clip');
  for (const button of [wholeButton, clipButton]) {
    button.type = 'button';
    button.setAttribute('role', 'radio');
    toggle.append(button);
  }

  // Start → End.
  const body = el('div', 'clip-body');
  const times = el('div', 'clip-times');
  const field = (label, which) => {
    const box = el('div', 'clip-field');
    const caption = el('label', 'picker-label', label);
    const row = el('div', 'clip-input-row');
    const input = el('input', 'time');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.id = `clip-${which}`;
    input.setAttribute('aria-label', `${label} time`);
    caption.htmlFor = input.id;
    row.append(input);
    let now = null;
    if (hasPage) {
      now = el('button', 'now', 'Now');
      now.type = 'button';
      now.title = `${label} where the video is right now`;
      row.append(now);
    }
    box.append(caption, row);
    return { box, input, now };
  };
  const startField = field('Start', 'start');
  const endField = field('End', 'end');
  times.append(startField.box, el('span', 'clip-arrow', '→'), endField.box);

  // The slider (only when the length is known).
  const range = el('div', 'range');
  const track = el('div', 'range-track');
  const fill = el('div', 'range-fill');
  track.append(fill);
  const low = el('input', 'range-low');
  const high = el('input', 'range-high');
  for (const [input, label] of [[low, 'Clip start'], [high, 'Clip end']]) {
    input.type = 'range';
    input.min = '0';
    input.max = String(Math.ceil(length ?? 0));
    input.step = '1';
    input.setAttribute('aria-label', label);
  }
  range.append(track, low, high);
  range.hidden = !length;

  const foot = el('div', 'clip-foot');
  const summary = el('span', 'clip-length');
  foot.append(summary);
  if (hasPage) {
    const preview = el('button', 'link', '▶ Preview on the page');
    preview.type = 'button';
    preview.addEventListener('click', () => {
      if (!problem) void runInTab(tabId, pagePreview, [clip.start, clip.end]);
    });
    foot.append(preview);
  }

  body.append(times, range, foot);
  root.append(toggle, body);

  function check() {
    if (clip.start == null || clip.end == null) return 'Type a time like 1:30 or 1:02:03.';
    if (length && clip.start >= length) return `The video is only ${formatClock(length)} long.`;
    if (clip.end <= clip.start) return 'The end has to come after the start.';
    return null;
  }

  function render({ typing } = {}) {
    wholeButton.classList.toggle('active', !clip.on);
    clipButton.classList.toggle('active', clip.on);
    wholeButton.setAttribute('aria-checked', String(!clip.on));
    clipButton.setAttribute('aria-checked', String(clip.on));
    body.hidden = !clip.on;

    problem = check();
    if (typing !== 'start') startField.input.value = clip.start == null ? startField.input.value : formatClock(clip.start);
    if (typing !== 'end') endField.input.value = clip.end == null ? endField.input.value : formatClock(clip.end);
    const badStart = clip.start == null || (!!length && clip.start >= length);
    startField.input.classList.toggle('invalid', badStart);
    endField.input.classList.toggle('invalid', clip.end == null || (!badStart && !!problem));

    if (length && clip.start != null && clip.end != null) {
      low.value = String(Math.floor(clip.start));
      high.value = String(Math.ceil(Math.min(clip.end, length)));
      range.style.setProperty('--lo', String(Math.min(1, clip.start / length)));
      range.style.setProperty('--hi', String(Math.min(1, clip.end / length)));
      // When both handles meet at the end, keep the start one on top so it can move.
      low.style.zIndex = clip.start > length - 2 ? '3' : '1';
    }
    summary.classList.toggle('problem', !!problem);
    summary.textContent = problem ?? `${formatClock(clip.end - clip.start)} clip`;
  }

  function changed(options) {
    if (clip.on && clip.start != null && clip.end != null && length) {
      clip.end = Math.min(clip.end, length);
    }
    render(options);
    if (draftKey) saveDraft(draftKey, { on: clip.on, start: clip.start, end: clip.end, at: Date.now() });
    onChange?.();
  }

  wholeButton.addEventListener('click', () => {
    clip.on = false;
    changed();
  });
  clipButton.addEventListener('click', async () => {
    if (clip.on) return;
    clip.on = true;
    // Starting fresh: begin where the video is now.
    if (!draft && !clip.touched) {
      const info = await runInTab(tabId, pageVideoInfo);
      const from = info ? Math.floor(info.current) : 0;
      const start = length ? Math.min(from, Math.max(0, Math.floor(length) - 1)) : from;
      clip.start = start;
      clip.end = length ? Math.min(length, start + DEFAULT_LENGTH) : start + DEFAULT_LENGTH;
    }
    clip.touched = true;
    changed();
  });

  for (const [fieldInfo, key] of [[startField, 'start'], [endField, 'end']]) {
    fieldInfo.input.addEventListener('input', () => {
      clip[key] = parseClock(fieldInfo.input.value);
      clip.touched = true;
      changed({ typing: key });
    });
    fieldInfo.input.addEventListener('change', () => changed());
    fieldInfo.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') fieldInfo.input.blur();
    });
    fieldInfo.now?.addEventListener('click', async () => {
      const info = await runInTab(tabId, pageVideoInfo);
      if (!info) return;
      clip[key] = key === 'start' ? Math.floor(info.current) : Math.ceil(info.current);
      clip.touched = true;
      changed();
    });
  }

  low.addEventListener('input', () => {
    clip.start = Math.min(Number(low.value), (clip.end ?? length) - 1);
    clip.touched = true;
    changed();
  });
  high.addEventListener('input', () => {
    clip.end = Math.max(Number(high.value), (clip.start ?? 0) + 1);
    clip.touched = true;
    changed();
  });

  render();

  return {
    element: root,
    /** The clip to download, or undefined for the whole video. */
    get value() {
      return clip.on && !problem ? { start: clip.start, end: clip.end } : undefined;
    },
    get on() {
      return clip.on;
    },
    /** Clip is on but the times don't make sense yet. */
    get blocked() {
      return clip.on && !!problem;
    },
  };
}
