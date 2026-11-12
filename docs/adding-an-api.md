# Adding or changing an API route

This is the checklist for every new, changed or removed route in the Master backend, for any module (Master, HR, Tasks, …). A route is finished only when every place that describes it agrees with the code. Do all of it in the same change.

## Why so many places

The screens never list routes or permissions in frontend code. The **Modules**, **Profiles**, **Permissions**, **My permissions** and **Access** screens all read the module's manifest from the database. So the manifest file, and the copy of it loaded into the database, is what makes a route visible and grantable. Code alone isn't enough: a route the database hasn't loaded grants nothing to anybody, and no screen shows it.

## Rules

1. **The manifest is the contract.** Every built route is in `manifests/<module>.manifest.json`, with the same method, path, `access` and `permission` as its `ApiRoute` declaration. Nothing is listed before it's built.
2. **Access comes from data, never code.** Don't check a profile name, an org role or a module key in a route or service. Declare `access` and `permission` and let `registerRoutes` enforce them.
3. **Org roles never carry permissions.** A new route needs no change to org roles. If it should reach a manager's team, put `scoped: true` on the resource and let `team` scope do it.
4. **Reuse an action before adding one.** A new action (for example `salary.export`) shows up as a new column on the Profiles screen. Add one only when no existing action has the same meaning.
5. **Nothing is granted automatically.** A new resource or action starts out held by nobody except the super admin. Say in the change summary which profiles will need it, and let an admin tick it in the app.
6. **No mounted routers.** Register routes directly through the module's route list (`master.routes.ts`, `hr.routes.ts`, …) so the coverage tests can see them.
7. **Business records use the shared base.** That means `addRecordFields`, writes through `lib/records/recordWrites.ts`, `trackedFields` for history, and `recordFields` for field-level security. Redact responses with `redactRecord` and check writes with `assertMayWriteFields`.

## Checklist

### 1. Code
- [ ] The `ApiRoute` declaration in the feature's `*.routes.ts`, added to the module's route list.
- [ ] Input validation, service and repository code, following the feature folder's existing layout.
- [ ] Tests in `backend/tests/` for success, refusal (401/403) and scope (`own`, `team`, `all`) where it applies.

### 2. Manifest, then reload it
- [ ] Add the route to `manifests/<module>.manifest.json`: `method`, `path` (relative to the module's `baseUrl`), `access`, `permission` or `anyPermission`.
- [ ] Add any new resource or action. Set `scoped`, `sharingModel`, `trackedFields`, `recordFields` and `protectedFields` as the resource needs.
- [ ] Raise the module `version`: minor for new routes or actions, patch for fixes.
- [ ] Run `npm run seed:modules`. This updates the **Modules**, **Profiles**, **Permissions**, **My permissions** and **Access** screens. People, profiles and custom objects stay as they are.

`tests/routes.test.ts` compares Master routes with the Master manifest. It doesn't compare other modules, so check those by hand.

### 3. Postman
- [ ] A request in `postman/` for the route, with path parameters as variables (`{{baseUrl}}/users/{{userId}}`).
- [ ] `npm run test:postman` passes. It needs local MongoDB.

### 4. Test page (`/try`)
- [ ] At least one success and one failure scenario in `backend/test-page/scenarios.json`. `tests/test-page.test.ts` replays them.

### 5. Documentation
- [ ] The module's file in `docs/api/` (`master.md`, `hr.md`, `tasks.md`).
- [ ] `README.md` if setup, sessions or an overview section changes.
- [ ] `backend/.env.example` for any new setting.
- [ ] `seed/` if example data should use the new route or resource.

### 6. Published pages (artifacts)
- [ ] **API scenarios page** (`design/master-api-scenarios.html`):
  1. Record samples by running `API_SAMPLES_FILE=../../design/api-samples.json npx vitest run tests/test-page.test.ts` from `backend/`.
  2. Rebuild the page with `python design/build-api-page.py`. Don't edit the HTML by hand.
  3. Republish it.
- [ ] **Progress page** (`design/master-progress.html`): update its status, add a change log entry and republish it.

### 7. Run the checks
From `twintrack-master/`:

```sh
npm run typecheck
npm run lint
npm test
npm run test:postman
```

### 8. Change summary
- [ ] List every file changed, including `manifests/` and `postman/`. Those two are gitignored, so `git status` doesn't show them.
- [ ] Name any new resource or action and which profiles will need it ticked.
- [ ] Report which checks ran and their results.

## What each check catches

| Missing step | Caught by |
|---|---|
| Master route not in the manifest, or a different `access` | `tests/routes.test.ts` |
| HR, Tasks or other module route not in the manifest | Nothing. Check by hand. |
| Manifest not reloaded into the database | Nothing. The screens don't show the route and nobody can be granted it. |
| No Postman request | `tests/postman-coverage.test.ts` |
| No test-page scenario | `tests/test-page.test.ts` |
| Mounted router | `tests/postman-coverage.test.ts` |
| Docs, artifacts, `.env.example` | Nothing. Use this checklist. |
