# Adding a module

A module is routes in this backend plus its own frontend, never a new backend. Copy the closest of `hr`, `projects` and `demo`. The key is short and lowercase (`inventory`); the name is plain words ("Inventory").

## Backend

1. `backend/src/modules/<key>/`: `<key>Module.ts` exporting `<KEY>_MODULE_KEY`, and `<key>.routes.ts` exporting the route list. Each feature in its own folder (`<feature>.routes.ts`, service, repository, validation); models in `models/`.
2. Register the list in `backend/src/app.ts` with `registerRoutes(app, <list>, createAccessMiddleware(config.auth, <KEY>_MODULE_KEY))`. No mounted routers.
3. If its records name people, give Master a `userReferenceChecks` entry (see `hr/hrUserReferences.ts`). MCP tools go in `mcpToolProviders`. Master never imports the module's data.
4. Business records use `addRecordFields`, `lib/records/recordWrites.ts`, `trackedFields` and `recordFields`.
5. Tests in `backend/tests/`, and add the route list to `moduleRouteLists` in `tests/module-routes.test.ts`.

## Manifest and permissions

6. `manifests/<key>.manifest.json`: `module` (`key`, `name`, `description`, `version` `1.0.0`, `baseUrl` `/<key>`), `resources` with their actions, and `routes`. Copy the shape of an existing manifest; `moduleRegistry/manifest.ts` validates it.
7. `npm run seed:modules`. The module now shows on the Modules screen and its permissions on the Profiles screen, held by nobody but the super admin.

## Testing for the super admin

8. A Postman folder named exactly like `module.name`, with a request for every route.
9. `/try` scenarios for every route.
10. `docs/api/<key>.md` written like the others, and the module added wherever `docs/api/README.md` lists modules.

## Frontend

11. Add the app to `../twintrack.modules.json`: `name` = key, `folder` = `twintrack-<key>`, the next free port (taken: Master 3100, HR 3200, Project management 3300; check `backend/.env.example`), `url` = `http://<key>.twintrack.localhost:<port>`. Add the address to `ALLOWED_ORIGINS` and `MODULE_FRONTEND_URLS` in `backend/.env.example` (and your `backend/.env`), or the API refuses the frontend.
12. Build the handoff pack in `module-packs/<key>/`: [frontend-pack.md](frontend-pack.md).
13. Only when asked to build the frontend too: copy `../twintrack-module-starter/` to `../twintrack-<key>/`, set `src/module.config.ts`, and follow its `CLAUDE.md` and the pack's `INSTRUCTIONS.md`.

## Elsewhere

14. The workspace `../CLAUDE.md` (layout list and what's built), `README.md`, and the progress page.
