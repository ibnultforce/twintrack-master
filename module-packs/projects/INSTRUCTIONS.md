# Project management frontend: instructions

These are the instructions for building the **Project management** frontend of TwinTrack. Put this whole folder in the new project as `docs/` and point Claude Code at this file first. Other people are building other TwinTrack modules from instructions just like these, so **follow them exactly, and when they don't cover something, choose the simplest option that matches what's already here.**

## Files in this pack

| File | What it is |
|---|---|
| `INSTRUCTIONS.md` | This file: what to build and how |
| `DATA_MODEL.md` | Every record, field, allowed value and rule, explained |
| `schema.json` | The same data model as JSON Schema. Generate the TypeScript types from it |
| `design.css` | The shared TwinTrack stylesheet, written with Tailwind CSS. Use it unchanged |
| `api/projects.md` | Every route: what it takes, what it returns, and its errors |
| `api/README.md` | Signing in, tokens, the error format and errors any route returns |
| `api/manifest.json` | Routes, permissions and field rules, as the backend loads them |
| `api/postman_collection.json` | Working requests for every route |

When these disagree, `api/projects.md` wins, then `DATA_MODEL.md`. Never invent a route, field, permission or value that isn't in them; if something you need is missing, stop and say so.

## 1. What you're building

A web app where people work on projects and tasks: a list of tasks with filters, a task page with the timer, QA, approval, comments, files and history, projects with members and shared logins, and reports on project health, team workload, career points and incentives.

It has **no backend of its own**. Everything comes from the TwinTrack API (the Master backend), which also decides who may see and do what. People sign in at the Master frontend; this app reuses that session.

## 2. Stack and project setup

- **Next.js (App Router), React and TypeScript** with `strict: true` and `noUncheckedIndexedAccess: true`. Node 22 or later.
- **Tailwind CSS v4 is the one styling dependency:** `tailwindcss`, `@tailwindcss/postcss` and `postcss`, with a `postcss.config.mjs` beside `package.json` that holds `export default { plugins: { '@tailwindcss/postcss': {} } };`.
- **No other dependencies.** No UI kits, other CSS frameworks, icon packs, state, form, date, data-fetching or upload libraries. Write small pieces by hand.
- Scripts: `dev` (port 3300), `build`, `typecheck`.
- Settings, in `.env.local` (with a matching `.env.example`):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | The API address, given with this pack |
| `NEXT_PUBLIC_MASTER_URL` | The Master frontend, where people sign in |
| `NEXT_PUBLIC_APP_URL` | Where this app is opened. The API only accepts calls from addresses it knows, so use the one you're given |

### Folders

```
src/
  app/
    layout.tsx                 root layout: imports globals.css, wraps everything in SessionProvider
    globals.css                design.css, unchanged, then a "Module additions" section at the end
    (app)/layout.tsx           the signed-in shell (sidebar + gates)
    (app)/page.tsx             sends people to the first screen their access includes
    (app)/<screen>/page.tsx    one folder per screen; details in [id]/page.tsx
  components/                  ui.tsx (shared building blocks), Dialog.tsx, AppShell.tsx, then one file per area
  lib/
    api/http.ts                the only place that calls fetch
    api/<area>.ts              one small function per route
    api/types.ts               types generated from schema.json
    format.ts                  every displayed date, time, number, money and label
    useLoad.ts, useSubmit.ts   loading and saving state
  session/SessionProvider.tsx  the session, permissions and field access
```

Screens never call `fetch` or `http.ts` directly; they call functions from `lib/api/<area>.ts`.

## 3. Signing in and the API client

Follow `api/README.md`. In short:

- **Start-up:** call `POST /auth/refresh` with `credentials: 'include'`. A `200` gives an `accessToken`; anything else means signed out. Then load `GET /auth/me` and `GET /me/permissions/projects`.
- Keep the access token **in memory only**, never in storage. Send it as `Authorization: Bearer <token>` on every call, always with `credentials: 'include'`.
- On `401` with code `no_token`, `invalid_token` or `token_expired`, refresh **once** (one refresh shared by every call waiting on it) and retry. If the refresh fails, the session has ended: show the signed-out gate.
- A `5xx` or `429` from refresh is an outage, not a sign-out: show "TwinTrack can't be reached".
- **Sign out:** `POST /auth/logout`, then clear the token and show the signed-out gate.
- A `204` has no body.
- Errors arrive as `{ error: { code, message, fields } }` (`ApiError` in the schema). Show `message`, plus each field problem. A failed `fetch` (no answer at all) shows "The API can't be reached. Check that it is running, then try again."

The session exposes `status` (`loading`, `signed-out`, `no-access`, `signed-in`, `unavailable`), `profile`, `profileName`, `can(permission)` and `mayWriteField(field, 'create' | 'update')`.

## 4. Access: the API decides, the screen follows

From `GET /me/permissions/projects` (`ModuleAccess` in the schema):

- `hasAccess: false`, or a `403`/`404` from that call, shows the **no-access gate**: "No access to Project management. Your profile doesn't include Project management. Ask whoever gives profiles in your organisation." with a "Back to TwinTrack" link to `<MASTER_URL>/modules`.
- `can('task.approve')` is true when `permissions['task.approve']` exists. Show a screen, button or menu item **only** when the person holds its permission (permissions are listed in `DATA_MODEL.md` and `api/projects.md`).
- `mayWriteField('task.estimatedHours', 'update')` is true for a super admin, or when `fieldAccess` gives `edit` (or `create` when creating). Show an editable input only when it's true; otherwise show the value read-only, or leave it out of the form.
- **Fields can be missing** because field security hides them. Every optional field in `schema.json` may be absent: show `·` (a middle dot) for it, never `undefined`, `0` or an empty cell.
- Scope (`own`, `team`, `all`) is applied by the API. Never filter or hide records in the browser to imitate it.
- **Rules about people** come from the record, not permissions: only the assignee (`assignedDevId`) sees start, pause and complete; only the QA person (`qaId`) sees the QA buttons; the assignee and QA person never see approve or revert on their own task. Compare with `profile.id`.
- Never check profile names, titles or departments in code.

## 5. Screens

Sidebar, in this order, under the heading "Work". Each entry shows only with its permission. The sidebar ends with a "TwinTrack" group holding "All modules" (link to `<MASTER_URL>/modules`), and a footer with the profile name (or "Super admin"), the person's name and "Sign out".

| Path | Sidebar label | Needs |
|---|---|---|
| `/tasks` | Tasks | `task.read` |
| `/projects` | Projects | `project.read` |
| `/health` | Project health | `project.read` |
| `/team` | Team | `project.read` |
| `/points` | Points | `points.read` |
| `/incentives` | Incentives | `incentive.read` |

`/` sends people to the first of these they may open, or says "Your Project management profile doesn't include any screens yet."

### Tasks (`/tasks`)
- Head: "Tasks", subtitle "Work across your projects, from start through QA to approval." Action "New task" with `task.create`.
- Filters: status chips (All, then each status), project, assignee, TL, overdue, flagged, billable, "Only my projects" (`mine`), search by title or number, completed from/to. Changing a filter goes back to page 1.
- Totals line from `GET /projects/tasks/summary` with the same filters: task count, estimated, actual, variance hours and points (leave out any total the API leaves out).
- Table: number (link to the task), title with pills (QA task, Flagged, Not billable), project, assignee, status pill plus "Paused", due date plus "Overdue", estimated hours, actual hours. Sortable by the `sortBy` values the API accepts. 25 per page.
- "Export CSV" downloads `GET /projects/tasks/export` with the current filters.

### Task (`/tasks/[id]`)
- Head: "T-00102 · title", status pill. Actions shown by role and status, following the step table in `DATA_MODEL.md`: Start / Pause / Complete (assignee), Hand to QA, Start QA / Pause QA / Complete QA with pass or fail (QA person), Approve, Revert, Cancel, Edit.
- **Timer card:** a live clock from `workedSeconds` that keeps counting on screen while running (and the same for QA). Show "Paused" when paused.
- **Details card:** project, assignee, TL, QA person, due date, kind, billable, flag and note, estimated, actual and approved hours, points, QA hours (only when present), revert count, dates.
- **Approve dialog:** hours basis for the work (estimated, actual or custom with a number), and for QA when the task went through QA. Show the estimated and actual figures next to each choice.
- **Revert dialog:** a required comment, and optionally a different assignee.
- **Links card:** `references` and `referencedBy` as task numbers with status; edit with a task search picker (`GET /projects/tasks/search`).
- **Comments card:** oldest first, author and time, a box to add one. Never edit or delete.
- **Files card:** list with size, uploader and date; open or download through the short-lived URL; delete for the uploader or an editor; upload following "Files on tasks" in `api/projects.md` (parts, ETags, then complete), with a progress bar. Show used of 5 GB.
- **History card:** newest first, "actor changed field from → to", paged.
- Flag, billable and actual-hours corrections are small dialogs from the details card, shown with `task.update`.

### Projects (`/projects`) and Project (`/projects/[id]`)
- List: status chips, table of name (link), lead, member count, status pill, deadline, allocated hours. Action "New project" with `project.create`.
- Project page: details (with "Edit" for `project.update`), members (lead first, marked "Lead"; "Change members" dialog), the project's tasks (the task table filtered to the project), **Logins** card with `credential.read` (label, link, username, password and passcode hidden behind "Show", the current one-time code with seconds left, refreshing when it runs out; add, edit, delete by permission), **Incentives** card with `incentive.read` (each member, eligible or not, and any grant; edit with `incentive.update`).

### Project health (`/health`)
One row per project: name, lead, status, completed of allocated hours with a bar (`usedShare`, shown as a percentage, red over 100%), open tasks, this month's hours per TL, this month's incentive. Filter by lead.

### Team (`/team`)
Two tables from the roster: team leads (projects, tasks done this month, average hours over or under estimate) and developers (open tasks, done tasks, points). Filter by lead.

### Points (`/points` and `/points/[userId]`)
Leaderboard of total points, highest first, with a "since" date filter. A person's page lists their entries: date, task, reason (in words: "Task approved", "QA approved", "Approval reversed", "Revert penalty"), and points, with negatives in red.

### Incentives (`/incentives`)
Month picker (default this month). Table: person, completed hours, rate, payout, paid or not. Actions: "Save figures" (`incentive.create`), "Mark paid" per person (`incentive.update`, never for yourself), and a "Settings" tab listing each person's setting with an edit dialog (`incentive.update`, never your own). Amounts in taka, such as `৳12,500`.

## 6. Look and feel

- Use `design.css` **unchanged** as the start of `globals.css`. It turns on Tailwind, defines the colours (light and dark) as theme variables and maps them to Tailwind names (`bg-surface`, `text-ink`, `text-ink-muted`, `border-border`, `bg-accent-soft`, `text-danger` and so on), and holds every component class (`.btn`, `.card`, `.input`, ...) as `@apply` rules.
- Build each screen from those component classes plus Tailwind utilities in `className`: utilities for layout and anything particular to one screen. A module-only style that repeats across screens goes in a "Module additions" section at the end of `globals.css`, written with `@apply`. A class built from data (such as `pill-${tone}`) must exist there too, because Tailwind only generates utilities it can see written out in full.
- Use the theme colour names only: no hex colours, no `dark:` variants (the theme variables already switch for dark mode), no inline styles, no new fonts, no icons.
- Layout: a 216px sidebar and the page beside it (`.shell`, `.sidebar`), collapsing at phone width as `design.css` does.
- Build every screen from these pieces (in `components/ui.tsx`), using the class names from `design.css`:

| Piece | Markup and behaviour |
|---|---|
| `PageHead` | `.page-head`: `h1` title, one-line subtitle `p`, actions on the right in `.page-actions` |
| `Card` | `section.card`, optional `.card-head` with an `h2` title and something on the right |
| `Row` | `.row`: a label and its value, for read-only details |
| `Pill` | `.pill.pill-<tone>`: `accent`, `good`, `warning`, `danger`, `neutral` |
| `Notice` | `p.notice.notice-<good|danger|warning>`, `role="alert"` for danger |
| `Chips` | `.chips` of `button.chip` with `aria-pressed`, for one-of filters |
| `Pagination` | `nav.pagination`: "1 to 25 of 80" and Previous/Next |
| `Loaded` | Shows "Loading…", or the error with "Try again" (not for 403/404), or the content |
| `TextField`, `TextAreaField`, `SelectField` | `.field` with a `label`, an `.input`, and an optional `.hint` |
| `Dialog`, `FormDialog`, `ConfirmDialog` | A modal with a title, content and buttons; Escape and the close button close it; the form's error shows inside it |
| Tables | `.table-box` around a `table` with `th scope="col"`; links in cells use `.link` |
| Empty state | `p.empty`, such as "No tasks match." |
| Buttons | `.btn`, `.btn-primary` for the main action, `.btn-danger` for destructive ones |

- Status colours and labels are in `DATA_MODEL.md` (TaskStatus and ProjectStatus).
- Every list: page size 25, filters in a card above, a card holding the table, an empty state and pagination.
- Every change goes through a dialog; destructive or irreversible ones (cancel, revert, delete, mark paid) ask first with `ConfirmDialog`. While saving, the button is disabled and says what it's doing ("Saving…"). After saving, close the dialog and reload what changed.

## 7. Words

- Plain, short, sentence case ("New task", not "New Task").
- Buttons say what happens: "Approve", "Save changes", "Cancel task". Not "OK" or "Submit".
- Dates: `13 Nov 2026`. Calendar days (due dates, deadlines) are shown in UTC so they never slip a day. Times: `13 Nov, 14:05`. Hours: `6 h`. Points: `1,250`. Money: `৳12,500`. Missing: `·`.
- API keys shown to people go through one function that turns `on_hold` into "On hold".
- Error messages come from the API. Don't write your own for API failures.
- The four gates: loading ("Loading…"), signed out ("Sign in to TwinTrack. Project management uses your TwinTrack sign-in. Sign in there, then open Project management again." with "Go to sign in" to `<MASTER_URL>/sign-in`), no access (section 4), and unavailable ("TwinTrack can't be reached. The API isn't answering. Check that it is running, then reload this page.").
- A screen the person can't open shows "Your access doesn't include this screen."

## 8. Code

- Readable names, small focused components, no `any`. Types come from `schema.json`.
- `useLoad(loader, dependencies)` for reading: keeps earlier data on screen while reloading, ignores late answers, and doesn't offer a retry for 403 or 404.
- `useSubmit()` for writing: busy flag, error message, returns whether it worked.
- Send `version` with every edit that takes it. On `409 version_conflict`, show the message and reload the record.
- Only `http:` and `https:` addresses become links (logins, task descriptions).
- Comments only where the reason isn't obvious.

## 9. Done means

A screen is done when:

1. `npm run typecheck` and `npm run build` pass.
2. You used it in a browser against the API, signed in as the test accounts you were given: one with full access, one with little, and one with none. Each sees only what their access allows, and the buttons match the rules in section 4.
3. Loading, empty, error, no-access and phone-width layouts all look right.
4. Your summary says what you built, what you couldn't check, and anything in the API or these instructions that seemed wrong or missing. Never say something works if you didn't see it work.
