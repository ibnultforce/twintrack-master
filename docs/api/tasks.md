# Tasks API

Projects, their members, and tasks from first start through QA to approval. Every route starts with `/tasks`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

Also here: career points and the revert penalty, project logins with one-time codes, task files, and monthly and project incentives. Invoices are in the [Accounts API](accounts.md), which bills tasks at their estimate and sets `invoiceId` on each task it bills.

## Getting access

A person reaches Tasks through their profile, given with `PUT /users/:id/profile`. No profiles ship with the product.

| Permission | Lets someone |
|---|---|
| `project.read`, `project.create`, `project.update` | See, create and change projects, and set their members |
| `task.read` | See tasks, comment, read history, and run their own timer or QA timer |
| `task.create` | Create tasks |
| `task.update` | Change open tasks, hand them to QA and link them |
| `task.approve` | Approve and revert |
| `task.delete` | Cancel. Tasks are never deleted. |
| `points.read` | See points within the scope |
| `credential.read`, `.create`, `.update`, `.delete` | See and manage a project's logins |
| `incentive.read`, `.create`, `.update` | See incentives; `create` saves a month's figures; `update` pays, changes settings and gives project incentives |

**Reach.** A project belongs to its lead and members. A task belongs to its assignee, its TL, its QA person and its project's lead. If the scope reaches any of them, it reaches the record. Anything else gets `403 out_of_scope`.

**Rules about people.** These come from the task's own fields, not from anyone's permissions:

- Only the assignee starts, pauses and completes a task (`403 not_assignee`), and only its QA person runs QA (`403 not_qa`).
- Nobody approves or reverts a task they worked on or tested (`403 own_work`).
- The assignee and QA person must be the project lead or a member, and the QA person can't be the assignee, including by reassigning the task to them while their QA round is open or its result stands (`422`).

**Field access** controls a project's `name`, `description`, `status`, `totalAllocatedHours` and `deadline`, and a task's `title`, `description`, `dueDate`, `estimatedHours`, `actualHours`, `approvedHours`, `qaResult` and QA hours. A field the grant doesn't name follows its actions. Steps such as start or approve set status and hours themselves, and those aren't checked as writes. **QA hours** (`qaEstimatedHours`, `qaActualHours`, `qaApprovedHours`) are protected fields. They're left out of responses and history unless a grant's `fieldAccess` gives `read`, `create` or `edit`, and setting one needs `edit`, since tasks set them only on records that already exist (`403 field_not_editable`). `qaResult` is visible to everyone who can read the task, unless a grant sets it to `hidden`.

## Projects

A project has `id`, `name`, `description`, `status` (`active`, `on_hold` or `completed`), `totalAllocatedHours`, `deadline`, `leadId`, `leadName`, `clientId` and `clientName` (an active Master client, else `422`), `members` (each with `id` and `name`), `version`, `createdBy`, `createdAt`, `updatedBy` and `updatedAt`. The lead always counts as a member and isn't listed in `members`.

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /tasks/projects` | `project.read` | `page`, `pageSize`, `status` | Returns `scope`, `total`, `projects` |
| `GET /tasks/projects/health` | `project.read` | optionally `leadId` | Each project in reach: `completedHours`, `usedShare` of allocated hours, `openTaskCount`, this month's finished hours per TL (`thisMonth`) and `thisMonthIncentive` |
| `GET /tasks/projects/roster` | `project.read` | optionally `leadId` | `teamLeads` (projects, tasks done this month, average hours over or under estimate) and `developers` (open and done tasks, `totalPoints`) |
| `POST /tasks/projects` | `project.create` | `name`, and optionally `description`, `totalAllocatedHours`, `deadline`, `leadId` (default: the caller), `clientId`, `memberIds` | `201`. The scope must reach the lead or a member. |
| `GET /tasks/projects/:id` | `project.read` | | `404 unknown_project` |
| `PATCH /tasks/projects/:id` | `project.update` | Any of `name`, `description`, `totalAllocatedHours`, `deadline`, `leadId`, `clientId`, `status`, and `version` | The old lead leaves the project when replaced, so `409 member_has_open_tasks` while they still have open tasks there |
| `PUT /tasks/projects/:id/members` | `project.update` | `memberIds`, `version` | Replaces the list. `409 member_has_open_tasks` if a removed person still has open tasks there. |

A completed project takes no new tasks (`409 project_closed`).

## Tasks

A task has `id`, `number` (such as `T-00102`, never reused), `projectId`, `projectName`, `kind` (`development` or `qa`), `title`, `description`, `status`, `assignedDevId`, `tlId`, `dueDate`, `estimatedHours`, `actualHours`, `approvedHours`, `pointValue`, `qaPointValue`, `billable` (default `true`), `flagged`, `flagNote`, `paused`, `workedSeconds` (live, including a running timer), `startedAt`, `completedAt`, `approvedBy`, `approvedAt`, `revertCount`, `qaId`, the QA hours, `qaPaused`, `qaCompletedAt`, `qaResult` (`pass` or `fail`), `cancelledBy`, `cancelledAt` and the record fields. `GET /tasks/tasks/:id` also returns `references` and `referencedBy`, each with `id`, `number` and `status`.

### Lifecycle

```
todo ──start──▶ in_progress ──complete──▶ pending_approval ──approve──▶ done
                  ▲  (pause/start)            │      ▲                    │
reverted ─start───┘                qa-handover│      │qa-complete         │
   ▲                                          ▼      │                    │
   └──────────── revert ◀─────── qa_todo ─qa-start─▶ qa_in_progress       │
   └──────────────────────────────────── revert ◀─────────────────────────┘
Any status except done and cancelled ──cancel──▶ cancelled
```

Being paused is a flag on `in_progress` and `qa_in_progress`, not a status. A step from the wrong status gets `409 invalid_status`. Starting a running timer, or pausing a paused one, gets `409 timer_running` or `409 timer_paused`. Every step saves against the version it read, so two steps racing on one task can't both apply (`409 version_conflict`).

| Route | Needs | Body | What it does |
|---|---|---|---|
| `GET /tasks/tasks` | `task.read` | `page`, `pageSize`, the filters below, `sortBy` (`createdAt`, `dueDate`, `estimatedHours`, `actualHours`, `variance`, `pointValue`), `sortDirection` | Overdue means past `dueDate` and not done or cancelled |
| `GET /tasks/tasks/summary` | `task.read` | The filters | `taskCount`, and sums of `estimatedHours`, `actualHours`, `varianceHours`, `pointValue`. A sum of a field hidden from the caller is left out. |
| `GET /tasks/tasks/export` | `task.read` | The filters | CSV, one row per task, up to a cap. Hidden fields are empty, and cells starting with `=`, `+`, `-` or `@` are quoted so spreadsheets don't run them. |
| `GET /tasks/tasks/search` | `task.read` | `search` | Up to 15 tasks by title or number, with `title` and `projectName`, for pickers |
| `POST /tasks/tasks` | `task.create` | `projectId`, `title`, `assignedDevId`, `estimatedHours`, and optionally `description`, `tlId` (default: the caller), `kind`, `dueDate` (today or later), `billable`, `referencedTaskIds` | `201`, as `todo`. A tester adding a QA task for themselves may leave out `estimatedHours`. |
| `GET /tasks/tasks/:id` | `task.read` | | `404 unknown_task` |
| `PATCH /tasks/tasks/:id` | `task.update` | Any of `title`, `description`, `assignedDevId`, `tlId`, `estimatedHours`, `dueDate`, and `version` | Not on done or cancelled tasks. Reassigning while the timer runs gets `409 timer_running`. |
| `POST /tasks/tasks/:id/start`, `/pause`, `/complete` | `task.read` | `complete` takes `result` on a QA task, and nothing on others | The assignee's timer. Completing sets `actualHours`. |
| `POST /tasks/tasks/:id/qa-handover` | `task.update` | `qaId`, optionally `qaEstimatedHours` | Starts a new QA round. `409 qa_task` for a QA task. |
| `PATCH /tasks/tasks/:id/qa-estimate` | `task.update` | `qaEstimatedHours`, `version` | From `qa_todo`, or from `qa_in_progress` while there is no estimate yet. Otherwise `409 qa_estimate_locked` once QA has started. |
| `POST /tasks/tasks/:id/qa-start`, `/qa-pause` | `task.read` | | The QA person's timer. Starting needs a QA estimate (`409 qa_estimate_missing`). |
| `POST /tasks/tasks/:id/qa-complete` | `task.read` | `result` (`pass` or `fail`) | Sets `qaActualHours` and sends the task for approval |
| `POST /tasks/tasks/:id/approve` | `task.approve` | `hours`, and `qaHours` if the task went through QA, each `{ "basis": "estimated" \| "actual" \| "custom", "customHours" }`, and `version` | Custom hours must be above zero and no more than the larger of estimated and actual |
| `POST /tasks/tasks/:id/revert` | `task.approve` | `comment`, optionally `assignedDevId` | From `pending_approval` or `done`. Saves the comment, adds one to `revertCount`, clears the approval, takes the penalty, and can give the fix to someone else. |
| `PATCH /tasks/tasks/:id/flag` | `task.update` | `flagged`, optionally `flagNote` | Any status. Clearing removes the note. |
| `PATCH /tasks/tasks/:id/billable` | `task.update` | `billable` | Not on cancelled tasks |
| `PATCH /tasks/tasks/:id/actual-hours` | `task.update` | `actualHours`, `version` | Corrects the timer. `409 no_actual_hours` before completion. Approved hours and points don't change. |
| `POST /tasks/tasks/:id/cancel` | `task.delete` | | |
| `GET /tasks/tasks/:id/history` | `task.read` | `page`, `pageSize` | Tracked fields come from `trackedFields` in the manifest |
| `GET /tasks/tasks/:id/comments` | `task.read` | `page`, `pageSize` | Oldest first. Each has `id`, `authorId`, `authorName`, `body`, `createdAt`. |
| `POST /tasks/tasks/:id/comments` | `task.read` | `body` | `201`. Comments are never edited or deleted. |
| `PUT /tasks/tasks/:id/references` | `task.update` | `taskIds` | Replaces the links. Each must exist and can't be the task itself. |

```sh
curl -X POST "$API/tasks/tasks/$TASK_ID/approve" \
  -H "Authorization: Bearer eyJ..." -H "Content-Type: application/json" \
  -d '{"hours":{"basis":"custom","customHours":6},"qaHours":{"basis":"actual"}}'
```

The list, summary and export share these filters: `projectId`, `status`, `assignedDevId`, `tlId`, `overdue`, `flagged`, `billable`, `mine` (projects the caller leads), `search` (title, or a number such as `T-0042`), `completedFrom` and `completedTo` (both days counted). Yes-or-no filters take `true` or `false`. Tasks saved before flags and billing existed count as not flagged and billable. The summary leaves out `varianceHours` when actual or estimated hours are hidden from the caller.

## Points

Points are career credit. A task's `pointValue` is its estimate times 50 until approval, then its approved hours times 50; `qaPointValue` works the same for QA hours. Approving gives the assignee `pointValue` and the QA person `qaPointValue`. Every revert, from pending approval or from done, takes 5% of the task's points from whoever did the work, even when someone else fixes it, as in the old app. Reverting a done task also takes back what its approval gave the assignee and QA (`approval_reversed`), so approving it again never counts twice, and clears the finished QA round, which tested the work being sent back. Giving the fix to someone else starts their timer from zero. Entries are written in the same transaction as the step.

| Route | Needs | Query | Notes |
|---|---|---|---|
| `GET /tasks/points` | `points.read` | `page`, `pageSize`, `since` | Each person in scope with `totalPoints`, highest first |
| `GET /tasks/points/:userId` | `points.read` | `page`, `pageSize`, `since` | `totalPoints` and `entries` (`points`, `reason`: `task_approved`, `qa_approved`, `approval_reversed` or `revert_penalty`, `taskNumber`, `taskTitle`, `createdAt`). `403 out_of_scope` outside the scope. |

## Project logins

Logins the project's people share, such as a client's sandbox. Passwords, passcodes and one-time-code secrets are encrypted with `ENCRYPTION_KEY`. The API returns the current `otpCode` and `otpSecondsRemaining`, never the secret. Answers carry `Cache-Control: no-store`. A scope reaching any of the project's people reaches its logins, and field access applies to each field.

| Route | Needs | Body | Notes |
|---|---|---|---|
| `GET /tasks/projects/:id/credentials` | `credential.read` | | `credentials` |
| `POST /tasks/projects/:id/credentials` | `credential.create` | `label`, `loginUrl` (an `http` or `https` address only), `username`, `password`, optionally `otpSecret` (an `otpauth://` link or the base32 secret), `passcode`, `notes` | `201` |
| `PATCH /tasks/projects/:id/credentials/:credentialId` | `credential.update` | Any of those, and `version`. `null` removes `otpSecret` or `passcode`. | `404 unknown_credential` |
| `DELETE /tasks/projects/:id/credentials/:credentialId` | `credential.delete` | | |

## Files on tasks

Anyone who reaches a task can add a file, as with comments. Files go straight from the browser to storage in 64 MB parts: Cloudflare R2 when the `R2_*` settings are set (required in production), otherwise the local folder `STORAGE_DIR`, served by the signed `/files` routes in Master. A task holds 5 GB in all, counting uploads in progress (`413 attachment_limit`). Space is claimed atomically in `task_attachment_usage`, so two uploads at once can't both take the last of it. Uploads left unfinished for a day are cleared.

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /tasks/tasks/:id/attachments` | `task.read` | | `attachments`, `usedBytes`, `limitBytes` |
| `POST /tasks/tasks/:id/attachments` | `task.read` | `fileName`, `sizeBytes`, optionally `mimeType` | `201` with `attachment`, `partSize`, `partCount` |
| `POST /tasks/tasks/:id/attachments/:attachmentId/part-urls` | `task.read` | `partNumbers` | Signed addresses to `PUT` each part to. Each answer's `ETag` header is needed to finish. Only the uploader (`403 not_your_upload`). |
| `POST /tasks/tasks/:id/attachments/:attachmentId/complete` | `task.read` | `parts` (`partNumber`, `etag`) | Joins the parts and checks the size (`422 size_mismatch`) |
| `GET /tasks/tasks/:id/attachments/:attachmentId/url` | `task.read` | `mode` (`view` or `download`) | A short-lived address. Types a browser could run, such as HTML, always download. |
| `DELETE /tasks/tasks/:id/attachments/:attachmentId` | `task.read` | | The uploader, or someone who can edit the task |

## Incentives

Each person has an incentive setting: whether they earn the **monthly incentive**, their hourly rate (missing uses `INCENTIVE_HOURLY_RATE_BDT`), and whether they can be given **project incentives**. The monthly incentive is the approved hours of tasks they led (as TL or project lead) that finished in the month, times their rate, so the approver's choice of hours sets the money and a later timer correction doesn't. Nobody changes their own setting, pays themselves or gives themselves a project incentive (`403 own_incentive`). Figures are worked out from tasks until a month is paid, which freezes them. Amounts are in BDT.

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /tasks/incentives` | `incentive.read` | `month`, `year` (default: this month) | Everyone in scope who earns, with `completedHours`, `hourlyRate`, `totalPayout`, `disbursed` |
| `POST /tasks/incentives/generate` | `incentive.create` | `month`, `year` | Saves the figures, leaving paid entries alone. Returns `generated` and `skippedAsPaid`. |
| `POST /tasks/incentives/disburse` | `incentive.update` | `userId`, `month`, `year` | Pays one person's month. `409 already_paid`, `409 not_an_earner`. |
| `GET /tasks/incentives/ledger` | `incentive.read` | `userId`, `month`, `year` | Saved and paid months, newest first |
| `GET /tasks/incentives/settings` | `incentive.read` | | `defaultHourlyRate` and `settings` |
| `PUT /tasks/incentives/settings/:userId` | `incentive.update` | `earnsMonthlyIncentive`, `hourlyRate` (`null` for the default), `eligibleForProjectIncentives` | |
| `GET /tasks/projects/:id/incentives` | `incentive.read` | | The project's people within the scope, each with `eligible` and any `grant`. An own scope sees only itself. |
| `PUT /tasks/projects/:id/incentives/:userId` | `incentive.update` | `enabled`, `amount`, `notes` | `409 not_eligible` unless their setting allows it. `403 out_of_scope` for a member the scope doesn't reach. |

## MCP tools

Apps connected over MCP get the Tasks tools `list_projects`, `list_project_members`, `get_workload`, `list_tasks`, `get_task`, `create_task`, `bulk_create_tasks`, `update_task`, `reassign_task` and `hand_over_to_qa`. They act as the connected person, with the same access checks, and take people and projects by name. `get_workload` needs `project.read` and `task.read`, and counts only tasks the caller's task scope reaches.
