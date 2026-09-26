# Cursor agent policy example

For implementation tasks, consult the `model-agent` MCP. Call `agent_list_models` when a model choice is needed, then `agent_start_task` with the task, relevant repository context, and an optional model ID. Use `agent_continue_task` for follow-up reasoning and `agent_set_session_model` to compare or switch models.

Before the first model invocation for a user task, display a user-visible message in exactly this form: `Model Agent MCPをmodel ○○で使います。` Replace `○○` with the selected model ID. If you omit `model`, first read `default_model` from `agent_list_models`. If continuing an existing session as your first model invocation, read its model from `agent_get_session`. Do not invoke `agent_start_task` or `agent_continue_task` silently. If the result contains `fallback_from`, tell the user that CLIProxyAPI's `auto` model selector was used after the requested model failed. Do not name a concrete backend model unless it was verified.

Cursor owns repository inspection, file edits, diff review, shell commands, tests, git, and pull requests. Treat MCP responses and patches as proposals. Check their assumptions and apply only changes supported by repository evidence. Never claim the MCP model edited files or ran tests.
