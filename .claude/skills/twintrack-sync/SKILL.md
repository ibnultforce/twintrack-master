---
name: twintrack-sync
description: "Keeps everything that describes the TwinTrack Master backend in step with the code. Use it on every change to twintrack-master/backend (a new module, a new route, a changed or removed route, a new or changed resource, action, field or model, or a renamed module). It updates the manifest and reloads it so the change shows on the Modules and Profiles (permissions) screens, plus Postman, the /try scenarios, docs/api, the published pages and the module's frontend handoff pack. Use it even for a small backend edit, and before you say backend work is finished."
---

# TwinTrack sync

A backend change is finished only when every place that describes it agrees with the code, in the same change. The detailed rules are in `docs/adding-an-api.md`; read it first. This skill says which parts apply and in what order. Paths are relative to `twintrack-master/` unless they start with `../`, which is the local workspace around it.

## 1. Classify the change

Read the diff (`git diff` and `git status` in `twintrack-master/`, plus the files changed this session). Pick every row that applies:

| Change | Do |
|---|---|
| New module | [references/new-module.md](references/new-module.md), then "New route" for each of its routes |
| New route | Steps 2 to 8 |
| Changed route (path, method, access, permission, body, response, errors) | Steps 2 to 8. Change the existing docs, Postman and scenario entries; don't add duplicates |
| Removed module | Delete its code, its registration in `app.ts`, its manifest file, its entry in `seedFiles.ts`, its Postman folder, scenarios, `docs/api/<key>.md` and `module-packs/<key>/`. Then `npm run seed:modules`, which removes the module from the database because its file is gone; on the demo the deploy runs it. Say which profiles held its permissions |
| Removed route | Steps 2 to 8, removing it everywhere. Remove an action or resource only when no other route or service uses it, and say which profiles held it |
| New or changed resource, action, field, `recordFields`, `protectedFields`, `trackedFields`, `sharingModel` | Steps 2, 5, 6, 7, 8 |
| Model or response shape change, no route change | Steps 5 (data model and `schema.json`), 6, 7, 8 |
| Internal only (refactor, a fix that changes no contract) | Step 8 only, saying why nothing else changed |

Don't skip a step because it looks small. If one can't run here (no local MongoDB, no Artifact connection), do the rest and name the skipped step in the summary.

## 2. Manifest, then reload it into the database

- `manifests/<module>.manifest.json`: each route's `method`, `path` (relative to the module's `baseUrl`), `access`, `permission` or `anyPermission`; any new resource or action with `scoped`, `sharingModel`, `trackedFields`, `recordFields`, `protectedFields` as needed.
- Raise `module.version`: major when a route or action is removed or renamed, minor for new routes or actions, patch for fixes.
- Reuse an action before adding one. Nothing is granted automatically: a new action is held only by the super admin until someone ticks it on the Profiles screen.
- Run `npm run seed:modules`. This is what puts the change on the Modules, Profiles, Permissions, My permissions and Access screens. Without it the route grants nothing. It also removes modules whose manifest file was deleted, so a removed module leaves the Modules, Profiles and Your modules screens.

## 3. Postman (for the super admin and testers)

`postman/twintrack-master.postman_collection.json`, in the module's folder. Path parameters are variables (`{{baseUrl}}/hr/salaries/{{salaryId}}`). Give writes a realistic body.

## 4. Test page `/try`

`backend/test-page/scenarios.json`: at least one success and one refusal (401, 403 or 400) per new or changed route. Removed routes lose their scenarios.

## 5. Documentation

- `docs/api/<module>.md`: purpose, permission and scope, body, response and errors, in the style of the entries around it.
- `README.md` when setup or an overview changes; `backend/.env.example` for a new setting; `seed/` when example data should use it.
- The frontend handoff pack: [references/frontend-pack.md](references/frontend-pack.md).

## 6. Published pages

- API scenarios page: from `backend/`, record samples with `API_SAMPLES_FILE=../design/api-samples.json npx vitest run tests/test-page.test.ts` (in PowerShell set `$env:API_SAMPLES_FILE` first), run `python design/build-api-page.py`, then republish `design/master-api-scenarios.html`.
- Progress page `design/master-progress.html`: update the status, add a dated change log entry, republish.

## 7. Run the checks

From `twintrack-master/`: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:postman` when local MongoDB is running. `tests/routes.test.ts` (Master) and `tests/module-routes.test.ts` (every other module) fail when a route list and its manifest disagree.

## 8. Summary

End with:

- Every file changed, grouped as code, manifest, Postman, scenarios, docs, frontend pack, pages.
- New or removed resources and actions, and which profiles will need them ticked or unticked.
- Whether `seed:modules` ran.
- Each check that ran and its result, and each step skipped and why. Never say a check passed if it didn't run.

## Working without the workspace

A session with only this repo (Claude Code on the web, a fresh clone) has no `../twintrack-module-starter/`, no module frontends, no local MongoDB and maybe no Artifact connection. Check what's there, do every step you can, and never skip one silently:

| Step | Without the workspace |
|---|---|
| `npm run seed:modules` | Can't run without MongoDB. Merging to `main` reloads the manifests on demo.twintrack.work; locally, run it after pulling. |
| `npm run test:postman` | Can't run without MongoDB. Still add and edit requests in `postman/`. |
| `npm test` | Runs: it starts its own in-memory MongoDB, which needs internet access to download once. |
| `export:module-pack` | Fails without the starter's template and stylesheet. Edit `module-packs/<key>/` by hand instead: `api/<key>.md` and `api/manifest.json` as copies of `docs/api/<key>.md` and the manifest, plus `INSTRUCTIONS.md`, `DATA_MODEL.md` and `schema.json`. |
| Module frontends | Not reachable. Name the screens and API calls that need changing. |
| Published pages | Edit `design/master-progress.html` and rebuild the API scenarios page as usual. Republish only if the Artifact tool is available. |

Put each step that didn't run under **Still to do** in your summary and in the pull request description, with the command to run, so whoever pulls the branch can finish it.
