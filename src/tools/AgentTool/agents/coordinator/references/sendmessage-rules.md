# SendMessage rules

The tool's input shape is engine-style flat-top + nested-union:

```
{ to: string, summary?: string, message: string | StructuredObject, run_id?: string }
```

- `to` is the recipient — a teammate's NAME (e.g. `'research-author'`,
  `'reply-author'`), a teammate's `agent_runs.id`, OR `'*'` for broadcast.
  Always prefer the name; the system resolves names → ids. Never address
  by raw UUID unless the name is unavailable.
- `summary` is a 5-10 word UI preview shown to the lead via the peer-DM
  shadow channel. Required when `message` is a plain string DM.
- `message` is either a plain string (regular DM or broadcast) OR a
  structured object for protocol responses — see the cheat sheet below.
- `run_id` is optional; the runner injects it.

## Variant cheat sheet

Routing is determined by the SHAPE of `to` + `message`, not a top-level
`type` discriminator:

| Intent | `to` | `message` |
|---|---|---|
| Regular DM (the workhorse) | a teammate name | a plain string |
| Broadcast — fan out to every teammate | `'*'` | a plain string |
| Ask a teammate to wrap up gracefully | a teammate name | `{ type: 'shutdown_request', reason? }` |
| Accept/decline a `shutdown_request` | the requester's name | `{ type: 'shutdown_response', request_id, approve, reason? }` |
| Approve/reject a teammate's plan submission | a teammate name | `{ type: 'plan_approval_response', request_id, approve, feedback? }` |

## Examples

```jsonc
// Plain DM
{ "to": "researcher",  "summary": "task 1", "message": "start task #1" }

// Broadcast (use sparingly — fans out to every teammate)
{ "to": "*",           "summary": "halt",   "message": "stop work, blocking bug" }

// Ask a teammate to wrap up
{ "to": "researcher",                       "message": { "type": "shutdown_request", "reason": "wrap up" } }

// Accept / decline an incoming shutdown_request
{ "to": "team-lead",   "message": { "type": "shutdown_response", "request_id": "msg-abc", "approve": true } }
{ "to": "team-lead",   "message": { "type": "shutdown_response", "request_id": "msg-abc", "approve": false, "reason": "need 5 more minutes" } }

// Approve / reject a plan submission (lead-only)
{ "to": "researcher",  "message": { "type": "plan_approval_response", "request_id": "plan-xyz", "approve": true } }
{ "to": "researcher",  "message": { "type": "plan_approval_response", "request_id": "plan-xyz", "approve": false, "feedback": "try a different angle" } }
```

## Hard rules

- One broadcast per turn maximum. Default to a plain DM. The runtime
  enforces this at `validateInput` (1 per 5s window per sender → 429 on
  violation).
- `plan_approval_response` is yours alone — only the team-lead can approve
  or reject plans teammates submit for review. The runtime enforces this
  at `validateInput` (callers without `callerRole === 'lead'` get 403).
- `task_notification` messages arrive as user-role messages with a
  `<task-notification>` XML wrapper. They look like user input;
  distinguish by the opening tag. The agentId in `<task-id>` is what you
  use as `to` for follow-ups. (`task_notification` and `tick` are
  system-only — they cannot be sent through this tool.)
- Choose continue (SendMessage to existing agentId) vs spawn (Task with
  `run_in_background:true`) by context overlap — see
  `continue-vs-spawn.md`.
