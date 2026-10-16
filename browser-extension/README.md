# Open Video Downloader (Save As) — Chrome extension

Download what you're watching without leaving the browser. The extension hands
the video to the Open Video Downloader (Save As) app on your computer, which
does the actual downloading.

1. On a video page, click the extension's icon.
2. Pick **Video + Audio**, **Audio only** or **Video only**, and the quality.
   The choices are the video's real formats, same as in the app.
3. Click **Download**, then pick where to save it (name, folder, new folder).

- Works on YouTube (videos and Shorts), TikTok, Instagram, X, Vimeo, Reddit and
  the other sites the app supports. On other sites, click **Find video on this page**.
- The icon shows progress. Click a finished download to open it, or the folder
  icon to show it in Finder. You also get a notification when it's done.
- Right-click a page or a link → **Download with Open Video Downloader**.
- If the app is closed, the extension starts it in the background; you only see
  it for the "Save as" window.
- It remembers your last format.

You also need the app: the `.dmg` from the
[Mac build release](https://github.com/PocroLoco/youtube-dl-gui-save-as/releases/tag/mac-build).

## Install (once)

1. In the app, open **Settings → System → Chrome extension** and click **Show folder**.
   It opens the **Chrome Extension** folder the app keeps up to date.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Drag the **Chrome Extension** folder onto that page (or click **Load unpacked**
   and pick it).
4. Pin it: click the puzzle icon in Chrome's toolbar, then the pin next to it.
5. The first time the extension starts the app, Chrome asks to open
   Open Video Downloader. Tick **Always allow** and click **Open**.

Works in Chrome, Edge, Brave and other Chromium browsers.

## Updates

Nothing to do. The app updates itself in the background and carries the
extension's newest files; the extension notices and reloads itself. If you
loaded the extension from somewhere else (like a zip from the release), the
popup says so and shows you the right folder to load instead.

## Privacy and security

- The extension only talks to the app on your own computer (127.0.0.1). Nothing
  goes to any server.
- The app only answers this extension: it checks the browser-set `Origin`
  header, which websites can't fake, so web pages can't start downloads or see
  what you download.
- To open a file, the extension names a download and the app looks up the path
  itself. File paths never reach the browser.

## How it connects (for developers)

- The app runs a small HTTP server on `127.0.0.1:43517` (falls back to 43518,
  43519). Every call is a `POST` with JSON: `/v1/ping`, `/v1/status`,
  `/v1/download {url, requestId, chooseFormat}` (reads the formats; they show
  up in `/v1/status`), `/v1/choose {requestId, trackType, height, fps, abr}`,
  `/v1/cancel {requestId}`, `/v1/open {id, reveal}`, `/v1/show`. Requests must carry `Origin: chrome-extension://aippbfbebemhmeihmjnjfloboankleil`
  (the ID is pinned by the `key` in `manifest.json`).
- When the app isn't running, the extension opens `ovd-save-as://start` to
  start it in the background.
- Server: `src-tauri/src/bridge/`. App side: `src/stores/bridge.ts`.
