use crate::commands::UpdateStore;
use crate::paths::PathsManager;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Result as UpdaterResult, UpdaterExt};
use tokio::sync::Mutex;

/// True for this fork's builds: no crash reports to the original project, and
/// updates come from the fork's own releases (see tauri.conf.json).
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
  // The fork updates itself in the background (auto_update.rs), so the in-app
  // "update available" banner stays out of the way.
  let handled_in_background = app
    .try_state::<crate::auto_update::AutoUpdateState>()
    .is_some();
  if handled_in_background
    || paths.is_microsoft_store_app()
    || paths.is_portable_app()
    || paths.is_snap_app()
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
