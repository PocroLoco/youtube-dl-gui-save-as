use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;

/// Requests waiting for the app's window to pick them up. More than this and
/// new ones are refused, so a runaway client can't pile up work.
const MAX_PENDING: usize = 50;
/// How many request ids are remembered to drop duplicates (a deep link and an
/// HTTP retry for the same click, for example).
const MAX_SEEN: usize = 200;
/// The app only reports this many downloads to the extension.
const MAX_ITEMS: usize = 50;

/// A download the browser asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
  pub request_id: String,
  pub url: String,
  #[serde(default)]
  pub audio_only: bool,
  /// Whether the app's window was on screen / in front when the request came
  /// in. If it wasn't, the app steps back out of the way after "Save as".
  #[serde(default)]
  pub window_was_visible: bool,
  #[serde(default)]
  pub window_was_focused: bool,
  /// Get the video's formats and wait for the browser to pick one, instead of
  /// downloading with the app's current settings.
  #[serde(default)]
  pub choose_format: bool,
}

/// The format picked in the browser for a download that was waiting on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeChoice {
  pub request_id: String,
  /// "both", "audio" or "video", like the app's own track picker.
  pub track_type: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub height: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fps: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub abr: Option<f64>,
}

/// The browser closed the format picker without downloading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCancel {
  pub request_id: String,
}

/// Work for the app's window, in the order it arrived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeCommand {
  Download(BridgeRequest),
  Choose(BridgeChoice),
  Cancel(BridgeCancel),
}

/// One download as the extension sees it. The app's window fills these in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeItem {
  pub id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub request_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub thumbnail: Option<String>,
  pub state: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stage: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub percent: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub speed_bps: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub eta_secs: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub done: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub total: Option<u32>,
  /// Where the file ended up. Never sent to the browser: the extension asks the
  /// app to open an item by id, and the app looks the path up here.
  #[serde(default, skip_serializing)]
  pub path: Option<String>,
  #[serde(default)]
  pub has_file: bool,
  /// Just the file's name, for display.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file_name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub duration: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub uploader: Option<String>,
  /// Still in the browser's picker (not a real download yet): the popup's
  /// download list leaves these out.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub pending: bool,
  /// While waiting for the browser: the formats to pick from.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub choices: Option<serde_json::Value>,
}

#[derive(Default)]
struct Inner {
  pending: VecDeque<BridgeCommand>,
  seen: VecDeque<String>,
  items: Vec<BridgeItem>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnqueueResult {
  Queued,
  Duplicate,
  Full,
}

/// Shared between the local HTTP bridge, deep links and the app's window.
#[derive(Default)]
pub struct BridgeState {
  inner: Mutex<Inner>,
}

impl BridgeState {
  fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
    self
      .inner
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  pub fn enqueue(&self, request: BridgeRequest) -> EnqueueResult {
    let mut inner = self.lock();
    if inner.seen.iter().any(|id| id == &request.request_id) {
      return EnqueueResult::Duplicate;
    }
    if inner.pending.len() >= MAX_PENDING {
      return EnqueueResult::Full;
    }
    inner.seen.push_back(request.request_id.clone());
    while inner.seen.len() > MAX_SEEN {
      inner.seen.pop_front();
    }
    inner.pending.push_back(BridgeCommand::Download(request));
    EnqueueResult::Queued
  }

  /// Queues a format choice or a cancel for a download already sent.
  pub fn push_command(&self, command: BridgeCommand) -> EnqueueResult {
    let mut inner = self.lock();
    if inner.pending.len() >= MAX_PENDING {
      return EnqueueResult::Full;
    }
    inner.pending.push_back(command);
    EnqueueResult::Queued
  }

  pub fn take_pending(&self) -> Vec<BridgeCommand> {
    self.lock().pending.drain(..).collect()
  }

  pub fn set_items(&self, mut items: Vec<BridgeItem>) {
    items.truncate(MAX_ITEMS);
    for item in &mut items {
      let path = item.path.as_deref().map(std::path::Path::new);
      item.has_file = path.is_some_and(std::path::Path::exists);
      item.file_name = path
        .and_then(std::path::Path::file_name)
        .map(|name| name.to_string_lossy().into_owned());
    }
    self.lock().items = items;
  }

  pub fn items(&self) -> Vec<BridgeItem> {
    self.lock().items.clone()
  }

  /// The downloaded file for an item, if the app reported one.
  pub fn path_for(&self, id: &str) -> Option<String> {
    self
      .lock()
      .items
      .iter()
      .find(|item| item.id == id)
      .and_then(|item| item.path.clone())
  }
}
