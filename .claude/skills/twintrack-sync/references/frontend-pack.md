# The frontend handoff pack

Each module frontend is built by someone who never sees this backend. They get `module-packs/<key>/` and nothing else, so the pack must always match the backend, and every pack must look the same so each app looks and behaves like Master.

`module-packs/projects/` is the model. Every pack has these files, with the same section order:

| File | Contents |
|---|---|
| `INSTRUCTIONS.md` | Sections 1 to 9 as in the projects pack: what you're building, stack and setup, signing in and the API client, access, screens, look and feel, words, code, done means. Only sections 1, 4 and 5 and module-specific examples differ between modules |
| `DATA_MODEL.md` | Every record as the API returns it: fields, types, "always", field access (`controlled`, `protected`), allowed values with label and pill tone, and how records relate |
| `schema.json` | The same model as JSON Schema; `x-fieldAccess` marks controlled and protected fields |
| `design.css` | A copy of `../twintrack-module-starter/src/app/globals.css`, unchanged |
| `api/` | Written by `npm run export:module-pack -- <key>`: `<key>.md`, `README.md`, `manifest.json`, `postman_collection.json` |

## On every backend change

1. `npm run export:module-pack -- <key>` rewrites `api/` and `design.css`. For a new module it also starts `INSTRUCTIONS.md` (from `../twintrack-module-starter/docs/INSTRUCTIONS.template.md`), `DATA_MODEL.md` and `schema.json`; write every `FILL IN` part, copying the shared definitions (`Id`, `DateTime`, `ModuleAccess`, `ApiError` and so on) from the projects pack's `schema.json`. It never overwrites those three files.
2. Update `DATA_MODEL.md` and `schema.json` for any field, value or record change.
3. Update `INSTRUCTIONS.md` section 4 (which permission shows which button) and section 5 (screens) for every route added, changed or removed. A route a person can use usually means a button, column or screen: say where, using only the pieces in section 6.
4. Copy `design.css` again if the starter's `globals.css` changed.
5. If the module's frontend exists (its folder in `../twintrack.modules.json`), update its API types and every screen that calls a changed or removed route, following that frontend's `CLAUDE.md`, then run its `npm run typecheck` and `npm run build`.

A pack is ready only when `grep FILL\ IN` finds nothing in it. A change to the parts every module shares (sections 2, 3, 6 to 9) goes into the starter's template first, then into every pack's `INSTRUCTIONS.md`.

## Keeping the design the same as Master

- No new colours, fonts, icons, UI libraries or inline styles. Module-only styles go at the end of `globals.css` under "Module additions", using the existing variables.
- Screens use only the pieces in section 6 of `INSTRUCTIONS.md` (`PageHead`, `Card`, `Pill`, `Loaded`, dialogs, tables and so on) and the same list layout: 25 per page, a filters card, a table card, an empty state, pagination.
- Wording rules (sentence case, verb buttons, date and money formats, the four gates) are copied unchanged from the projects pack.
- A design change for every app goes into `../twintrack-module-starter/` first, then each pack's `design.css` and each built frontend.
