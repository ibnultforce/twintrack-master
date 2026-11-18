# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`twintrack-master` holds the TwinTrack backend, which serves every module's API, and the Master frontend in `frontend/`. Other folders:

- `manifests/`: one manifest per module, the contract for its routes, resources and permissions.
- `postman/`: the Postman collection and local environment. Committed; it holds only seed test logins.
- `design/`: the progress page (`master-progress.html`), the API scenarios page and its builder, and the UI reference `master-ui.html`.
- `module-packs/<key>/`: each module's frontend handoff pack, made by `npm run export:module-pack -- <key>`.
- `.claude/`: the `twintrack-sync` skill and the hooks that make it run on every backend change.

Module frontends live in their own repos (`twintrack-projects`), and the template they start from is `twintrack-module-starter`, beside this repo in the local workspace. A session that has only this repo (such as Claude Code on the web) can't reach them: see "Working without the workspace" in the skill.

## Commands

Run these from this folder. It needs Node 22+.

```sh
npm run dev            # backend on :4100 and frontend on :3100 (dev:backend / dev:frontend for one)
npm run seed           # loads manifests/ and seed/ into local MongoDB; needs SEED_PASSWORD in backend/.env
npm run seed:modules   # reloads manifests/ only: keeps people, profiles and custom objects created in the app; removes modules whose file is gone
npm run migrate:rename-module -- tasks projects /projects   # once per database: moves a module key everywhere it is stored; then seed:modules. Not from Git Bash, which mangles the /path
npm run typecheck
npm run lint
npm test               # backend only; the frontend has no tests yet
npm run build
npm run test:postman   # runs the Postman collection against its own API copy; needs local MongoDB
```

To run one test, start from `backend/`:

```sh
npx vitest run tests/routes.test.ts
npx vitest run tests/routes.test.ts -t "route table"
```

Use this form for name filters: `npm test -- <file> -t <name>` fails under PowerShell with `Unknown cli flag: --t`.

`npm test` doesn't need a running MongoDB. It starts a throwaway in-memory replica set, and `useTestDatabase()` in `tests/helpers/database.ts` gives each test file its own database. It does need `manifests/`, which is committed. The dev server, the seed and `test:postman` need the local replica set described in the README, because the API uses transactions.

## Architecture

**One backend, many frontends.** Users log in at the Master frontend, and each module has its own frontend on a subdomain. Every module's API, permissions and session handling live in the Master backend, under `backend/src/modules/<module>/`. A new module is a frontend plus routes here, not a new backend. So far only the Master frontend is built: the portal and admin console in `frontend/`.

**How a route goes live.** Each feature exports `ApiRoute` declarations (`*.routes.ts`). Each module has one list (`master.routes.ts`, `hr.routes.ts`). `app.ts` passes each list to `registerRoutes` in `lib/apiRoute.ts` with an access middleware bound to that module's key, which builds each route's access checks from its declaration and decides which module's permissions they read. Routes are registered directly on the app. Don't use mounted routers: the Postman coverage test can't see inside them, and a test fails if one exists. The one exception is the MCP SDK's OAuth protocol handlers, in `modules/master/oauth/oauthProtocol.ts`. The public `/files/parts` and `/files/content` routes (`modules/master/storage/`) serve task files from the local disk in development, checked by signed tokens instead of a session, and answer 404 when files are in R2.

**Master extensions:** other modules give Master `userReferenceChecks` (what still names a person, so they can't be deleted) and `mcpToolProviders` (their MCP tools), passed in `app.ts`. Master never imports a module's data.

**Access checks.** A route declares `access` as one of the following, and `access/access.middleware.ts` enforces it:

| `access` | Checks, in order |
|---|---|
| `public` | None |
| `signed` | Session |
| `private` | Session, then `permission` or `anyPermission` |

Nobody is given a password: new people and resets get a one-time link emailed through Resend (`auth/passwordLinks.service.ts`). Tests pass a recording sender to `createApp` (`tests/helpers/testEmail.ts`).

**Permissions are never in the token.** Access tokens hold identity only. Each call reads the user and module from the database, so a change applies on the next request. `resolveModuleAccess` in `access/permissions.ts` reads the person's one org-wide **profile** (`accessprofiles`, grants keyed by module, `user.profileId`), which is where all of their access comes from. There are no permission sets: they were removed, and manifests or seed files that still list `permissionSets` are refused. The permission's scope (`own` < `team` < `all`) is set as `req.permissionScope`. The session check loads the profile with the user, as `req.caller.profile`.

**Org tree and team reach.** Every person has an `orgRoleId` in a tree of org roles with one root (`/org-roles`). Org roles are job levels; they never pass on permissions. `team` scope, in `access/scope.ts`, follows the reporting tree instead: the person plus everyone who reports to them through `managerId`, at any depth. So two people in the same org role (two project managers) each reach only their own reporting line. Sharing to "a role and everything below it" still uses the org role tree, because it names the roles explicitly.

**Access is decided by data, not code.** Don't check profile names, or a module such as `hr`, in code. **Nothing ships with the product:** there are no profiles, and only a super admin has access until they create some. Tests get profiles and the people holding them from `backend/tests/fixtures/test-access.json`, applied by `tests/helpers/testAccess.ts` and `importSeedManifests()` in `tests/helpers/signedIn.ts`. Building profiles needs `accessProfile.*` in Master, only from permissions the person holds (`beyond_own_access` otherwise), and only a super admin can use `"*"`. `module.update` in Master changes a module's resources, and resource edits set `permissionsEditedAt`. Manifests with the old `roles`, `grantable`, `managesAccessOf` or `permissionSets` fields are refused.

**Giving profiles:** `PUT /users/:id/profile` needs the Master permission `userProfile.update`, which is scoped: its scope decides whose profile someone may change (`team` is everyone in their reporting line). The new profile and the one it replaces must both stay within the giver's own access in every module, checked in `users/userAccess.service.ts`. This is how access is delegated, for example a project manager giving developers profiles. `PATCH /users/:id` doesn't take `profileId`.

**HR routes** are in `backend/src/modules/hr/`. They use the same access checks against the HR manifest, and the scope from the person's profile (`own`, `team`, `all`) decides whose salaries they reach.

**A few safety rules stay in code on purpose:** only a super admin can change a super admin, nobody else can change their own access (profile or org role), and only a super admin can build or give a profile beyond their own access.

**Business records** (salaries) share one base: `addRecordFields` in `backend/src/lib/records/` adds `createdBy`, `updatedBy`, `version` and soft delete (`deletedAt`), and hides deleted records from every query unless `WITH_DELETED` is passed. Changes go through `lib/records/recordWrites.ts`, and `writeRecordHistory` writes field history in the same transaction, for the fields the manifest resource lists in `trackedFields`. A new business record should use all three.

**Sharing** (`modules/master/records/recordAccess.service.ts`, `record_shares`) lets a permission reach one record beyond the scope, for a person, an org role, or a role and everything below it, with `read` or `edit` access. It never adds a permission. `assertCanReachRecord` combines the scope, the resource's `sharingModel` in the manifest and shares. The owner (a salary's employee), anyone above them, or a holder of `<object>.share` may share. Approve, delete and restore stay scope-only.

**Field-level security** (`modules/master/records/fieldSecurity.service.ts`): every field in a resource's `recordFields`, `protectedFields` or custom `fields` has a level: `hidden`, `read`, `create` (set on a new record only) or `edit`. A grant's `fieldAccess` states levels; unnamed fields follow its actions, except protected ones, which stay hidden. A new business record lists its fields in `recordFields`. `req.callerFieldAccess` and `Actor.fieldAccess` carry it. Redact responses and history with `redactRecord` and `redactHistory`, and check writes with `assertMayWriteFields(rules, fields, 'create' | 'update')` after the reach check.

**Custom objects** (`modules/master/customObjects/`): admin-defined objects are module resources with `custom: true` and `fields`. Their records are in `custom_records` under `/records/:module/:object`, which are `signed` routes that check the module permission in the service. Imports keep custom resources.

**Manifests are the contract.** `manifests/<module>.manifest.json` lists a module's resources and routes, and the seed loads it into the database. They list only what's built, so add a route or resource in the same change that builds it. Resources whose permissions services check, such as custom objects, name no route on purpose.

## Changing a route

Imports on the Modules screen change only the manifest and schema. Each one that changes something is listed in `manifests/changes/<key>.md` and under "Changes to build" on the screen, with where the code needs work; build those, then mark the import done there.

The full checklist and rules are in `docs/adding-an-api.md`. Keep these in step in the same change. The tests catch 1, 2 and 4:

1. **Route table and manifest, in both places:** every new or changed API goes into its module's manifest file (`manifests/<module>.manifest.json`): the route, its access rule, any new resource or action, and a raised module version. Then load it into the database with `npm run seed:modules`, which keeps people, profiles and custom objects made in the app, so the running backend's copy matches the file. A file the database hasn't loaded grants nothing, and the Modules and Profiles screens won't show it. `tests/routes.test.ts` fails if built Master routes or their access rules disagree with the Master manifest. `tests/module-routes.test.ts` does the same for every other module. Claude Code sessions run the `twintrack-sync` skill (`.claude/skills/`) for this whole checklist; hooks in `.claude/settings.json` remind it and stop it finishing a backend change that touched nothing describing it.
2. **Postman collection:** `tests/postman-coverage.test.ts` fails if a route has no request. Write path parameters as variables (`{{baseUrl}}/users/{{userId}}`).
3. **Everything else that describes it:** README, the module's file in `docs/api/`, `.env.example`, `seed/`, and `design/master-progress.html` (published as the progress page), which also needs a change log entry and a republish.

4. **Test page:** `backend/test-page/scenarios.json` needs at least one scenario for the route. `tests/test-page.test.ts` fails if it has none, and replays every scenario against the API. The page is served at `/try` when `TEST_PAGE_ENABLED=true`, which production refuses.

`postman/` and `manifests/` are committed. Every push to `main` deploys to demo.twintrack.work and reloads them (see the README's Deploying section).

## Committing and pushing

In Claude Code on the web (or any cloud session), when the work is finished, run the checks yourself and then commit and push straight to `main`, without asking first and without a side branch or pull request. The owner has asked for this standing rule.

1. Run `npm run typecheck`, `npm run lint` and `npm test`.
2. If `npm test` can't start only because the MongoDB binary download is blocked (the cloud network often blocks it), run every test file that doesn't need a database instead: at least `tests/routes.test.ts`, `tests/module-routes.test.ts`, `tests/postman-coverage.test.ts` and the manifest validation tests. If those, typecheck and lint pass, push to `main`, and list the database tests that didn't run in the commit body and the final summary.
3. If any check that did run fails, fix it. Don't push failing code: report what failed.
4. After pushing, wait for the "Deploy demo" GitHub Actions run of your commit (`.github/workflows/deploy.yml`), which runs the full `npm test` with MongoDB before deploying. Use `gh run watch` (find the run with `gh run list --branch main --limit 1`), or the GitHub API if `gh` isn't there. If its `check` job fails, read the log (`gh run view --log-failed`), fix the cause, run the checks again and push the fix. Repeat until the run is green, then finish. Tests that the new code broke count as yours to fix, for example a test that counts the seeded modules.

Tests shouldn't hard-code how many modules, routes or manifests exist: work the number out from the manifests or the seed result, so a new module doesn't break them. Put the twintrack-sync skill's "Still to do" list in the commit message body, and in the final summary say that the push deploys to demo.twintrack.work.

# TwinTrack development guidelines

These apply to all work in this workspace, in every module repo.

Act as a Senior Software Architect and Senior Software Engineer. The job is not just to make features work, but to keep the codebase clean, readable, maintainable, secure, and scalable for future developers.

**Most important principle:** write code as if another developer, who has never met you and has no knowledge of your implementation decisions, will need to maintain and extend it several years from now. Prioritize long-term maintainability, readability, consistency, and architectural integrity over short-term convenience.

## Code standards

### 1. Code readability and simplicity
- Write clean, readable, and self-explanatory code.
- Prioritize readability over writing fewer lines of code.
- Use meaningful variable, function, class, and file names.
- Avoid unnecessarily complex logic and deeply nested conditions.
- Keep functions focused on a single responsibility.
- Avoid abbreviations unless they are widely recognized.
- Write code that another developer can understand without needing to ask the original author.
- Avoid clever or overly abstract implementations.

### 2. Architecture and project structure
- Follow a consistent and well-defined project architecture.
- Organize files by feature or business domain where appropriate.
- Separate business logic, data access, presentation, and configuration.
- Avoid placing everything inside a single file or component.
- Keep reusable components and utilities in shared locations.
- Avoid unnecessary abstraction and premature optimization.
- Make sure new code follows the existing project architecture.
- Do not introduce a new architectural pattern without a clear reason.

### 3. Separation of concerns
Each layer should have a clearly defined responsibility.

| Layer | Responsibility |
|---|---|
| UI / Presentation | Display data and handle user interactions |
| Business Logic | Handle application rules and workflows |
| Services | Handle external integrations and operations |
| Repository / Data Access | Handle database and API communication |
| Models | Define data structures and transformations |
| Configuration | Manage environment-specific settings |
| Utilities | Provide reusable, generic functionality |

Avoid mixing database queries, business logic, and UI rendering in the same component or function.

### 4. Naming conventions
Maintain consistent naming throughout the project.
- Variables: descriptive camelCase.
- Functions: action-oriented camelCase.
- Classes: PascalCase.
- Constants: UPPER_SNAKE_CASE where appropriate.
- Files: follow the conventions of the existing framework.
- Boolean variables should clearly indicate true/false states.

```ts
const isUserAuthenticated = true;

function calculateOrderTotal() {}

class PaymentService {}

const MAX_LOGIN_ATTEMPTS = 5;
```

### 5. Reusability and DRY principles
- Follow the DRY (Don't Repeat Yourself) principle.
- Avoid duplicating business logic.
- Extract reusable functionality when it provides genuine value.
- Create shared components for repeated UI patterns.
- Centralize common validation, formatting, and configuration.
- Avoid creating abstractions for code that is unlikely to be reused.
- Maintain a single source of truth for shared application data.

### 6. Scalability and future maintenance
Write code considering that the application may grow significantly.
- Design modules so they can evolve independently.
- Avoid tightly coupled components and services.
- Use dependency injection where appropriate.
- Keep external integrations isolated.
- Avoid hardcoded URLs, credentials, business rules, and configuration values.
- Support adding new features without rewriting existing modules.
- Use interfaces, contracts, or well-defined types where appropriate.
- Consider backward compatibility when modifying existing functionality.

### 7. Error handling and logging
- Handle errors explicitly.
- Never silently ignore exceptions.
- Provide meaningful error messages.
- Avoid exposing sensitive technical information to end users.
- Use centralized error-handling mechanisms where appropriate.
- Maintain consistent logging levels.
- Never log passwords, access tokens, API keys, or sensitive personal information.
- Make errors traceable enough for developers to troubleshoot.

### 8. Comments and documentation
- Write comments only when they add meaningful context.
- Prefer self-explanatory code over excessive comments.
- Explain complex business logic and non-obvious decisions.
- Document public methods, APIs, and important interfaces.
- Maintain README documentation when project setup or architecture changes.
- Document environment variables and configuration requirements.

### 9. Security standards
- Never hardcode secrets or credentials.
- Validate and sanitize user input.
- Follow authentication and authorization best practices.
- Apply proper access control.
- Protect against SQL injection, XSS, CSRF, and other relevant vulnerabilities.
- Never expose internal errors or sensitive information through API responses.
- Follow the principle of least privilege.

### 10. Performance considerations
- Avoid unnecessary database queries.
- Prevent N+1 query problems.
- Use pagination for large datasets.
- Optimize expensive operations when necessary.
- Avoid unnecessary component re-rendering.
- Use caching where it provides measurable benefits.
- Avoid premature optimization; prioritize correctness and maintainability.

## Development rules
- Always inspect the existing project structure and understand the current architecture before writing or modifying code.
- Follow existing coding conventions and architectural patterns consistently.
- Never introduce unnecessary complexity, abstractions, dependencies, or architectural changes.
- Write self-documenting code using meaningful names for variables, functions, classes, and files.
- Follow SOLID, DRY, KISS, and separation-of-concerns principles where appropriate.
- Keep functions, classes, and components focused on a single responsibility.
- Separate presentation, business logic, data access, API integrations, and configuration.
- Centralize reusable constants, configuration, validation, and shared business logic.
- Avoid hardcoded values, duplicated logic, tightly coupled modules, and unnecessary dependencies.
- Implement proper error handling, logging, input validation, and security practices.
- Use appropriate types, interfaces, and contracts to make code predictable and easier to maintain.
- Write reusable code only when it improves maintainability. Avoid premature abstraction.
- Consider future developers who may need to understand, extend, debug, or replace individual modules.
- Do not make unrelated changes when implementing a requested feature.
- Preserve existing functionality unless the requested requirement explicitly requires changing it.

### Before writing code
- Inspect relevant files and understand how existing functionality works.
- Identify dependencies and potential side effects.
- Check whether reusable services, components, utilities, or existing methods already exist.
- Plan the implementation before making significant changes.
- Identify potential security, performance, and compatibility concerns.

### While writing code
- Follow the established architecture.
- Keep implementation straightforward and readable.
- Use consistent naming and formatting.
- Avoid oversized files and methods.
- Avoid unnecessary comments. Add short comments only when the reasoning behind the code is not obvious.
- Never duplicate existing functionality unnecessarily.
- Do not use deprecated APIs or outdated implementation patterns when supported alternatives exist.
- Do not silently swallow errors or use unsafe shortcuts.

### After writing code
- Review all modified files.
- Check for duplicated logic, unnecessary complexity, and architectural inconsistencies.
- Verify imports, types, dependencies, and error handling.
- Run relevant tests, linting, and formatting commands when available.
- Check for unintended changes to existing functionality.
- Update documentation when necessary.

## Communication rules
When implementing a feature or fixing a bug:
1. Briefly explain the proposed implementation.
2. Explain which files need to be created or modified.
3. Implement the solution following the project's standards.
4. Summarize the changes after implementation.
5. Mention any assumptions, limitations, or potential risks.
6. Clearly report tests that were executed and their results. Never claim tests passed if they were not executed.
