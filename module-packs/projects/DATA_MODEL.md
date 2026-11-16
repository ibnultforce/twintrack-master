# Project management: data model

What the Project management API stores and returns. Module key: `projects`. Every route starts with `/projects`.

This describes records **as the API returns them**, which is what a frontend works with. The same model is in `schema.json` as JSON Schema. Routes, bodies and error codes are in `api/projects.md`.

## Reading this document

- **Type** uses JSON types. `date-time` is an ISO 8601 string such as `2026-11-13T09:30:00.000Z`. `date` is a calendar day sent as `YYYY-MM-DD` and returned as midnight UTC.
- **Always** means the field is in every response. Anything else can be missing, either because it isn't set or because field security hides it from this person.
- **Field access** says whether a profile can hide or lock the field. `controlled` fields follow the person's field access; `protected` fields are hidden unless their profile grants them. The levels are `hidden`, `read`, `create` (set on a new record only) and `edit`.
- People are referred to by **id**. Most records also return the person's name next to the id, such as `leadId` and `leadName`. A missing name means the person no longer exists.

## How the records relate

```
Client (Master) ─┐
                 │ 0..1
Project ─────────┴── lead (1 person), members (0..n people)
  │
  ├── Task (0..n) ── assignee, TL, QA person (people)
  │     ├── Comment (0..n)          never edited or deleted
  │     ├── Attachment (0..n)       up to 5 GB per task
  │     ├── HistoryEntry (0..n)     field changes, newest first
  │     └── references (0..n Tasks) links to other tasks
  │
  ├── ProjectCredential (0..n)      shared logins for the project
  └── ProjectIncentive (0..n)       one-off payment per member

Person ── PointsEntry (0..n)        career points from approved work
       ── IncentiveSetting (0..1)   rate and whether they earn incentives
       ── IncentiveMonth (0..n)     monthly payout, frozen once paid
```

## Who reaches a record

Every permission has a **scope**: `own`, `team` (the person plus everyone reporting to them, at any depth) or `all`. The API applies it; the frontend never filters records itself.

- A **project** belongs to its lead and its members.
- A **task** belongs to its assignee, its TL, its QA person and its project's lead.
- A **project login** belongs to the project's people.

If the scope reaches any of a record's people, the person can reach the record. List responses include `scope`, which says which one applied.

---

## Project

A body of work led by one person. Its tasks can only go to the lead or a member.

| Field | Type | Always | Field access | Notes |
|---|---|---|---|---|
| `id` | string | yes | | |
| `name` | string | | controlled | Required when creating |
| `description` | string | | controlled | |
| `status` | `ProjectStatus` | | controlled | New projects are `active` |
| `totalAllocatedHours` | number | | controlled | Hours budgeted for the project |
| `deadline` | date | | controlled | |
| `leadId` | string | yes | | Defaults to the creator. Always counts as a member. |
| `leadName` | string | | | |
| `members` | `PersonRef[]` | yes | | Doesn't include the lead |
| `clientId` | string | | controlled | An active Master client |
| `clientName` | string | | | |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` | | yes | | See "Record fields" |

**Rules:** a `completed` project takes no new tasks. Someone with open tasks in a project can't be removed from it, and that includes a lead being replaced.

### ProjectStatus

| Value | Label on screen | Meaning | Pill tone |
|---|---|---|---|
| `active` | Active | Work is going on | good |
| `on_hold` | On hold | Paused | warning |
| `completed` | Completed | Finished; no new tasks | neutral |

### ProjectHealth (from `GET /projects/projects/health`)

| Field | Type | Notes |
|---|---|---|
| `id`, `name`, `status`, `leadId`, `leadName` | | As on Project |
| `totalAllocatedHours` | number | Missing when hidden |
| `completedHours` | number | Approved hours of finished tasks |
| `usedShare` | number | `completedHours / totalAllocatedHours`, 0 to 1 or more. Missing with no allocated hours. |
| `openTaskCount` | number | |
| `thisMonth` | `{ tlId, tlName, hours }[]` | Hours finished this month per TL |
| `thisMonthIncentive` | number | BDT |

### Roster (from `GET /projects/projects/roster`)

- `teamLeads[]`: `id`, `name`, `projectCount`, `tasksCompletedThisMonth`, `averageVarianceHours` (actual minus estimated, on average).
- `developers[]`: `id`, `name`, `openTasks`, `completedTasks`, `totalPoints`.

---

## Task

One piece of work in a project, with a number such as `T-00102` that is never reused.

| Field | Type | Always | Field access | Notes |
|---|---|---|---|---|
| `id` | string | yes | | |
| `number` | string | yes | | Shown to people; searchable |
| `projectId` | string | yes | | |
| `projectName` | string | | | |
| `kind` | `TaskKind` | yes | controlled | |
| `title` | string | | controlled | Required when creating |
| `description` | string | | controlled | Plain text with line breaks |
| `status` | `TaskStatus` | yes | | Changed only by lifecycle steps |
| `assignedDevId` | string | yes | | The assignee. Must be the project's lead or a member. |
| `tlId` | string | yes | | Team lead. Defaults to the creator. |
| `dueDate` | date | | controlled | Today or later when set |
| `estimatedHours` | number | | controlled | Required when creating, except a tester's own QA task |
| `actualHours` | number | | controlled | Set by the timer on completion; can be corrected |
| `approvedHours` | number | | controlled | Chosen by the approver |
| `pointValue` | number | | controlled | Estimate × 50 until approval, then approved hours × 50 |
| `billable` | boolean | | controlled | Default `true` |
| `flagged` | boolean | | controlled | Raised for a follow-up, at any status |
| `flagNote` | string | | controlled | Why it's flagged |
| `paused` | boolean | yes | | The assignee's timer is paused |
| `workedSeconds` | number | yes | | Time worked so far, including a running timer, when the API answered |
| `startedAt`, `completedAt` | date-time | | | |
| `approvedBy` | string | | | |
| `approvedAt` | date-time | | | |
| `revertCount` | number | yes | | |
| `qaId` | string | | | The QA person. Never the assignee. |
| `qaEstimatedHours`, `qaActualHours`, `qaApprovedHours` | number | | **protected** | QA hours |
| `qaPointValue` | number | | **protected** | |
| `qaPaused` | boolean | yes | | |
| `qaCompletedAt` | date-time | | | |
| `qaResult` | `QaResult` | | controlled | Visible unless set to hidden |
| `cancelledBy` | string | | | |
| `cancelledAt` | date-time | | | |
| record fields | | yes | | |

`GET /projects/tasks/:id` also returns `references` and `referencedBy`, each a list of `TaskLink`.

### TaskStatus

| Value | Label on screen | Meaning | Pill tone |
|---|---|---|---|
| `todo` | To do | Not started | neutral |
| `in_progress` | In progress | The assignee is working on it (may be paused) | accent |
| `pending_approval` | Pending approval | Finished, waiting for approval | warning |
| `qa_todo` | QA to do | Handed to QA, not started | neutral |
| `qa_in_progress` | QA in progress | QA is testing it (may be paused) | accent |
| `done` | Done | Approved | good |
| `reverted` | Reverted | Sent back for a fix | danger |
| `cancelled` | Cancelled | Stopped; never deleted | neutral |

A task is **open** unless it's `done` or `cancelled`, and **overdue** when it's open and its `dueDate` has passed. Show extra pills beside the status for "Paused" (neutral), "Overdue" (danger), "Flagged" (warning), "QA task" (accent) and "Not billable" (neutral).

### Task lifecycle

```
todo ──start──▶ in_progress ──complete──▶ pending_approval ──approve──▶ done
                  ▲  (pause/start)            │      ▲                    │
reverted ─start───┘                qa-handover│      │qa-complete         │
   ▲                                          ▼      │                    │
   └──────────── revert ◀─────── qa_todo ─qa-start─▶ qa_in_progress       │
   └──────────────────────────────────── revert ◀─────────────────────────┘
Any status except done and cancelled ──cancel──▶ cancelled
```

| Step | Who | From | Needs |
|---|---|---|---|
| Start, pause, complete | The assignee only | `todo`, `in_progress`, `reverted` | `task.read` |
| Hand to QA | | `pending_approval` | `task.update`; not on a QA task |
| Set QA estimate | | `qa_todo`, or `qa_in_progress` with none yet | `task.update` |
| QA start, pause, complete (pass or fail) | The QA person only | `qa_todo`, `qa_in_progress` | `task.read`; starting needs a QA estimate |
| Approve | Not the assignee or QA person | `pending_approval` | `task.approve` |
| Revert (with a comment) | Not the assignee or QA person | `pending_approval`, `done` | `task.approve` |
| Cancel | | anything but `done`, `cancelled` | `task.delete` |
| Edit, reassign | | anything but `done`, `cancelled` | `task.update` |

Approving chooses hours for the work, and for QA if it went through QA, each as `estimated`, `actual` or `custom` (above zero, at most the larger of estimated and actual).

### TaskKind

| Value | Meaning |
|---|---|
| `development` | Normal work |
| `qa` | A tester's own work, such as writing test cases. Records pass or fail on completion and is never handed to QA. |

### QaResult

`pass` or `fail`.

### TaskLink

`id`, `number`, `status`. Used for links between tasks.

### TaskSearchResult (from `GET /projects/tasks/search`)

A `TaskLink` plus `title` and `projectName`. Up to 15, for pickers.

### TaskTotals (from `GET /projects/tasks/summary`)

`scope`, `taskCount`, and sums of `estimatedHours`, `actualHours`, `varianceHours` and `pointValue`. A sum is missing when its field is hidden from the person.

---

## Comment

| Field | Type | Always | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `authorId` | string | yes | |
| `authorName` | string | | |
| `body` | string | yes | Plain text |
| `createdAt` | date-time | yes | |

Oldest first. Never edited or deleted. A revert adds its reason as a comment.

## HistoryEntry

| Field | Type | Always | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `at` | date-time | yes | |
| `action` | `created`, `updated`, `deleted` or `restored` | yes | |
| `changes` | `{ field, from, to }[]` | yes | Only fields the person may see |
| `actorName` | string | yes | |

Newest first. Tasks track: title, status, estimated hours, due date, assignee, TL, QA person, QA estimate, approved hours, QA approved hours, QA result, billable, flag, flag note, actual hours, points and kind. Projects track: name, status, deadline, lead, members, allocated hours and client.

## Attachment

A file on a task. Uploaded straight from the browser to storage in parts.

| Field | Type | Always | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `fileName` | string | yes | As uploaded |
| `mimeType` | string | yes | |
| `sizeBytes` | number | yes | |
| `status` | `uploading` or `ready` | yes | Show only `ready` files as openable |
| `uploadedBy` | string | yes | |
| `uploadedByName` | string | | |
| `createdAt` | date-time | yes | |

The list also returns `usedBytes` and `limitBytes` (5 GB per task). See "Files on tasks" in `api/projects.md` for the upload steps.

## ProjectCredential

A login the project's people share, such as a client's test site. Every field except `id`, `projectId`, `version` and the dates follows field access.

| Field | Type | Notes |
|---|---|---|
| `id`, `projectId` | string | Always |
| `label` | string | Such as "Client staging" |
| `loginUrl` | string | http or https only |
| `username`, `password`, `passcode` | string | Shown only when field access allows |
| `hasOtp` | boolean | Whether it has a one-time code |
| `otpCode` | string | The current code. The secret is never returned. |
| `otpSecondsRemaining` | number | Until the code changes |
| `notes` | string | |
| `version` | number | Always |
| `createdByName`, `createdAt`, `updatedByName`, `updatedAt` | | |

## PointsEntry

Career points: 50 per approved hour of work or QA. Every revert takes 5% of the task's points from whoever did the work.

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `points` | number | Negative for penalties and reversals |
| `reason` | `task_approved`, `qa_approved`, `approval_reversed` or `revert_penalty` | |
| `taskId`, `taskNumber`, `taskTitle` | string | |
| `createdAt` | date-time | |

`GET /projects/points` returns each person in scope with `userId`, `name` and `totalPoints`, highest first.

## Incentives

Amounts are in Bangladeshi taka (BDT).

**IncentiveSetting** (one per person): `userId`, `name`, `earnsMonthlyIncentive` (boolean), `hourlyRate` (missing means the default), `effectiveHourlyRate`, `eligibleForProjectIncentives` (boolean), `updatedAt`.

**IncentiveMonth** (from `GET /projects/incentives`): `month`, `year`, `scope`, `totalPayout`, and `people[]`, each with `userId`, `name`, `completedHours` (approved hours of tasks they led that finished in the month), `hourlyRate`, `totalPayout`, `ledgerId`, `disbursed`, `disbursedAt`. A paid month is frozen.

**ProjectIncentive** (from `GET /projects/projects/:id/incentives`): per project person, `userId`, `name`, `eligible`, and `grant` (`enabled`, `amount`, `notes`, `grantedByName`, `updatedAt`) when one has been given.

**Rule:** nobody changes their own setting, pays themselves or gives themselves a project incentive.

---

## Shared types

**PersonRef:** `id` (always) and `name`.

**Record fields:** projects, tasks and logins carry `version` (send it back with an edit; a `409 version_conflict` means someone changed the record since), `createdBy`, `createdAt`, `updatedBy`, `updatedAt`.

**List pages:** `page` (from 1) and `pageSize` (up to 100) in the query; the answer has `total` and the list.

**Errors:** every error is `{ "error": { "code", "message", "fields"? } }`. Show `message`, which is written for people. Common codes: `403 forbidden` (no permission), `403 out_of_scope`, `403 field_not_editable`, `404 unknown_*`, `409 version_conflict`, `409 invalid_status`, `422 validation_failed` (with `fields`).
