# Build the Demo frontend

## 1. What you're building

A small app for the TwinTrack **Demo** module (key `demo`): a list of notes people can write, mark done, edit and delete. It exists for trying how module frontends sign in and follow permissions, so keep it simple.

## 2. Stack and setup

Next.js (App Router) with TypeScript, no UI library. Use `design.css` as the global stylesheet, unchanged. The API address comes from `NEXT_PUBLIC_API_URL`, the portal's from `NEXT_PUBLIC_PORTAL_URL`. Run it on `http://localhost:3000` in development.

## 3. Signing in and the API client

There is no sign-in screen. Follow "Signing in from a module frontend" in `api/README.md`:

- `/auth/callback` reads `?code=`, removes it from the address bar, and exchanges it with `POST /auth/handoff`. Keep the access token in memory only.
- Send it as `Authorization: Bearer …` on every call.
- On any `401`, or with no token, send the browser to `${NEXT_PUBLIC_PORTAL_URL}/open/demo`.

A super admin must first set the app up on the portal's Modules screen, Demo, Sign-in: frontend address `http://localhost:3000`, redirect URL `http://localhost:3000/auth/callback`.

## 4. Access

Read `GET /me/permissions/demo` once after signing in, and show only what the person holds:

| Permission | Shows |
|---|---|
| `note.read` | The notes list and note page |
| `note.create` | "New note" button |
| `note.update` | Edit, and Mark done / Reopen |
| `note.delete` | Delete, after a confirmation |

Without `note.read`, show "You don't have access to notes yet."

## 5. Screens

- **Notes** (`/`): a filters card (All, Open, Done), then a table of title, status pill, written and changed dates, 25 per page with pagination, and an empty state. Select a row to open it.
- **Note** (`/notes/[id]`): title, status, body, dates, and the actions in section 4.
- **New note / Edit note**: a dialog with title (required) and body.

Every route is in `api/demo.md`; the shapes are in `DATA_MODEL.md` and `schema.json`.

## 6. Look and feel

Only the classes in `design.css` (`card`, `btn`, `btn-primary`, `pill`, `table-box`, `field`, `input`, `dialog-actions`). No new colours, fonts or inline styles.

## 7. Words

Sentence case. Buttons are verbs ("Save", "Delete note"). Dates as "17 Nov 2026". Show the API's error `message` as it comes.

## 8. Code

TypeScript strict, one API function per route in `src/lib/api/`, no extra dependencies.

## 9. Done means

Signing in from the portal works, each permission shows and hides its control, a `401` sends the person back through the portal, and `npm run build` passes.
