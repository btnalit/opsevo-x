"""Alert pipeline flow definition."""

from ..engine import FlowDefinition, StateDefinition


def create_alert_flow() -> FlowDefinition:
    return FlowDefinition(
        name="alert_pipeline",
        initial_state="preprocess",
        terminal_states={"completed", "dropped"},
        states={
            "preprocess": StateDefinition(
                name="preprocess",
                handler="alert_preprocess",
                transitions={"success": "noise_filter", "failure": "dropped"},
            ),
            "noise_filter": StateDefinition(
                name="noise_filter",
                handler="alert_noise_filter",
                transitions={"success": "analyze", "filtered": "dropped", "failure": "dropped"},
            ),
            "analyze": StateDefinition(
                name="analyze",
                handler="alert_analyze",
                transitions={"success": "decide", "failure": "notify_error"},
                timeout_s=30.0,
            ),
            "decide": StateDefinition(
                name="decide",
                handler="alert_decide",
                transitions={"auto_remediate": "remediate", "notify": "notify", "suppress": "completed"},
            ),
            "remediate": StateDefinition(
                name="remediate",
                handler="alert_remediate",
                transitions={"success": "notify", "failure": "notify_error"},
                timeout_s=120.0,
            ),
            "notify": StateDefinition(
                name="notify",
                handler="alert_notify",
                transitions={"success": "completed", "failure": "completed"},
            ),
            "notify_error": StateDefinition(
                name="notify_error",
                handler="alert_notify_error",
                transitions={"default": "completed"},
            ),
            "completed": StateDefinition(name="completed", handler="noop", transitions={}),
            "dropped": StateDefinition(name="dropped", handler="noop", transitions={}),
        },
    )
