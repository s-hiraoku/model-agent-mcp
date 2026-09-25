# Cursor agent policy example

For implementation tasks, consult the `model-agent` MCP. Call `agent_list_models` when a model choice is needed, then `agent_start_task` with the task, relevant repository context, and an optional model ID. Use `agent_continue_task` for follow-up reasoning and `agent_set_session_model` to compare or switch models.

Cursor owns repository inspection, file edits, diff review, shell commands, tests, git, and pull requests. Treat MCP responses and patches as proposals. Check their assumptions and apply only changes supported by repository evidence. Never claim the MCP model edited files or ran tests.
