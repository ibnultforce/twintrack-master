# Test frontend: instructions

These are the instructions for building the **Test** frontend of TwinTrack. Put this whole folder in the new project as `docs/` and point Claude Code at this file first. Other people are building other TwinTrack modules from instructions just like these, so **follow them exactly, and when they don't cover something, choose the simplest option that matches what's already here.**

## Files in this pack

| File | What it is |
|---|---|
| `INSTRUCTIONS.md` | This file: what to build and how |
| `DATA_MODEL.md` | Every record, field, allowed value and rule, explained |
| `schema.json` | The same data model as JSON Schema. Generate the TypeScript types from it |
| `design.css` | The shared TwinTrack stylesheet. Use it unchanged |
| `api/test.md` | Every route: what it takes, what it returns, and its errors |
| `api/README.md` | Signing in, tokens, the error format and errors any route returns |
| `api/manifest.json` | Routes, permissions and field rules, as the backend loads them |
| `api/postman_collection.json` | Working requests for every route |

When these disagree, `api/test.md` wins, then `DATA_MODEL.md`. Never invent a route, field, permission or value that isn't in them; if something you need is missing, stop and say so.

## 1. What you're building

A small web app for checking that a TwinTrack module works end to end: signing in through Master, reading the person's access, and calling permission-checked routes. The API has two routes, both needing `test.read`: **`GET /test`**, which answers with the module key and the server time, and **`GET /test/users`**, which lists active colleagues. Build only what those routes allow.

It has **no backend of its own**. Everything comes from the TwinTrack API (the Master backend), which also decides who may see and do what. People sign in at the Master frontend; this app reuses that session.

## 2. Stack and project setup

- **Next.js (App Router), React and TypeScript** with `strict: true` and `noUncheckedIndexedAccess: true`. Node 22 or later.
- **No other dependencies.** No UI kits, CSS frameworks, icon packs, state, form, date, data-fetching or upload libraries. Write small pieces by hand.
- Scripts: `dev` (port 3500), `build`, `typecheck`.
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

- **Start-up:** call `POST /auth/refresh` with `credentials: 'include'`. A `200` gives an `accessToken`; anything else means signed out. Then load `GET /auth/me` and `GET /me/permissions/test`.
- Keep the access token **in memory only**, never in storage. Send it as `Authorization: Bearer <token>` on every call, always with `credentials: 'include'`.
- On `401` with code `no_token`, `invalid_token` or `token_expired`, refresh **once** (one refresh shared by every call waiting on it) and retry. If the refresh fails, the session has ended: show the signed-out gate.
- A `5xx` or `429` from refresh is an outage, not a sign-out: show "TwinTrack can't be reached".
- **Sign out:** `POST /auth/logout`, then clear the token and show the signed-out gate.
- A `204` has no body.
- Errors arrive as `{ error: { code, message, fields } }` (`ApiError` in the schema). Show `message`, plus each field problem. A failed `fetch` (no answer at all) shows "The API can't be reached. Check that it is running, then try again."

The session exposes `status` (`loading`, `signed-out`, `no-access`, `signed-in`, `unavailable`), `profile`, `profileName`, `can(permission)` and `mayWriteField(field, 'create' | 'update')`.

## 4. Access: the API decides, the screen follows

From `GET /me/permissions/test` (`ModuleAccess` in the schema):

- `hasAccess: false`, or a `403`/`404` from that call, shows the **no-access gate**: "No access to Test. Your profile doesn't include Test. Ask whoever gives profiles in your organisation." with a "Back to TwinTrack" link to `<MASTER_URL>/modules`.
- `can('<resource>.<action>')` is true when `permissions['<resource>.<action>']` exists. Show a screen, button or menu item **only** when the person holds its permission.
- Never check profile names, titles or departments in code.

Permissions in this module:

| Permission | Resource | Scope |
|---|---|---|
| `test.read` | Test | yes or no |

## 5. Screens

Sidebar, in this order, under the heading "Test". Each entry shows only with its permission. The sidebar ends with a "TwinTrack" group holding "All modules" (link to `<MASTER_URL>/modules`), and a footer with the profile name (or "Super admin"), the person's name and "Sign out".

| Path | Sidebar label | Needs |
|---|---|---|
| `/test` | Test | `test.read` |
| `/people` | People | `test.read` |

### Test (`/test`)
- Head: "Test", subtitle "Check that this module answers you." Action "Run test" with `test.read`.
- **Result card:** calls `GET /test` on load and on "Run test", and shows status as a pill (`ok` "OK", `good` tone), the module key, and the server time formatted with `format.ts`. While it loads, the card shows "Loading…"; a refusal shows the API's error message.

### People (`/people`)
- Head: "People", subtitle "Colleagues this module can read from TwinTrack." No actions.
- Filters: search by name, email or title (`search`). Changing it goes back to page 1.
- Table: name, email, title, department, team. When a person has `online`, show a pill after the name ("Online", `good` tone; nothing when false). 25 per page with `pageSize=25`, using `total` for pagination.
- Empty state: "Nobody matches."

`/` sends people to `/test` when they hold `test.read`, or says "Your Test profile doesn't include any screens yet."

Routes this module can call:

| Route | Needs |
|---|---|
| `GET /test` | `test.read` |
| `GET /test/users` | `test.read` |

## 6. Look and feel

- Use `design.css` **unchanged** as the start of `globals.css`. It holds the colours (light and dark), fonts, spacing and every component class. Add module-only styles in a "Module additions" section at the end, using its colour variables (`var(--accent)` and so on). No inline styles, no new colours, no new fonts, no icons.
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
| Empty state | `p.empty`, such as "Nothing matches." |
| Buttons | `.btn`, `.btn-primary` for the main action, `.btn-danger` for destructive ones |

- Status colours and labels are in `DATA_MODEL.md`.
- Every list: page size 25, filters in a card above, a card holding the table, an empty state and pagination.
- Every change goes through a dialog; destructive or irreversible ones ask first with `ConfirmDialog`. While saving, the button is disabled and says what it's doing ("Saving…"). After saving, close the dialog and reload what changed.

## 7. Words

- Plain, short, sentence case ("New record", not "New Record").
- Buttons say what happens: "Approve", "Save changes", "Delete". Not "OK" or "Submit".
- Dates: `13 Nov 2026`. Calendar days are shown in UTC so they never slip a day. Times: `13 Nov, 14:05`. Hours: `6 h`. Numbers: `1,250`. Money: `৳12,500`. Missing: `·`.
- API keys shown to people go through one function that turns `on_hold` into "On hold".
- Error messages come from the API. Don't write your own for API failures.
- The four gates: loading ("Loading…"), signed out ("Sign in to TwinTrack. Test uses your TwinTrack sign-in. Sign in there, then open Test again." with "Go to sign in" to `<MASTER_URL>/sign-in`), no access (section 4), and unavailable ("TwinTrack can't be reached. The API isn't answering. Check that it is running, then reload this page.").
- A screen the person can't open shows "Your access doesn't include this screen."

## 8. Code

- Readable names, small focused components, no `any`. Types come from `schema.json`.
- `useLoad(loader, dependencies)` for reading: keeps earlier data on screen while reloading, ignores late answers, and doesn't offer a retry for 403 or 404.
- `useSubmit()` for writing: busy flag, error message, returns whether it worked.
- Send `version` with every edit that takes it. On `409 version_conflict`, show the message and reload the record.
- Only `http:` and `https:` addresses become links.
- Comments only where the reason isn't obvious.

## 9. Done means

A screen is done when:

1. `npm run typecheck` and `npm run build` pass.
2. You used it in a browser against the API, signed in as the test accounts you were given: one with full access, one with little, and one with none. Each sees only what their access allows, and the buttons match the rules in section 4.
3. Loading, empty, error, no-access and phone-width layouts all look right.
4. Your summary says what you built, what you couldn't check, and anything in the API or these instructions that seemed wrong or missing. Never say something works if you didn't see it work.
