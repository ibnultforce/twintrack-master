# Tasks API

Projects, their members, and tasks from first start through QA to approval. Every route starts with `/tasks`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

Not built yet: points and the revert penalty, invoices and billing, project credentials and incentives, file attachments, and flagging. They have no fields or routes.

## Getting access

A person reaches Tasks through their profile, or through a Tasks permission set given with `PUT /users/:id/permission-sets` and `"module": "tasks"`. No profiles or permission sets ship with the product. Holding `access.update` in Tasks lets someone give or take away anyone's Tasks permission sets.

| Permission | Lets someone |
|---|---|
| `project.read`, `project.create`, `project.update` | See, create and change projects, and set their members |
| `task.read` | See tasks, comment, read history, and run their own timer or QA timer |
| `task.create` | Create tasks |
| `task.update` | Change open tasks, hand them to QA and link them |
| `task.approve` | Approve and revert |
| `task.delete` | Cancel. Tasks are never deleted. |

**Reach.** A project belongs to its lead and members. A task belongs to its assignee, its TL, its QA person and its project's lead. If the scope reaches any of them, it reaches the record. Anything else gets `403 out_of_scope`.

**Rules about people.** These come from the task's own fields, not from anyone's permissions:

- Only the assignee starts, pauses and completes a task (`403 not_assignee`), and only its QA person runs QA (`403 not_qa`).
- Nobody approves or reverts a task they worked on or tested (`403 own_work`).
- The assignee and QA person must be the project lead or a member, and the QA person can't be the assignee.

**QA hours** (`qaEstimatedHours`, `qaActualHours`, `qaApprovedHours`) are protected fields. They're left out of responses and history unless a grant's `fieldAccess` gives `read` or `edit`, and setting one needs `edit` (`403 field_not_editable`). `qaResult` is visible to everyone who can read the task.

## Projects

A project has `id`, `name`, `description`, `status` (`active`, `on_hold` or `completed`), `totalAllocatedHours`, `deadline`, `leadId`, `leadName`, `members` (each with `id` and `name`), `version`, `createdBy`, `createdAt`, `updatedBy` and `updatedAt`. The lead always counts as a member and isn't listed in `members`.

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /tasks/projects` | `project.read` | `page`, `pageSize`, `status` | Returns `scope`, `total`, `projects` |
| `POST /tasks/projects` | `project.create` | `name`, and optionally `description`, `totalAllocatedHours`, `deadline`, `leadId` (default: the caller), `memberIds` | `201`. The scope must reach the lead or a member. |
| `GET /tasks/projects/:id` | `project.read` | | `404 unknown_project` |
| `PATCH /tasks/projects/:id` | `project.update` | Any of `name`, `description`, `totalAllocatedHours`, `deadline`, `leadId`, `status`, and `version` | |
| `PUT /tasks/projects/:id/members` | `project.update` | `memberIds`, `version` | Replaces the list. `409 member_has_open_tasks` if a removed person still has open tasks there. |

A completed project takes no new tasks (`409 project_closed`).

## Tasks

A task has `id`, `number` (such as `T-00102`, never reused), `projectId`, `projectName`, `title`, `description`, `status`, `assignedDevId`, `tlId`, `dueDate`, `estimatedHours`, `actualHours`, `approvedHours`, `paused`, `workedSeconds` (live, including a running timer), `startedAt`, `completedAt`, `approvedBy`, `approvedAt`, `revertCount`, `qaId`, the QA hours, `qaPaused`, `qaCompletedAt`, `qaResult` (`pass` or `fail`), `cancelledBy`, `cancelledAt` and the record fields. `GET /tasks/tasks/:id` also returns `references` and `referencedBy`, each with `id`, `number` and `status`.

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
| `GET /tasks/tasks` | `task.read` | `page`, `pageSize`, `projectId`, `status`, `assignedDevId`, `overdue=true` | Overdue means past `dueDate` and not done or cancelled |
| `POST /tasks/tasks` | `task.create` | `projectId`, `title`, `assignedDevId`, `estimatedHours`, and optionally `description`, `tlId` (default: the caller), `dueDate` | `201`, as `todo` |
| `GET /tasks/tasks/:id` | `task.read` | | `404 unknown_task` |
| `PATCH /tasks/tasks/:id` | `task.update` | Any of `title`, `description`, `assignedDevId`, `tlId`, `estimatedHours`, `dueDate`, and `version` | Not on done or cancelled tasks. Reassigning while the timer runs gets `409 timer_running`. |
| `POST /tasks/tasks/:id/start`, `/pause`, `/complete` | `task.read` | | The assignee's timer. Completing sets `actualHours`. |
| `POST /tasks/tasks/:id/qa-handover` | `task.update` | `qaId`, optionally `qaEstimatedHours` | Starts a new QA round |
| `POST /tasks/tasks/:id/qa-start`, `/qa-pause` | `task.read` | | The QA person's timer |
| `POST /tasks/tasks/:id/qa-complete` | `task.read` | `result` (`pass` or `fail`) | Sets `qaActualHours` and sends the task for approval |
| `POST /tasks/tasks/:id/approve` | `task.approve` | `hours`, and `qaHours` if the task went through QA, each `{ "basis": "estimated" \| "actual" \| "custom", "customHours" }`, and `version` | Custom hours must be above zero and no more than the larger of estimated and actual |
| `POST /tasks/tasks/:id/revert` | `task.approve` | `comment` | From `pending_approval` or `done`. Saves the comment, adds one to `revertCount` and clears the approval. |
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
