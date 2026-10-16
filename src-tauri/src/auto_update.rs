//! Keeps this fork up to date by itself.
//!
//! Every few hours the app checks the fork's own release feed. When there's a
//! newer build it downloads it, checks its signature, and swaps it in. The new
//! version runs the next time the app starts (or right away if you click
//! "Restart" in the browser extension). Updating the app also updates the
//! browser extension, because the app carries the extension's files (see
//! `extension_files`).

use crate::paths::PathsManager;
use crate::SharedConfig;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct AutoUpdateState {
  busy: AtomicBool,
  installed: Mutex<Option<String>>,
}

impl AutoUpdateState {
  /// A newer version that's already installed and waiting for a restart.
  pub fn installed(&self) -> Option<String> {
    self
      .installed
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .clone()
  }
}

fn enabled(app: &AppHandle) -> bool {
  // For testing the updater on a development build.
  if std::env::var_os("OVD_TEST_AUTO_UPDATE").is_some() {
    return true;
  }
  // Development builds aren't real app bundles; don't try to replace them.
  if cfg!(debug_assertions) {
    return false;
  }
  let paths = app.state::<PathsManager>();
  if paths.is_portable_app() || paths.is_microsoft_store_app() || paths.is_snap_app() {
    return false;
  }
  app.state::<SharedConfig>().load().update.update_app
}

async fn check_and_install(app: &AppHandle) {
  let state = app.state::<AutoUpdateState>();
  if !enabled(app) {
    tracing::debug!("[auto-update] off for this build or in settings");
    return;
  }
  if state.installed().is_some() || state.busy.swap(true, Ordering::SeqCst) {
    return;
  }
  tracing::info!("[auto-update] checking for a new version");

  let result = async {
    // A stuck connection shouldn't stop future checks.
    let updater = app.updater_builder().timeout(REQUEST_TIMEOUT).build()?;
    let Some(update) = updater.check().await? else {
      return Ok::<_, tauri_plugin_updater::Error>(None);
    };
    tracing::info!("[auto-update] installing {}", update.version);
    update.download_and_install(|_, _| {}, || {}).await?;
    Ok(Some(update.version))
  }
  .await;

  match result {
    Ok(Some(version)) => {
      tracing::info!("[auto-update] {version} installed; it runs after a restart");
      *state
        .installed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(version.clone());
      let _ = app.emit("app_update_installed", version);
    }
    Ok(None) => {}
    Err(error) => tracing::warn!("[auto-update] {error}"),
  }
  state.busy.store(false, Ordering::SeqCst);
}

pub fn start(app: &AppHandle) {
  app.manage(AutoUpdateState::default());
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(FIRST_CHECK_AFTER).await;
    loop {
      check_and_install(&app).await;
      tokio::time::sleep(CHECK_EVERY).await;
    }
  });
}
