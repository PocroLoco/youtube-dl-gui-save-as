# Open Video Downloader (Save As) — Chrome extension

Download what you're watching without leaving the browser. The extension hands
the video to the Open Video Downloader (Save As) app on your computer, which
asks where to save it (name, folder, new folder) and downloads it straight there.

- **YouTube:** a **Download** button next to Like/Share. The arrow next to it has
  **Download audio only**. The button shows progress, then **Open**.
- **Any site:** right-click the page or a link → **Open Video Downloader** →
  **Download this video** / **Download audio only**.
- **Toolbar icon:** progress for everything the app is downloading, and a
  **Download** button for the page you're on. Click a finished download to open
  it, or the folder icon to show it in Finder.
- A notification when a download finishes. Click it to open the file.
- If the app is closed, the extension starts it.

You also need the app: the `.dmg` from the
[Mac build release](https://github.com/PocroLoco/youtube-dl-gui-save-as/releases/tag/mac-build).

## Install

1. Download `Open-Video-Downloader-Save-As_chrome-extension.zip` from the same release and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder.
4. The first time the extension starts the app, Chrome asks to open
   Open Video Downloader. Tick **Always allow** and click **Open**.

Works in Chrome, Edge, Brave and other Chromium browsers.

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
  `/v1/download {url, requestId, audioOnly}`, `/v1/open {id, reveal}`,
  `/v1/show`. Requests must carry `Origin: chrome-extension://aippbfbebemhmeihmjnjfloboankleil`
  (the ID is pinned by the `key` in `manifest.json`).
- When the app isn't running, the extension opens
  `ovd-save-as://download?url=…&id=…` to start it with the download attached.
- Server: `src-tauri/src/bridge/`. App side: `src/stores/bridge.ts`.
