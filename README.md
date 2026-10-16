> [!NOTE]
> **This is a fork of [Open Video Downloader](https://github.com/jely2002/youtube-dl-gui) by Jelle Glebbeek** that adds one thing: a browser-style **"Save as"** window.
> Turn on **Download location → Ask where to save each download**, and every download asks where to save it (name, folder, new folder) *before* it starts, then downloads straight there. Playlists ask for a folder.
>
> **Mac download:** grab the `.dmg` from the [Mac build release](../../releases/tag/mac-build). It isn't signed with an Apple developer certificate, so macOS blocks it the first time: click **Done**, then go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**. You only have to do this once.
>
> **Updates are automatic.** The app checks this fork's releases every few hours, installs new versions in the background, and switches over the next time it starts (or right away from the extension's **Restart app** button). Updates are signed, so only builds from this repo get installed.
>
> **Chrome extension (optional):** download without leaving the browser. On a video page (YouTube, Shorts, TikTok, …) click the extension's icon, pick **Video + Audio / Audio only / Video only** and the quality, hit **Download**, then pick where to save it. The icon shows progress; click a finished download to open it. Right-clicking a page or link works too. If the app is closed, the extension starts it in the background.
> To install: in the app, open **Settings → System → Chrome extension** and click **Show folder**. Open `chrome://extensions`, turn on **Developer mode**, and drag that **Chrome Extension** folder onto the page (or click **Load unpacked** and pick it). Loaded from there, the extension updates itself whenever the app updates. The first time it starts the app, Chrome asks to open Open Video Downloader: tick **Always allow** and click **Open**. More in [browser-extension/README.md](browser-extension/README.md).
>
> This fork gets its updates from this repo (never from the original project, which would replace it) and doesn't send crash reports. Everything else below is the original README.

<img src="https://raw.githubusercontent.com/jely2002/youtube-dl-gui/v2.0.0/renderer/img/icon.png" alt="logo" align="left" height="100"/>

# Open Video Downloader (youtube-dl-gui) <br> ![version badge](https://img.shields.io/github/v/release/jely2002/youtube-dl-gui?label=latest-release) ![GitHub](https://img.shields.io/github/license/jely2002/youtube-dl-gui) ![downloads](https://img.shields.io/github/downloads/jely2002/youtube-dl-gui/total) 
[https://jely2002.github.io/youtube-dl-gui](https://jely2002.github.io/youtube-dl-gui)

Open Video Downloader is a simple, cross-platform desktop application that lets you download videos, audio, subtitles and metadata from hundreds of supported websites, not just YouTube.  
It provides an easy-to-use interface around [yt-dlp](https://github.com/yt-dlp/yt-dlp) so you don’t have to touch the command line.


## Features

- **Cross-platform:** works on Windows, macOS and Linux.
- **Audio or video downloads:** grab full videos or extract only the audio track.
- **Subtitles and metadata:** automatically saves available captions and video information.
- **Quality control:** choose your preferred resolution, frame rate, and output format like MP4 or MKV.
- **Playlists:** download entire playlists in one go.
- **Custom output:** set your download location and control filenames using presets or custom templates.
- **Smart queueing:** OVD balances multiple downloads automatically so your computer doesn’t slow down.
- **Authentication:** supports browser cookie files, basic auth and video passwords.
- **Automatic updates:** both the app and yt-dlp are kept up to date automatically.
- **Light and dark mode:** adapts to your system theme with clear progress and error handling.
- **Shortcuts:** queue and download videos using shortcuts, stay up-to-date on progress with notifications.

## Download

The latest versions for **Windows**, **macOS** and **Linux** are available on the  
[GitHub Releases page](https://github.com/jely2002/youtube-dl-gui/releases).

Download the installer or archive for your platform and follow the normal installation steps.  
No command-line setup is required.

#### What file do I download?
| Your Computer                         | Download                                       |
|---------------------------------------|------------------------------------------------|
| **Windows**                           | `Open.Video.Downloader_x.x.x_x64-setup.exe`    |
| **Mac (Intel)**                       | `Open.Video.Downloader_x.x.x_x64.dmg`          |
| **Mac (Apple Silicon – M1, M2 … M5)** | `Open.Video.Downloader_x.x.x_aarch64.dmg`      |
| **Linux generic (x64)**               | `Open.Video.Downloader_x.x.x_amd64.AppImage`   |
| **Linux generic (aarch64)**           | `Open.Video.Downloader_x.x.x_aarch64.AppImage` |
| **Linux Debian/Ubuntu (x64)**         | `Open.Video.Downloader_x.x.x_amd64.deb`        |
| **Linux Debian/Ubuntu (aarch64)**     | `Open.Video.Downloader_x.x.x_arm64.deb`        |
| **Linux Fedora/RHEL (x64)**           | `Open.Video.Downloader_x.x.x-x_amd64.rpm`      |
| **Linux Fedora/RHEL (aarch64)**       | `Open.Video.Downloader_x.x.x-x_aarch64.rpm`    |

#### Download using the command line
Open Video Downloader can be downloaded using command line tools like [Homebrew](https://brew.sh/) on Mac or [WinGet](https://github.com/microsoft/winget-cli) on Windows.

```shell
brew install --cask open-video-downloader
```

```shell
winget install -e --id jely2002.youtube-dl-gui
```

#### Download from the Microsoft Store
Open Video Downloader is available on the Microsoft Store, although we recommend using the GitHub releases download instead.
This is due to updates taking longer to arrive and auto-updating yt-dlp is also not supported.

<a href="https://apps.microsoft.com/detail/9p53s4t9znj5?referrer=appbadge&cid=gh-readme&mode=full" target="_blank"  rel="noopener noreferrer">
	<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" alt="OVD download badge for Microsoft Store"/>
</a>

## How it works

Open Video Downloader uses a front-end built with Vue 3 and a Rust backend powered by [Tauri](https://tauri.app/).  
When you add a video or playlist, the app communicates with yt-dlp to fetch information, process options and start the download.  
The download progress and any errors are displayed in the app.

## Contributing

Developers are welcome to contribute.  
You’ll need Node.js (v24+) and Rust installed.

```
npm install
npm run tauri dev
```

For more details, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License and disclaimer

Open Video Downloader is distributed under the [AGPL-3.0 license](./LICENSE).

#### Use this application responsibly
The maintainers of Open Video Downloader cannot be held liable for misuse of this application, as stated in the AGPL-3.0 license (section 16).  
We do not condone the use of this software to violate local laws or platform terms of service (including the DMCA).  
Users are personally responsible for ensuring they use this software fairly and within legal boundaries.
