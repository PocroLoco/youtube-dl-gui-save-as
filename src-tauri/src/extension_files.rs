//! The browser extension ships inside the app. On start the app copies it to a
//! fixed folder ("Chrome Extension" in the app's data folder). You load that
//! folder in Chrome once; after that, every app update brings new extension
//! files, and the extension reloads itself when it sees them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const FOLDER_NAME: &str = "Chrome Extension";

#[derive(Default)]
pub struct ExtensionFiles {
  inner: Mutex<Option<(PathBuf, String)>>,
}

impl ExtensionFiles {
  pub fn folder(&self) -> Option<PathBuf> {
    self.lock().as_ref().map(|(folder, _)| folder.clone())
  }

  pub fn version(&self) -> Option<String> {
    self.lock().as_ref().map(|(_, version)| version.clone())
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, Option<(PathBuf, String)>> {
    self
      .inner
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }
}

/// The `version` from a folder's manifest.json.
pub fn manifest_version(folder: &Path) -> Option<String> {
  let text = fs::read_to_string(folder.join("manifest.json")).ok()?;
  let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
  manifest.get("version")?.as_str().map(str::to_string)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
  fs::create_dir_all(to)?;
  for entry in fs::read_dir(from)? {
    let entry = entry?;
    let target = to.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      copy_dir(&entry.path(), &target)?;
    } else {
      fs::copy(entry.path(), &target)?;
    }
  }
  Ok(())
}

/// Puts the bundled extension in `target` unless that version is already
/// there. The new files are copied next to the old ones first, then swapped
/// in, so Chrome never sees a half-written folder.
pub fn sync(source: &Path, target: &Path) -> io::Result<String> {
  let version = manifest_version(source)
    .ok_or_else(|| io::Error::other("bundled extension has no manifest version"))?;
  if manifest_version(target).as_deref() == Some(version.as_str()) {
    return Ok(version);
  }

  let staging = target.with_extension("updating");
  let old = target.with_extension("old");
  let _ = fs::remove_dir_all(&staging);
  let _ = fs::remove_dir_all(&old);
  copy_dir(source, &staging)?;
  if target.exists() {
    fs::rename(target, &old)?;
  }
  fs::rename(&staging, target)?;
  let _ = fs::remove_dir_all(&old);
  Ok(version)
}

pub fn setup(app: &AppHandle) {
  let files = ExtensionFiles::default();
  let source = app
    .path()
    .resource_dir()
    .map(|dir| dir.join("browser-extension"));
  let target = app.path().app_data_dir().map(|dir| dir.join(FOLDER_NAME));
  if let (Ok(source), Ok(target)) = (source, target) {
    if source.join("manifest.json").exists() {
      match sync(&source, &target) {
        Ok(version) => *files.lock() = Some((target, version)),
        Err(error) => tracing::warn!("[extension] couldn't copy the extension: {error}"),
      }
    }
  }
  app.manage(files);
}

/// Shows the extension's folder in Finder / Explorer.
#[tauri::command]
pub fn extension_folder_reveal(app: AppHandle) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;
  let folder = app
    .state::<ExtensionFiles>()
    .folder()
    .ok_or("The extension isn't bundled with this build.")?;
  app
    .opener()
    .reveal_item_in_dir(folder)
    .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionFolderInfo {
  pub path: Option<String>,
  pub version: Option<String>,
}

#[tauri::command]
pub fn extension_folder_info(app: AppHandle) -> ExtensionFolderInfo {
  let files = app.state::<ExtensionFiles>();
  ExtensionFolderInfo {
    path: files.folder().map(|p| p.to_string_lossy().into_owned()),
    version: files.version(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(dir: &Path, version: &str, extra: &str) {
    fs::create_dir_all(dir.join("popup")).unwrap();
    fs::write(
      dir.join("manifest.json"),
      format!(r#"{{"version":"{version}"}}"#),
    )
    .unwrap();
    fs::write(dir.join("popup/popup.js"), extra).unwrap();
  }

  #[test]
  fn copies_new_versions_and_leaves_same_ones_alone() {
    let root = std::env::temp_dir().join(format!("ovd-ext-sync-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let bundled = root.join("bundled");
    let target = root.join(FOLDER_NAME);

    write(&bundled, "3.2.101", "one");
    assert_eq!(sync(&bundled, &target).unwrap(), "3.2.101");
    assert_eq!(
      fs::read_to_string(target.join("popup/popup.js")).unwrap(),
      "one"
    );

    // Same version: untouched (even if the bundled files differ).
    write(&bundled, "3.2.101", "changed");
    sync(&bundled, &target).unwrap();
    assert_eq!(
      fs::read_to_string(target.join("popup/popup.js")).unwrap(),
      "one"
    );

    // New version: swapped in, nothing left over.
    write(&bundled, "3.2.102", "two");
    assert_eq!(sync(&bundled, &target).unwrap(), "3.2.102");
    assert_eq!(manifest_version(&target).as_deref(), Some("3.2.102"));
    assert_eq!(
      fs::read_to_string(target.join("popup/popup.js")).unwrap(),
      "two"
    );
    assert!(!target.with_extension("updating").exists());
    assert!(!target.with_extension("old").exists());

    let _ = fs::remove_dir_all(&root);
  }
}
