use crate::commands::UpdateStore;
use crate::paths::PathsManager;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Result as UpdaterResult, UpdaterExt};
use tokio::sync::Mutex;

/// True for this fork's builds, which turn off the original project's updates and crash reporting.
pub const FORK_BUILD: bool = true;

#[derive(serde::Serialize)]
pub struct UpdateCheck {
  pub available: bool,
  pub current_version: String,
  pub available_version: Option<String>,
}

#[tauri::command]
pub async fn updater_check(
  app: AppHandle,
  store: State<'_, Mutex<UpdateStore>>,
  paths: State<'_, PathsManager>,
) -> UpdaterResult<UpdateCheck> {
  let current = app.package_info().version.to_string();
  // Portable app does not auto-update, nor does the microsoft/snap store version.
  // This fork never auto-updates: the update feed is the original project's, and
  // installing it would replace the fork and remove its features.
  if FORK_BUILD || paths.is_microsoft_store_app() || paths.is_portable_app() || paths.is_snap_app()
  {
    return Ok(UpdateCheck {
      available: false,
      current_version: current,
      available_version: None,
    });
  }
  if let Some(update) = app.updater()?.check().await? {
    tracing::info!("[updater] Update available: {}", update.version);
    let mut s = store.lock().await;
    s.bytes = None;
    s.update = Some(update.clone());
    Ok(UpdateCheck {
      available: true,
      current_version: current,
      available_version: Some(update.version),
    })
  } else {
    Ok(UpdateCheck {
      available: false,
      current_version: current,
      available_version: None,
    })
  }
}
