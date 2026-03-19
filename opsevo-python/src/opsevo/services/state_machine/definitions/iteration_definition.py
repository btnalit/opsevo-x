"""Iteration loop flow definition."""

from ..engine import FlowDefinition, StateDefinition


def create_iteration_flow() -> FlowDefinition:
    return FlowDefinition(
        name="iteration_loop",
        initial_state="initialize",
        terminal_states={"completed", "aborted"},
        states={
            "initialize": StateDefinition(
                name="initialize",
                handler="iteration_initialize",
                transitions={"success": "execute", "failure": "aborted"},
            ),
            "execute": StateDefinition(
                name="execute",
                handler="iteration_execute",
                transitions={"success": "evaluate", "failure": "handle_error"},
                timeout_s=300.0,
            ),
            "evaluate": StateDefinition(
                name="evaluate",
                handler="iteration_evaluate",
                transitions={"pass": "reflect", "fail": "retry_or_abort"},
            ),
            "reflect": StateDefinition(
                name="reflect",
                handler="iteration_reflect",
                transitions={"continue": "execute", "done": "completed"},
            ),
            "retry_or_abort": StateDefinition(
                name="retry_or_abort",
                handler="iteration_retry_or_abort",
                transitions={"retry": "execute", "abort": "aborted"},
            ),
            "handle_error": StateDefinition(
                name="handle_error",
                handler="iteration_handle_error",
                transitions={"retry": "execute", "abort": "aborted"},
            ),
            "completed": StateDefinition(name="completed", handler="noop", transitions={}),
            "aborted": StateDefinition(name="aborted", handler="noop", transitions={}),
        },
    )
