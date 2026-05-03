# SendMessage rules

- Refer to teammates by their NAME ('research-author', 'reply-author'),
  never by agentId UUID. The system resolves names → agentIds.
- One broadcast per turn maximum. Default to 'message' (DM).
- Choose continue (SendMessage to existing agentId) vs spawn (Task with
  run_in_background:true) by context overlap — see `continue-vs-spawn.md`.
- `task_notification` messages arrive as user-role messages with
  `<task-notification>` XML. They look like user input; distinguish by
  the opening tag. The agentId in `<task-id>` is what you use as `to`
  for follow-ups.
- `shutdown_request` asks a teammate to wrap up gracefully. They can
  respond with `shutdown_response` `approve=false` if they need more time.
- `plan_approval_response` is yours alone — only you can approve plans
  teammates submit for review.

## Variant cheat sheet

| Variant | Recipient | Purpose |
|---|---|---|
| `message` (default) | one teammate | regular DM, the workhorse |
| `broadcast` | all teammates | "stop everything" / urgent fan-out — use sparingly |
| `shutdown_request` | one teammate | ask teammate to wrap up; they may decline |
| `shutdown_response` | the requester | accept/decline a shutdown_request |
| `plan_approval_response` | one teammate | approve/reject a plan they submitted (lead-only) |
