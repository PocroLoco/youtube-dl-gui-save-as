//! Connects the app to its browser extension.
//!
//! - A local HTTP server (127.0.0.1 only, extension only) takes download
//!   requests, reports progress and opens finished files.
//! - `ovd-save-as://` links start the app when it's closed and carry the
//!   download along, so the first click still works.
//!
//! Requests from either path land in one queue that the app's window drains.
//! The extension first has the app read the video's formats, lets you pick one
//! in the browser, and the app then asks where to save ("Save as") and
//! downloads straight there.

mod http;
mod state;

pub use state::{
  BridgeChoice, BridgeCommand, BridgeItem, BridgeRequest, BridgeState, EnqueueResult,
};

use http::BridgeHost;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// The extension's ID is pinned with the `key` in its manifest, so this origin
/// is the same on every computer.
pub const ALLOWED_ORIGINS: &[&str] = &["chrome-extension://aippbfbebemhmeihmjnjfloboankleil"];
/// The extension tries these in order, so they must match its list.
pub const PORTS: &[u16] = &[43517, 43518, 43519];
pub const LINK_SCHEME: &str = "ovd-save-as";
pub const PENDING_EVENT: &str = "bridge_pending";

const MAX_URL_LEN: usize = 4096;

/// Only plain web links, so nothing odd ever reaches yt-dlp.
pub fn validate_download_url(raw: &str) -> Option<String> {
  let raw = raw.trim();
  if raw.is_empty() || raw.len() > MAX_URL_LEN {
    return None;
  }
  let url = url::Url::parse(raw).ok()?;
  if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
    return None;
  }
  Some(url.to_string())
}

/// Keeps the extension's request id if it's sane, otherwise makes one.
pub fn normalize_request_id(raw: Option<&str>) -> String {
  match raw {
    Some(id)
      if !id.is_empty()
        && id.len() <= 64
        && id
          .chars()
          .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
    {
      id.to_string()
    }
    _ => uuid::Uuid::new_v4().to_string(),
  }
}

#[derive(Debug, PartialEq)]
pub enum LinkAction {
  Download {
    url: String,
    request_id: String,
    audio_only: bool,
  },
  /// Just start the app, in the background (the extension takes it from there).
  Start,
  Show,
}

/// Understands `ovd-save-as://download?url=…&id=…&audio=1`,
/// `ovd-save-as://start` and `ovd-save-as://open`.
pub fn parse_link(link: &url::Url) -> Option<LinkAction> {
  if link.scheme() != LINK_SCHEME {
    return None;
  }
  match link.host_str().unwrap_or_default() {
    "download" => {
      let mut url = None;
      let mut request_id = None;
      let mut audio_only = false;
      for (key, value) in link.query_pairs() {
        match key.as_ref() {
          "url" => url = Some(value.into_owned()),
          "id" => request_id = Some(value.into_owned()),
          "audio" => audio_only = value == "1" || value == "true",
          _ => {}
        }
      }
      Some(LinkAction::Download {
        url: validate_download_url(&url?)?,
        request_id: normalize_request_id(request_id.as_deref()),
        audio_only,
      })
    }
    "start" => Some(LinkAction::Start),
    "open" | "show" | "" => Some(LinkAction::Show),
    _ => None,
  }
}

fn window_status<R: Runtime>(app: &AppHandle<R>) -> (bool, bool) {
  app
    .get_webview_window("main")
    .map_or((false, false), |window| {
      (
        window.is_visible().unwrap_or(false),
        window.is_focused().unwrap_or(false),
      )
    })
}

/// Handles a deep link the app was opened with.
pub fn handle_link<R: Runtime>(app: &AppHandle<R>, link: &url::Url) {
  match parse_link(link) {
    Some(LinkAction::Download {
      url,
      request_id,
      audio_only,
    }) => {
      let (window_was_visible, window_was_focused) = window_status(app);
      let state = app.state::<BridgeState>();
      if state.enqueue(BridgeRequest {
        request_id,
        url,
        audio_only,
        window_was_visible,
        window_was_focused,
        choose_format: false,
      }) == EnqueueResult::Queued
      {
        let _ = app.emit(PENDING_EVENT, ());
      }
    }
    Some(LinkAction::Start) => {}
    Some(LinkAction::Show) => crate::reopen_window(app),
    None => tracing::warn!("[bridge] ignoring link {link}"),
  }
}

/// True when the app was started by the browser extension (not by you), so it
/// can stay out of sight until there's a "Save as" to show.
pub fn started_in_background<R: Runtime>(app: &AppHandle<R>) -> bool {
  use tauri_plugin_deep_link::DeepLinkExt;
  app
    .try_state::<tauri_plugin_deep_link::DeepLink<R>>()
    .and_then(|_| app.deep_link().get_current().ok().flatten())
    .is_some_and(|links| {
      links.iter().any(|link| {
        matches!(
          parse_link(link),
          Some(LinkAction::Start | LinkAction::Download { .. })
        )
      })
    })
}

/// Checks a format picked in the browser before it reaches the app.
pub fn validate_choice(choice: &BridgeChoice) -> bool {
  let id_ok = normalize_request_id(Some(&choice.request_id)) == choice.request_id;
  let track_ok = matches!(choice.track_type.as_str(), "both" | "audio" | "video");
  let height_ok = choice.height.is_none_or(|h| (1..=10_000).contains(&h));
  let fps_ok = choice
    .fps
    .is_none_or(|f| f.is_finite() && (0.0..=1_000.0).contains(&f));
  let abr_ok = choice
    .abr
    .is_none_or(|a| a.is_finite() && (0.0..=10_000.0).contains(&a));
  id_ok && track_ok && height_ok && fps_ok && abr_ok
}

struct AppBridgeHost<R: Runtime> {
  app: AppHandle<R>,
}

impl<R: Runtime> BridgeHost for AppBridgeHost<R> {
  fn state(&self) -> &BridgeState {
    self.app.state::<BridgeState>().inner()
  }

  fn notify_pending(&self) {
    let _ = self.app.emit(PENDING_EVENT, ());
  }

  fn window_status(&self) -> (bool, bool) {
    window_status(&self.app)
  }

  fn open_path(&self, path: &str, reveal: bool) -> Result<(), String> {
    let opener = self.app.opener();
    let result = if reveal {
      opener.reveal_item_in_dir(path)
    } else {
      opener.open_path(path, None::<&str>)
    };
    result.map_err(|error| error.to_string())
  }

  fn show_window(&self) {
    crate::reopen_window(&self.app);
  }

  fn version(&self) -> String {
    self.app.package_info().version.to_string()
  }

  fn app_info(&self) -> serde_json::Value {
    let update_ready = self
      .app
      .try_state::<crate::auto_update::AutoUpdateState>()
      .and_then(|state| state.installed());
    let extension_version = self
      .app
      .try_state::<crate::extension_files::ExtensionFiles>()
      .and_then(|files| files.version());
    serde_json::json!({
      "version": self.version(),
      "updateReady": update_ready,
      "extensionVersion": extension_version,
    })
  }

  fn restart(&self) {
    let app = self.app.clone();
    // Answer the extension first, then restart.
    std::thread::spawn(move || {
      std::thread::sleep(std::time::Duration::from_millis(400));
      app.restart();
    });
  }

  fn reveal_extension(&self) -> Result<(), String> {
    let folder = self
      .app
      .try_state::<crate::extension_files::ExtensionFiles>()
      .and_then(|files| files.folder())
      .ok_or("The extension isn't bundled with this build.")?;
    self
      .app
      .opener()
      .reveal_item_in_dir(folder)
      .map_err(|error| error.to_string())
  }
}

/// Starts the local server on the first free port. If none is free the
/// extension falls back to links, which still work.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
  for &port in PORTS {
    match tiny_http::Server::http(("127.0.0.1", port)) {
      Ok(server) => {
        tracing::info!("[bridge] listening on 127.0.0.1:{port}");
        let app = app.clone();
        std::thread::Builder::new()
          .name("browser-bridge".into())
          .spawn(move || {
            for request in server.incoming_requests() {
              let app = app.clone();
              std::thread::spawn(move || {
                let host = AppBridgeHost { app };
                http::serve(&host, port, request);
              });
            }
          })
          .ok();
        return;
      }
      Err(error) => tracing::warn!("[bridge] port {port} unavailable: {error}"),
    }
  }
  tracing::warn!("[bridge] no free port; the extension will use links only");
}

/// The app's window picks up waiting browser requests.
#[tauri::command]
pub fn bridge_take_pending(state: tauri::State<'_, BridgeState>) -> Vec<BridgeCommand> {
  state.take_pending()
}

/// The app's window reports what's downloading, for the extension to show.
#[tauri::command]
pub fn bridge_status_set(state: tauri::State<'_, BridgeState>, items: Vec<BridgeItem>) {
  state.set_items(items);
}

/// Brings the app to the front for a "Save as" window, even when it was hidden
/// (macOS keeps a hidden app's windows invisible until the app is unhidden).
#[tauri::command]
pub fn bring_window_forward<R: Runtime>(app: AppHandle<R>) {
  #[cfg(target_os = "macos")]
  {
    let _ = app.show();
  }
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// After "Save as", gets the app out of the way so you're back in the browser.
/// `hide_window` is for when the window wasn't open before the request.
#[tauri::command]
pub fn bridge_step_back<R: Runtime>(app: AppHandle<R>, hide_window: bool) {
  let Some(window) = app.get_webview_window("main") else {
    return;
  };
  if hide_window {
    let _ = window.hide();
  }
  #[cfg(target_os = "macos")]
  {
    // Like Cmd+H: macOS brings back the app you were using.
    let _ = app.hide();
  }
  #[cfg(not(target_os = "macos"))]
  if !hide_window {
    let _ = window.minimize();
  }
}

#[cfg(test)]
mod tests;
