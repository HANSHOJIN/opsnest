//! Small, native Agent workflow primitives inspired by DeepSeek Harness.
//!
//! This module deliberately contains no model or SSH code.  It gives the
//! OpsNest Agent loop an explicit turn/step lifecycle so cancellation,
//! approvals and tool results cannot be represented as unrelated booleans.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPhase {
    WaitingModel,
    AwaitingApproval,
    ExecutingTool,
    AwaitingContinuation,
    Finalizing,
    Completed,
    Cancelled,
    Failed,
}

impl AgentPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WaitingModel => "waiting_model",
            Self::AwaitingApproval => "awaiting_approval",
            Self::ExecutingTool => "executing_tool",
            Self::AwaitingContinuation => "awaiting_continuation",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentTurn {
    pub turn: u64,
    pub step: u32,
    pub phase: AgentPhase,
    pub tool_calls: u32,
    pub completed_tools: u32,
    pub active_tool: Option<String>,
    pub last_tool: Option<String>,
    pub last_result: Option<String>,
    pub failure: Option<String>,
    pub action: Option<String>,
}

impl AgentTurn {
    pub fn start(turn: u64) -> Self {
        Self {
            turn,
            step: 1,
            phase: AgentPhase::WaitingModel,
            tool_calls: 0,
            completed_tools: 0,
            active_tool: None,
            last_tool: None,
            last_result: None,
            failure: None,
            action: None,
        }
    }

    pub fn begin_step(&mut self) {
        self.step = self.step.saturating_add(1);
        self.phase = AgentPhase::WaitingModel;
    }

    pub fn tool_requested_named(&mut self, tool: impl Into<String>, requires_approval: bool) {
        self.active_tool = Some(tool.into());
        self.last_tool = None;
        self.last_result = None;
        self.failure = None;
        self.tool_requested_phase(requires_approval);
    }

    pub fn describe_action(&mut self, action: impl Into<String>) {
        self.action = Some(action.into());
    }

    fn tool_requested_phase(&mut self, requires_approval: bool) {
        self.tool_calls = self.tool_calls.saturating_add(1);
        self.phase = if requires_approval {
            AgentPhase::AwaitingApproval
        } else {
            AgentPhase::ExecutingTool
        };
    }

    pub fn approval_granted(&mut self) {
        if self.phase == AgentPhase::AwaitingApproval {
            self.phase = AgentPhase::ExecutingTool;
        }
    }

    pub fn tool_completed_with_result(&mut self, result: impl Into<String>) {
        self.completed_tools = self.completed_tools.saturating_add(1);
        self.last_tool = self.active_tool.take();
        self.last_result = Some(result.into());
        self.failure = None;
        self.phase = AgentPhase::AwaitingContinuation;
    }

    pub fn finalize(&mut self) {
        self.phase = AgentPhase::Finalizing;
    }

    pub fn complete(&mut self) {
        self.phase = AgentPhase::Completed;
    }

    pub fn cancel(&mut self) {
        self.phase = AgentPhase::Cancelled;
    }

    pub fn fail_with(&mut self, reason: impl Into<String>) {
        self.phase = AgentPhase::Failed;
        self.failure = Some(reason.into());
    }

    pub fn event_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "turn": self.turn,
            "step": self.step,
            "phase": self.phase.as_str(),
            "toolCalls": self.tool_calls,
            "completedTools": self.completed_tools,
            "tool": self.active_tool,
            "lastTool": self.last_tool,
            "result": self.last_result,
            "failure": self.failure,
            "action": self.action,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentPhase, AgentTurn};

    #[test]
    fn models_a_multi_step_tool_turn() {
        let mut turn = AgentTurn::start(7);
        assert_eq!(turn.phase, AgentPhase::WaitingModel);

        turn.tool_requested_named("read_file", false);
        assert_eq!(turn.phase, AgentPhase::ExecutingTool);
        turn.tool_completed_with_result("工具执行完成");
        assert_eq!(turn.phase, AgentPhase::AwaitingContinuation);

        turn.begin_step();
        assert_eq!(turn.step, 2);
        assert_eq!(turn.phase, AgentPhase::WaitingModel);

        turn.tool_requested_named("run_command", true);
        assert_eq!(turn.phase, AgentPhase::AwaitingApproval);
        turn.approval_granted();
        assert_eq!(turn.phase, AgentPhase::ExecutingTool);
        turn.tool_completed_with_result("工具执行完成");
        turn.finalize();
        turn.complete();
        assert_eq!(turn.completed_tools, 2);
        assert_eq!(turn.phase, AgentPhase::Completed);
    }

    #[test]
    fn cancellation_is_terminal_for_the_current_turn() {
        let mut turn = AgentTurn::start(1);
        turn.tool_requested_named("read_file", false);
        turn.cancel();
        assert_eq!(turn.phase, AgentPhase::Cancelled);
    }
}
