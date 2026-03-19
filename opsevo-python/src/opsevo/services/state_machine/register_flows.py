"""
RegisterFlows — 注册所有流程定义和处理器到状态机引擎。
"""

from __future__ import annotations

from .engine import StateMachineEngine
from .registry import StateRegistry
from .definitions.alert_definition import create_alert_flow
from .definitions.iteration_definition import create_iteration_flow
from .definitions.react_definition import create_react_flow
from .handlers.alert_handlers import (
    alert_preprocess, alert_noise_filter, alert_analyze,
    alert_decide, alert_remediate, alert_notify, alert_notify_error, noop,
)
from .handlers.iteration_handlers import (
    iteration_initialize, iteration_execute, iteration_evaluate,
    iteration_reflect, iteration_retry_or_abort, iteration_handle_error,
)
from .handlers.react_handlers.routing_decision_handler import react_routing_decision
from .handlers.react_handlers.fast_path_handler import react_fast_path
from .handlers.react_handlers.intent_parse_handler import react_intent_parse
from .handlers.react_handlers.intent_driven_execution_handler import react_intent_driven_execution
from .handlers.react_handlers.knowledge_retrieval_handler import react_knowledge_retrieval
from .handlers.react_handlers.react_loop_handler import react_react_loop
from .handlers.react_handlers.post_processing_handler import react_post_processing
from .handlers.react_handlers.response_handler import react_response, react_error_response


def register_all_flows(engine: StateMachineEngine) -> StateRegistry:
    """注册所有内置流程定义和处理器。"""
    registry = StateRegistry(engine)

    # --- flow definitions ---
    registry.register_flow(create_alert_flow())
    registry.register_flow(create_iteration_flow())
    registry.register_flow(create_react_flow())

    # --- handlers ---
    registry.register_handlers({
        # alert
        "alert_preprocess": alert_preprocess,
        "alert_noise_filter": alert_noise_filter,
        "alert_analyze": alert_analyze,
        "alert_decide": alert_decide,
        "alert_remediate": alert_remediate,
        "alert_notify": alert_notify,
        "alert_notify_error": alert_notify_error,
        "noop": noop,
        # iteration
        "iteration_initialize": iteration_initialize,
        "iteration_execute": iteration_execute,
        "iteration_evaluate": iteration_evaluate,
        "iteration_reflect": iteration_reflect,
        "iteration_retry_or_abort": iteration_retry_or_abort,
        "iteration_handle_error": iteration_handle_error,
        # react
        "react_routing_decision": react_routing_decision,
        "react_fast_path": react_fast_path,
        "react_intent_parse": react_intent_parse,
        "react_intent_driven_execution": react_intent_driven_execution,
        "react_knowledge_retrieval": react_knowledge_retrieval,
        "react_react_loop": react_react_loop,
        "react_post_processing": react_post_processing,
        "react_response": react_response,
        "react_error_response": react_error_response,
    })

    return registry
