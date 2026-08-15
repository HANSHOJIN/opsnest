//! Model-facing tool registry for the native OpsNest agent.
//!
//! This is intentionally a small registry rather than a plugin framework. It
//! owns the tool names and JSON schemas supplied to the model, while the
//! existing AI-SSH loop remains responsible for the command's async
//! execution, approval, cancellation, and PTY ordering.

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    RunCommand,
    ListFiles,
    ReadFile,
    DiscoverServices,
    OpenFileManager,
    OpenFileEditor,
    WorkspaceListFiles,
    WorkspaceReadFile,
    WorkspaceWriteFile,
    WorkspaceDeleteFile,
    DownloadToWorkspace,
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub kind: ToolKind,
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

#[derive(Debug, Default)]
pub struct ToolRegistry {
    tools: Vec<ToolSpec>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, spec: ToolSpec) {
        if let Some(existing) = self.tools.iter_mut().find(|item| item.name == spec.name) {
            *existing = spec;
        } else {
            self.tools.push(spec);
        }
    }

    pub fn get(&self, name: &str) -> Option<&ToolSpec> {
        self.tools.iter().find(|item| item.name == name)
    }

    /// Build the OpenAI-compatible function tool list for the current model
    /// request. The registry remains the source of truth for both schemas and
    /// name lookup, so future tools do not require editing the AI request body.
    pub fn schemas(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        )
    }
}

pub fn default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    registry.register(ToolSpec {
        kind: ToolKind::RunCommand,
        name: "run_command",
        description: "Plan one concrete command on the connected server. Include a verification command when the result can be checked safely.",
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "verify_command": { "type": "string" },
                "explain": { "type": "string" },
                "risk": {
                    "type": "string",
                    "enum": ["low", "medium", "high"]
                }
            },
            "required": ["command", "explain", "risk"]
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::ListFiles,
        name: "list_files",
        description: "List the entries in a directory on the connected server through SFTP. Use this for read-only inspection instead of running ls through the terminal.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote directory path. Defaults to /root."
                }
            },
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::ReadFile,
        name: "read_file",
        description: "Read a bounded UTF-8 text file from the connected server through SFTP. Never use this to modify files or to read an unbounded binary file.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote file path."
                },
                "max_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 65536,
                    "description": "Maximum UTF-8 bytes to read; defaults to 32768."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::DiscoverServices,
        name: "discover_services",
        description: "Scan the connected server for known web services, router/NAS services, and Docker or system services. This is read-only and may take a few seconds.",
        parameters: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::OpenFileManager,
        name: "opsnest_open_file_manager",
        description: "Open the OpsNest remote file manager for the currently connected server. Use this for a UI navigation request, not for reading or modifying remote files.",
        parameters: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::OpenFileEditor,
        name: "opsnest_open_file_editor",
        description: "Open a specific remote UTF-8 text file in the OpsNest editor for the currently connected server after a command has inspected or modified it. This only opens the UI; it does not change the file.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or server-relative remote file path to show in the OpsNest editor."
                },
                "placement": {
                    "type": "string",
                    "enum": ["right", "bottom"],
                    "description": "Preferred OpsNest panel placement; defaults to right."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::WorkspaceListFiles,
        name: "workspace_list_files",
        description: "List files in the current session's local OpsNest workspace. This is local to the user's computer, not a directory on the remote server.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative directory path. Omit or use an empty string for the workspace root."
                }
            },
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::WorkspaceReadFile,
        name: "workspace_read_file",
        description: "Read a bounded UTF-8 text file from the current session's local OpsNest workspace. Use this for local drafts, memory, backups, or temporary artifacts.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path." },
                "max_bytes": { "type": "integer", "minimum": 1, "maximum": 65536, "description": "Maximum UTF-8 bytes; defaults to 32768." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::WorkspaceWriteFile,
        name: "workspace_write_file",
        description: "Write UTF-8 text to the current session's local OpsNest workspace. Use this when the user asks to save, back up, or prepare a local file; it does not write to the remote server.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative destination path." },
                "content": { "type": "string", "description": "UTF-8 file content." }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::WorkspaceDeleteFile,
        name: "workspace_delete_file",
        description: "Delete one file from the current session's local OpsNest workspace. This never deletes a remote file.",
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    });
    registry.register(ToolSpec {
        kind: ToolKind::DownloadToWorkspace,
        name: "download_to_workspace",
        description: "Copy a remote server file through SFTP into the current session's local OpsNest workspace. Use this when the user asks to download or save a remote file locally; use a remote path only as the source.",
        parameters: json!({
            "type": "object",
            "properties": {
                "remote_path": { "type": "string", "description": "Source path on the connected remote server." },
                "path": { "type": "string", "description": "Workspace-relative local destination path." },
                "max_bytes": { "type": "integer", "minimum": 1, "maximum": 8388608, "description": "Maximum bytes to download; defaults to 8388608." }
            },
            "required": ["remote_path", "path"],
            "additionalProperties": false
        }),
    });
    registry
}

#[cfg(test)]
mod tests {
    use super::{default_registry, ToolKind};

    #[test]
    fn default_registry_exposes_run_command_schema() {
        let registry = default_registry();
        let schemas = registry.schemas();
        let function = &schemas[0]["function"];

        assert_eq!(function["name"], "run_command");
        assert_eq!(function["parameters"]["type"], "object");
        assert_eq!(
            function["parameters"]["properties"]["command"]["type"],
            "string"
        );
        assert_eq!(
            function["parameters"]["properties"]["risk"]["enum"][2],
            "high"
        );
    }

    #[test]
    fn registry_lookup_returns_tool_kind() {
        let registry = default_registry();
        assert_eq!(
            registry.get("run_command").map(|tool| tool.kind),
            Some(ToolKind::RunCommand)
        );
        assert!(registry.get("unknown_tool").is_none());
    }

    #[test]
    fn registry_exposes_read_only_server_tools() {
        let registry = default_registry();
        assert_eq!(
            registry.get("list_files").map(|tool| tool.kind),
            Some(ToolKind::ListFiles)
        );
        assert_eq!(
            registry.get("read_file").map(|tool| tool.kind),
            Some(ToolKind::ReadFile)
        );
        assert_eq!(
            registry.get("discover_services").map(|tool| tool.kind),
            Some(ToolKind::DiscoverServices)
        );
        assert_eq!(
            registry
                .get("opsnest_open_file_manager")
                .map(|tool| tool.kind),
            Some(ToolKind::OpenFileManager)
        );
        assert_eq!(
            registry
                .get("opsnest_open_file_editor")
                .map(|tool| tool.kind),
            Some(ToolKind::OpenFileEditor)
        );
        assert_eq!(registry.schemas().as_array().map(Vec::len), Some(11));
        assert_eq!(
            registry.get("workspace_write_file").map(|tool| tool.kind),
            Some(ToolKind::WorkspaceWriteFile)
        );
        assert_eq!(
            registry.get("download_to_workspace").map(|tool| tool.kind),
            Some(ToolKind::DownloadToWorkspace)
        );
    }
}
