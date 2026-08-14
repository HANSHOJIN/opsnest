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
}

impl AgentTurn {
    pub fn start(turn: u64) -> Self {
        Self {
            turn,
            step: 1,
            phase: AgentPhase::WaitingModel,
            tool_calls: 0,
            completed_tools: 0,
        }
    }

    pub fn begin_step(&mut self) {
        self.step = self.step.saturating_add(1);
        self.phase = AgentPhase::WaitingModel;
    }

    pub fn tool_requested(&mut self, requires_approval: bool) {
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

    pub fn tool_completed(&mut self) {
        self.completed_tools = self.completed_tools.saturating_add(1);
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

    pub fn fail(&mut self) {
        self.phase = AgentPhase::Failed;
    }

    pub fn event_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "turn": self.turn,
            "step": self.step,
            "phase": self.phase.as_str(),
            "toolCalls": self.tool_calls,
            "completedTools": self.completed_tools,
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

        turn.tool_requested(false);
        assert_eq!(turn.phase, AgentPhase::ExecutingTool);
        turn.tool_completed();
        assert_eq!(turn.phase, AgentPhase::AwaitingContinuation);

        turn.begin_step();
        assert_eq!(turn.step, 2);
        assert_eq!(turn.phase, AgentPhase::WaitingModel);

        turn.tool_requested(true);
        assert_eq!(turn.phase, AgentPhase::AwaitingApproval);
        turn.approval_granted();
        assert_eq!(turn.phase, AgentPhase::ExecutingTool);
        turn.tool_completed();
        turn.finalize();
        turn.complete();
        assert_eq!(turn.completed_tools, 2);
        assert_eq!(turn.phase, AgentPhase::Completed);
    }

    #[test]
    fn cancellation_is_terminal_for_the_current_turn() {
        let mut turn = AgentTurn::start(1);
        turn.tool_requested(false);
        turn.cancel();
        assert_eq!(turn.phase, AgentPhase::Cancelled);
    }
}
