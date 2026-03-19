"""ReAct loop flow definition."""

from ..engine import FlowDefinition, StateDefinition


def create_react_flow() -> FlowDefinition:
    return FlowDefinition(
        name="react_loop",
        initial_state="routing_decision",
        terminal_states={"response", "error"},
        states={
            "routing_decision": StateDefinition(
                name="routing_decision",
                handler="react_routing_decision",
                transitions={"fast_path": "fast_path", "intent_driven": "intent_parse", "react": "knowledge_retrieval"},
            ),
            "fast_path": StateDefinition(
                name="fast_path",
                handler="react_fast_path",
                transitions={"success": "response", "fallback": "knowledge_retrieval", "failure": "error"},
            ),
            "intent_parse": StateDefinition(
                name="intent_parse",
                handler="react_intent_parse",
                transitions={"success": "intent_driven_execution", "failure": "knowledge_retrieval"},
            ),
            "intent_driven_execution": StateDefinition(
                name="intent_driven_execution",
                handler="react_intent_driven_execution",
                transitions={"success": "post_processing", "failure": "knowledge_retrieval"},
                timeout_s=120.0,
            ),
            "knowledge_retrieval": StateDefinition(
                name="knowledge_retrieval",
                handler="react_knowledge_retrieval",
                transitions={"success": "react_loop", "failure": "react_loop"},
            ),
            "react_loop": StateDefinition(
                name="react_loop",
                handler="react_react_loop",
                transitions={"success": "post_processing", "failure": "error"},
                timeout_s=180.0,
            ),
            "post_processing": StateDefinition(
                name="post_processing",
                handler="react_post_processing",
                transitions={"success": "response", "failure": "response"},
            ),
            "response": StateDefinition(name="response", handler="react_response", transitions={}),
            "error": StateDefinition(name="error", handler="react_error_response", transitions={}),
        },
    )
