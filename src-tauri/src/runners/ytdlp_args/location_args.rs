use crate::models::download::SaveAsOverride;
use crate::models::TrackType;
use crate::runners::template_context::TemplateContext;
use crate::state::config_models::OutputSettings;
use crate::state::preferences_models::PathPreferences;
use std::path::{Path, PathBuf};

/// Extensions we strip from a "Save as" name so yt-dlp can add the real one.
const MEDIA_EXTENSIONS: &[&str] = &[
  "mp4", "mkv", "webm", "mov", "avi", "flv", "m4v", "3gp", "ts", "mp3", "m4a", "opus", "ogg",
  "oga", "aac", "flac", "wav", "alac", "aiff",
];

pub fn build_location_args(
  track_type: &TrackType,
  template_context: &TemplateContext,
  output_settings: &OutputSettings,
  path_preferences: &PathPreferences,
  save_as: Option<&SaveAsOverride>,
  fallback_dir: PathBuf,
) -> Vec<String> {
  // A file picked in the "Save as" prompt is used as-is: no templates, no subfolders.
  if let Some(file_path) = save_as
    .and_then(|value| value.file_path.as_deref())
    .map(str::trim)
    .filter(|path| !path.is_empty())
  {
    return vec!["-o".into(), save_as_output_template(file_path)];
  }

  let global_dir = output_settings
    .download_dir
    .as_ref()
    .map(PathBuf::from)
    .unwrap_or(fallback_dir);

  let (preferred_dir, prefix_dir, filename) = match track_type {
    TrackType::Both | TrackType::Video => (
      path_preferences.video_download_dir.as_ref(),
      path_preferences.video_directory_template.as_str(),
      output_settings.file_name_template.as_str(),
    ),
    TrackType::Audio => (
      path_preferences.audio_download_dir.as_ref(),
      path_preferences.audio_directory_template.as_str(),
      output_settings.audio_file_name_template.as_str(),
    ),
  };

  // A folder picked in the "Save as" prompt wins over every saved location.
  let chosen_dir = save_as
    .and_then(|value| value.dir.as_deref())
    .map(str::trim)
    .filter(|dir| !dir.is_empty());

  let base_dir = chosen_dir
    .map(PathBuf::from)
    .or_else(|| preferred_dir.map(PathBuf::from))
    .unwrap_or_else(|| global_dir.clone());

  let output_path = base_dir.join(prefix_dir).join(filename);
  let rendered_output = template_context.render_template(output_path.to_string_lossy().as_ref());

  vec!["-o".into(), rendered_output]
}

/// Turns "/Movies/My clip.mp4" into "/Movies/My clip.%(ext)s" so the file gets
/// the user's name but yt-dlp's real extension.
fn save_as_output_template(file_path: &str) -> String {
  let path = Path::new(file_path);
  let has_media_extension = path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    .unwrap_or(false);
  let stem = if has_media_extension {
    path.with_extension("")
  } else {
    path.to_path_buf()
  };
  // "%" starts a yt-dlp template field, so a literal one has to be doubled.
  format!("{}.%(ext)s", stem.to_string_lossy().replace('%', "%%"))
}
