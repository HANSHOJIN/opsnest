//! Per-server-session local workspace storage.
//!
//! A workspace is deliberately separate from the remote server filesystem. It
//! holds AI memory, editor drafts, pre-save snapshots, and other local
//! artifacts that may need review before they are sent back to a server.
//! The directory name is the stable opaque server/session key, not the server
//! display name shown in the UI.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_WORKSPACE_TEXT_BYTES: usize = 8 * 1024 * 1024;
const WORKSPACE_INDEX_FILE: &str = "workspace-index.json";
static WORKSPACE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn workspace_lock() -> &'static Mutex<()> {
    WORKSPACE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WorkspaceAlias {
    directory: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub root: String,
    pub drafts: String,
    pub snapshots: String,
    pub artifacts: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn data_dir() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("unable to locate executable: {error}"))?;
    let parent = executable
        .parent()
        .ok_or_else(|| "unable to locate executable directory".to_string())?;
    let data_dir = parent.join("data");
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("unable to create portable data directory: {error}"))?;
    Ok(data_dir)
}

fn workspaces_dir() -> Result<PathBuf, String> {
    let directory = data_dir()?.join("workspaces");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("unable to create workspace directory: {error}"))?;
    Ok(directory)
}

fn workspace_index_path() -> Result<PathBuf, String> {
    Ok(workspaces_dir()?.join(WORKSPACE_INDEX_FILE))
}

fn read_workspace_aliases() -> Result<HashMap<String, WorkspaceAlias>, String> {
    let path = workspace_index_path()?;
    match fs::read(path) {
        Ok(content) => Ok(serde_json::from_slice(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!("unable to read workspace index: {error}")),
    }
}

fn write_workspace_aliases(aliases: &HashMap<String, WorkspaceAlias>) -> Result<(), String> {
    let path = workspace_index_path()?;
    let content = serde_json::to_vec_pretty(aliases)
        .map_err(|error| format!("unable to encode workspace index: {error}"))?;
    fs::write(path, content).map_err(|error| format!("unable to write workspace index: {error}"))
}

fn copy_workspace_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("unable to create named workspace: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("unable to read legacy workspace: {error}"))?
    {
        let entry = entry.map_err(|error| format!("unable to inspect legacy workspace: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_workspace_tree(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("unable to copy workspace file: {error}"))?;
        }
    }
    Ok(())
}

fn safe_component(value: &str) -> String {
    let mut result = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    result = result.trim_end_matches([' ', '.']).to_string();
    if result.is_empty() || result == "." || result == ".." {
        result = "session".to_string();
    }
    result.chars().take(96).collect()
}

fn workspace_short_code(workspace_id: &str) -> String {
    let candidate = workspace_id
        .rsplit_once('-')
        .map(|(_, suffix)| suffix)
        .filter(|suffix| !suffix.is_empty())
        .unwrap_or(workspace_id);
    let code = candidate
        .chars()
        .filter(|character| character.is_alphanumeric())
        .take(8)
        .collect::<String>();
    if code.is_empty() {
        "session".to_string()
    } else {
        code
    }
}

fn preferred_workspace_directory(workspace_id: &str, display_name: &str) -> String {
    let label = safe_component(display_name);
    let code = workspace_short_code(workspace_id);
    safe_component(&format!("{label}-{code}"))
}

fn workspace_root(workspace_id: &str) -> Result<PathBuf, String> {
    let id = workspace_id.trim();
    if id.is_empty() || id.chars().any(char::is_control) {
        return Err("workspace id is invalid".to_string());
    }
    let directory = workspaces_dir()?;
    let aliases = read_workspace_aliases()?;
    let name = aliases
        .get(id)
        .map(|alias| alias.directory.clone())
        .unwrap_or_else(|| safe_component(id));
    Ok(directory.join(name))
}

fn resolve_relative_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative.trim());
    if relative.trim().is_empty() || path.is_absolute() {
        return Err("workspace path must be relative".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("workspace path escapes its root".to_string());
    }
    Ok(root.join(path))
}

fn create_workspace_unlocked(workspace_id: &str) -> Result<(PathBuf, WorkspaceInfo), String> {
    let root = workspace_root(workspace_id)?;
    let drafts = root.join("drafts");
    let snapshots = root.join("snapshots");
    let artifacts = root.join("artifacts");
    for directory in [&root, &drafts, &snapshots, &artifacts] {
        fs::create_dir_all(directory)
            .map_err(|error| format!("unable to create workspace directory: {error}"))?;
    }
    let manifest = root.join("workspace.json");
    if !manifest.exists() {
        let content = serde_json::json!({
            "workspaceId": workspace_id,
            "createdAt": chrono_like_timestamp(),
            "purpose": "OpsNest per-server session AI and editor workspace"
        });
        fs::write(
            manifest,
            serde_json::to_vec_pretty(&content).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("unable to write workspace manifest: {error}"))?;
    }
    let info = WorkspaceInfo {
        workspace_id: workspace_id.to_string(),
        root: root.to_string_lossy().into_owned(),
        drafts: "drafts".to_string(),
        snapshots: "snapshots".to_string(),
        artifacts: "artifacts".to_string(),
    };
    Ok((root, info))
}

fn create_workspace(workspace_id: &str) -> Result<(PathBuf, WorkspaceInfo), String> {
    let _guard = workspace_lock()
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    create_workspace_unlocked(workspace_id)
}

fn migrate_workspace_to_named_directory(
    workspace_id: &str,
    display_name: &str,
) -> Result<(), String> {
    let id = workspace_id.trim();
    let display_name = display_name.trim();
    if id.is_empty() || display_name.is_empty() {
        return Ok(());
    }
    let mut aliases = read_workspace_aliases()?;
    if let Some(alias) = aliases.get_mut(id) {
        if alias.display_name != display_name {
            alias.display_name = display_name.to_string();
            write_workspace_aliases(&aliases)?;
        }
        return Ok(());
    }

    let directory = workspaces_dir()?;
    let legacy = directory.join(safe_component(id));
    let preferred_name = preferred_workspace_directory(id, display_name);
    let preferred = directory.join(&preferred_name);

    // Preserve existing data. If both names already exist, leave the legacy
    // path authoritative instead of guessing which copy should win.
    if legacy.exists() && preferred != legacy {
        if !preferred.exists() {
            // Rename is ideal, but Windows can reject a directory rename while
            // a live editor or antivirus has a file open. Copying keeps the
            // old directory intact and lets the new named path become the
            // authoritative location without risking data loss.
            if fs::rename(&legacy, &preferred).is_err()
                && copy_workspace_tree(&legacy, &preferred).is_err()
            {
                return Ok(());
            }
        } else if !preferred.join("workspace.json").exists()
            && copy_workspace_tree(&legacy, &preferred).is_err()
        {
            return Ok(());
        }
    }

    aliases.insert(
        id.to_string(),
        WorkspaceAlias {
            directory: preferred_name,
            display_name: display_name.to_string(),
        },
    );
    write_workspace_aliases(&aliases)
}

fn write_workspace_display_name(root: &Path, display_name: &str) -> Result<(), String> {
    let manifest = root.join("workspace.json");
    let mut value = fs::read(&manifest)
        .ok()
        .and_then(|content| serde_json::from_slice::<serde_json::Value>(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let object = value
        .as_object_mut()
        .ok_or_else(|| "workspace manifest is not an object".to_string())?;
    object.insert(
        "displayName".to_string(),
        serde_json::Value::String(display_name.trim().to_string()),
    );
    let content = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("unable to encode workspace manifest: {error}"))?;
    fs::write(manifest, content)
        .map_err(|error| format!("unable to update workspace manifest: {error}"))
}

/// Resolve a path inside a session workspace for native callers such as the
/// AI tool dispatcher. The returned path is always rooted below the managed
/// workspace and the workspace directories are created first.
pub fn workspace_path(workspace_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let (root, _) = create_workspace(workspace_id)?;
    resolve_relative_path(&root, relative_path)
}

pub fn list_workspace_files(
    workspace_id: &str,
    relative_path: Option<&str>,
) -> Result<(WorkspaceInfo, Vec<WorkspaceFileEntry>), String> {
    let (root, info) = create_workspace(workspace_id)?;
    let relative = relative_path.unwrap_or("").trim();
    let target = if relative.is_empty() {
        root.clone()
    } else {
        resolve_relative_path(&root, relative)?
    };
    if !target.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }
    let mut entries = fs::read_dir(&target)
        .map_err(|error| format!("unable to list workspace directory: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let path = entry.path();
            let relative_path = path
                .strip_prefix(&root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some(WorkspaceFileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: relative_path,
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok((info, entries))
}

#[tauri::command]
pub fn list_workspace_directory(
    workspace_id: String,
    relative_path: Option<String>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    list_workspace_files(&workspace_id, relative_path.as_deref()).map(|(_, entries)| entries)
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[tauri::command]
pub fn ensure_workspace(
    workspace_id: String,
    display_name: Option<String>,
) -> Result<WorkspaceInfo, String> {
    let _guard = workspace_lock()
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    if let Some(display_name) = display_name.as_deref() {
        migrate_workspace_to_named_directory(&workspace_id, display_name)?;
    }
    let (root, info) = create_workspace_unlocked(&workspace_id)?;
    if let Some(display_name) = display_name.as_deref().filter(|value| !value.trim().is_empty()) {
        write_workspace_display_name(&root, display_name)?;
    }
    Ok(info)
}

#[tauri::command]
pub fn read_workspace_text(
    workspace_id: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    let (root, _) = create_workspace(&workspace_id)?;
    let path = resolve_relative_path(&root, &relative_path)?;
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("unable to read workspace file: {error}")),
    }
}

#[tauri::command]
pub fn write_workspace_text(
    workspace_id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > MAX_WORKSPACE_TEXT_BYTES {
        return Err("workspace file is too large".to_string());
    }
    write_workspace_bytes(&workspace_id, &relative_path, content.as_bytes())
}

pub fn write_workspace_bytes(
    workspace_id: &str,
    relative_path: &str,
    content: &[u8],
) -> Result<(), String> {
    if content.len() > MAX_WORKSPACE_TEXT_BYTES {
        return Err("workspace file is too large".to_string());
    }
    let path = workspace_path(workspace_id, relative_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("unable to create workspace file directory: {error}"))?;
    }
    fs::write(path, content).map_err(|error| format!("unable to write workspace file: {error}"))
}

#[tauri::command]
pub fn delete_workspace_file(workspace_id: String, relative_path: String) -> Result<(), String> {
    let (root, _) = create_workspace(&workspace_id)?;
    let path = resolve_relative_path(&root, &relative_path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("unable to delete workspace file: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{preferred_workspace_directory, safe_component, workspace_short_code};

    #[test]
    fn workspace_directory_keeps_display_name_and_short_key() {
        assert_eq!(
            preferred_workspace_directory("1786763217383-2kf0y3", "野草云"),
            "野草云-2kf0y3"
        );
    }

    #[test]
    fn workspace_short_code_is_stable_for_generated_ids() {
        assert_eq!(workspace_short_code("1786763217383-2kf0y3"), "2kf0y3");
        assert_eq!(workspace_short_code("server-manager"), "manager");
    }

    #[test]
    fn workspace_component_replaces_path_separators() {
        assert_eq!(safe_component("腾讯云\\../prod"), "腾讯云_.._prod");
    }
}
