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
        assert_eq!(registry.schemas().as_array().map(Vec::len), Some(4));
    }
}
