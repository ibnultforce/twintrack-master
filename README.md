# twintrack-master

The TwinTrack Master module: login, users and permissions, and the API behind every module.

| App | Folder | Local address |
|---|---|---|
| Backend API (Express, Mongoose) | `backend` | http://api.twintrack.localhost:4100 |
| Frontend (Next.js) | `frontend` | http://twintrack.localhost:3100 |

The API reference for each module is in [docs/api/](docs/api/README.md).

## Requirements

- Node.js 22 or newer
- MongoDB running locally as a replica set, because the API uses transactions:
  - Add `replication: { replSetName: rs0 }` to `mongod.cfg` and restart the service.
  - Run `rs.initiate({_id: 'rs0', members: [{_id: 0, host: '127.0.0.1:27017'}]})` once in `mongosh`.

## Run it

```sh
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
npm run seed
npm run dev
```

Open http://twintrack.localhost:3100 and sign in with a sample account from `seed/users.json`. `localhost:3100` and `127.0.0.1:3100` redirect there, because the API only accepts origins in `ALLOWED_ORIGINS` and the session cookie needs that address. `NEXT_PUBLIC_APP_URL` in `frontend/.env.local` sets where they go.

## Frontend

The Next.js app in `frontend/` is the portal and admin console. It runs entirely in the browser against the API.

| Screens | Who sees them |
|---|---|
| Sign in, set password from an emailed link, Your modules, Directory, Your permissions, Your profile, Apps and API tokens | Anyone signed in |
| Making an API token or connecting an app, on Apps and API tokens | `apiToken.create` |
| API tokens (everyone's tokens and connected apps) | `apiToken.read`, and `apiToken.delete` to revoke |
| Overview, People | `user.read` |
| Access | `user.read` to see who has access to each module, and `userProfile.update` to give profiles |
| Records | Anyone signed in. It lists the custom objects they can read. |
| Org roles | `orgRole.read`, plus `orgRole.create`, `.update` and `.delete` to change the tree |
| Profiles | `accessProfile.read` |
| Permissions | `module.read` |
| Modules | `module.read` |
| Activity log | `audit.read` |

- **Access is still enforced by the API.** The menu and buttons only hide what wouldn't work.
- **Tokens:** the access token stays in memory, so a reload gets a new one through the refresh cookie.
- **Layout:** `src/app` holds the screens, `src/lib/api` the API calls, `src/session` who is signed in, and `src/components` shared parts. Styles follow `design/master-ui.html`.

## Example data

`npm run seed` loads the Master, HR and Tasks modules and the 12-person example team. from `seed/`, with a sample org tree. **No profile comes ready-made:** only the super admin has access until they create profiles and give them to people. Everyone's password is `SEED_PASSWORD` from `backend/.env`, and the seed stops if that isn't set.

- **Safe to re-run:** it updates records by id and creates no duplicates. It resets each person's profile to what the files say, and keeps passwords already set.
- **All or nothing:** every file is checked first and all problems are listed together. If anything fails, nothing is saved.
- **Development only:** it refuses to run when `NODE_ENV` is `production`.

## Backend layout

All module backends live in this repo, each in its own folder under `backend/src/modules/`. Inside a module, each feature has its own folder, split by job:

| File | Job |
|---|---|
| `*.routes.ts` | HTTP only: reads the request and sends the response |
| `*.service.ts` | Rules and workflows |
| `*.repository.ts` | Database queries |

Mongoose schemas are in the module's `models/` folder. Code shared between modules is in `backend/src/lib/`.

**Business records** such as salaries call `addRecordFields` from `lib/records/recordFields.ts` on their schema. That adds `createdBy`, `updatedBy`, `version`, `deletedAt` and `deletedBy`, and keeps deleted records out of every query unless it passes `WITH_DELETED`. Write changes with the helpers in `lib/records/recordWrites.ts`, which stamp who made them, move the version on and refuse a stale edit. Call `writeRecordHistory` from `modules/master/records/` in the same transaction, and list the fields to track as `trackedFields` on the resource in the manifest. History is in the `record_history` collection.

**Field-level security** is in `modules/master/records/fieldSecurity.service.ts`. Every field a resource lists in `recordFields` (plus its `protectedFields` and a custom object's fields) has a level: `hidden`, `read`, `create` or `edit`, from narrowest to widest. A grant's `fieldAccess` can name any of them. A field it doesn't name follows the grant's actions (`update` gives edit, `create` gives create, `read` gives read), except a protected field such as salary `amount`, which stays hidden. `create` lets someone set the field on a new record but not change it afterwards. Hidden fields are left out of responses and history, and a write the level doesn't allow returns `403 field_not_editable`. Fields the workflow sets itself, such as a task's status, aren't checked as writes.

**Custom objects** are in `modules/master/customObjects/`. An admin defines one on a module with `POST /modules/:key/objects`, and it becomes a resource with fields, so profiles, scope, sharing, history and field security all apply. Records live in `custom_records` and are reached under `/records/:module/:object`. The console has a Records screen for them, and the Modules screen defines them.

**Sharing** is in `modules/master/records/recordAccess.service.ts` and the `record_shares` collection. A share lets someone's permission reach one record beyond their scope, as one person, one org role, or an org role and everything below it, with `read` or `edit` access and an optional expiry. It never adds a permission. Check reach with `assertCanReachRecord`, which combines the scope, the resource's `sharingModel` from the manifest, and shares. Approving, deleting and restoring stay scope-only. `backend/src/seed/` loads example data across modules.

## Manifests

`manifests/` has one file per module: `master`, `hr` and `tasks`. Each lists only that module's built routes and the resources they use. Access comes from profiles, which are built in the app. Like `postman/`, this folder is ignored by git, so it has to be added by hand on a new machine, and `npm run seed` and `npm test` need it. The seed loads them, and a test checks that every file in the folder is valid.

To load changed manifests without touching people or profiles, run `npm run seed:modules`. It takes resources and routes from the files, and keeps custom objects created in the app.

Before adding or changing a route, follow [docs/adding-an-api.md](docs/adding-an-api.md). It lists every place that has to change with it.

Update a module's manifest in the same change as any of its routes, and add a route or resource only when it's built. A module can't be named `constructor`, a permission belongs only on a `private` route, and a `team` or `own` scope belongs only on a resource marked `scoped`. Validation refuses anything else.

Each feature exports its routes, and `backend/src/modules/master/master.routes.ts` combines them. A test fails if that list and the Master manifest disagree about which routes are built or who can use them.

A module's `baseUrl` is the path prefix of its routes on this API, such as `/hr`. Its frontend's address comes from `MODULE_FRONTEND_URLS` in `backend/.env`, and that address must also be in `ALLOWED_ORIGINS`.

## Login and sessions

- **Access token:** a 15-minute HS256 token holding identity only. It's sent as `Authorization: Bearer` and kept in the frontend's memory.
- **Refresh token:** kept in an `HttpOnly`, `SameSite=Strict` cookie that only `/auth` routes on the API receive. Only its hash is stored. It's replaced on every refresh.
- **Session limits:** a session ends after 7 days without use, and after 30 days regardless. `backend/.env` sets these.
- **Two open tabs:** a just-replaced token keeps working for 10 seconds, so tabs refreshing together don't end the session.
- **Stolen tokens:** an older token used after that ends the whole session and writes `auth.session_token_reused` to the activity log.
- **Origin check:** login, refresh and logout refuse any origin not in `ALLOWED_ORIGINS`, and any request with no `Origin` header. Postman requests set the header themselves.
- **Logout:** `/auth/logout` is `public` because it works from the refresh cookie alone, so someone with an expired access token can still sign out.
- **Rate limit:** failed logins and failed password changes are limited per address. Counts are kept in MongoDB, so every API instance shares them and a restart doesn't clear them. While testing by hand, deleting the `ratelimitcounters` documents lifts a block straight away.
- **Passwords:** a new password needs at least 8 characters. Changing it ends the person's other sessions.

## Access checks

Each route declares its `access` in its feature's route file, and `registerRoutes` attaches the matching middleware, so a protected route can't go live without its checks:

| `access` | Checks on every call |
|---|---|
| `public` | None. Login, refresh and logout add the origin check themselves. |
| `signed` | Access token, session and active account |
| `private` | The same, plus the `permission` or one of the `anyPermission` values the route names |

- **Permissions** are read from the database on each call, so a change applies on the person's next request, even with a token they already hold. `modules/master/access/permissions.ts` reads what the person's profile allows in the module.
- **Profiles** are org-wide, in the `accessprofiles` collection, with grants keyed by module. Each person holds at most one, in `profileId`, and it is where all of their access comes from. `accessProfile.create` builds them and `userProfile.update` gives them.
- **Org tree:** every person has an `orgRoleId` in a tree with one root (`/org-roles`). A person sees records owned by people in the roles below theirs, but only with their own permissions: the tree passes on visibility, never permissions. `team` scope reads it in `modules/master/access/scope.ts`. Nobody but a super admin can move themselves or the role they hold. The sample tree is in `seed/org-roles.json`.
- **Rules that depend on the data** being changed, such as "nobody changes their own access", belong in services, because middleware can't see that data.

## Admin API

These routes run the admin console. Each one's permission is in `manifests/master.manifest.json`, and every change writes to the activity log.

| Routes | What they do |
|---|---|
| `GET /users`, `GET /users/:id`, `POST /users`, `PATCH /users/:id` | List, read, add and edit people. Lists take `page`, `pageSize` (up to 100), `search` and `status`. |
| `PATCH /users/:id/status` | Deactivate or reactivate someone |
| `POST /users/password-links` | Email people a one-time link to set a new password, through Resend |
| `DELETE /users/:id` | Remove someone who never signed in. Needs `user.delete`. |
| `GET /users/next-employee-number` | Preview the next employee number |
| `GET`, `PUT`, `DELETE /users/:id/photo` | Profile photos. People change their own; someone else's needs `user.update`. |
| `POST /users/:id/impersonate`, `POST /auth/stop-impersonating` | Development only: a super admin sees the app as someone else |
| `GET`, `POST /clients`, `GET`, `PATCH /clients/:id`, `PATCH /clients/:id/status`, `GET /clients/:id/history` | Clients, shared by every module. Need `client.read`, `.create`, `.update`. |
| `GET /users/access-options` | The loaded modules, for the Access screen. Needs `user.read` or `userProfile.update`. |
| `PUT /users/:id/profile` | Give someone a profile, or take it away with `null`. Needs `userProfile.update`. |
| `GET /modules/:key/people`, `GET /modules/:key/addable-people` | Who has access to a module through their profile, and who could be given a profile covering it |
| `GET`, `POST /access-profiles`, `PATCH` and `DELETE /access-profiles/:id` | List, add, edit and remove profiles. Need `accessProfile.read`, `.create`, `.update` and `.delete`. |
| `GET /modules`, `POST /modules/import`, `DELETE /modules/:key` | List, import and remove modules |
| `PUT` and `DELETE /modules/:key/resources/:resource` | Add a resource (`module.create`), change it and its actions (`module.update`), or remove it (`module.delete`), which is how a module gains or loses permissions. |
| `GET /audit` | The activity log, newest first. Takes `page`, `pageSize` and `actionPrefix`. |

Services enforce these rules, because they depend on the data being changed:

- **Own access:** only a super admin can change their own profile or org role. Nobody can deactivate themselves or reset their own password here. To change your own password, use `POST /auth/change-password`.
- **Super admins:** only a super admin can edit, deactivate or reset a super admin, or change their access, and no route can create one. A super admin always has everything, whatever is on their record.
- **Giving a profile:** `userProfile.update` is scoped. `team` reaches the giver's direct reports and everyone in the org roles below theirs, and `all` reaches everyone. The new profile, and the one it replaces, must both stay within the giver's own access in every module. This is how access is delegated: a project manager with `userProfile.update` at `team` scope can build profiles from what they hold and give them to their developers.
- **Building profiles:** someone other than a super admin can only put in what they hold themselves, at no wider reach, and can't change one that goes beyond their own access, or make one that holds everything.
- **Changing what a module offers:** adding a resource needs `module.create` in Master, changing a resource needs `module.update`, and removing a resource needs `module.delete`. After an edit, re-importing or removing that module needs it too.
- **Removing:** a profile someone holds can't be removed. Neither can an action or resource that a profile or route still uses, except by a super admin, which takes it out of them. Actions come from a fixed list: `read`, `create`, `update`, `delete` and `approve`.
- **Password links:** nobody is given a password. New people and password resets get a one-time link by email, sent through Resend (`RESEND_API_KEY`). Only a hash of the link is stored, a newer link replaces an older one, and using it signs the person out everywhere. Without a key, which only development allows, emails go to the backend log.
- **Deleting:** only someone who never signed in can be deleted, and only while no module's records name them. Each module lists what names a person in its `*UserReferences.ts`, and the app passes those checks to Master.
- **Online status** shows only where the viewer's `presence.read` scope reaches.
- **Impersonation** is for development: it needs `IMPERSONATION_ENABLED=true`, which production refuses, and is logged.
- **Deactivating and resetting** end all the person's sessions, so reactivating someone can't bring an old session back.
- **Modules:** Master is core and can't be replaced or removed through the API. Profiles keep their part for a removed module, which grants nothing unless the module is imported again.
- **Test page:** with it on, sign-in also accepts a request from the address the API is being reached on, so a tunnel link works without changing `ALLOWED_ORIGINS`. Browsers set `Origin` themselves, so another site can't claim that address.

## HR salaries

| Route | Needs | What it does |
|---|---|---|
| `GET /hr/salaries` | `salary.read` | Lists salaries the caller's scope reaches, with `page` and `pageSize` |
| `POST /hr/salaries` | `salary.create` | Adds a salary, which starts as pending |
| `PATCH /hr/salaries/:id` | `salary.update` | Changes a salary, which sends it back to pending |
| `PATCH /hr/salaries/:id/approve` | `salary.approve` | Marks it approved and records who did it |
| `DELETE /hr/salaries/:id`, `POST /hr/salaries/:id/restore` | `salary.delete` | Moves a salary to the recycle bin, or back. `GET /hr/salaries?deleted=true` lists the bin. |
| `GET /hr/salaries/:id/history` | `salary.read` | What changed, who changed it and when |
| `GET`, `POST /hr/salaries/:id/shares`, `DELETE /hr/salaries/:id/shares/:shareId` | `salary.read` | List, add and remove shares. The employee, anyone above them, or someone with `salary.share` may share. |

The scope from someone's profile decides who that reaches: `own` is the person, `team` adds their direct reports and everyone in the org roles below theirs, and `all` is everyone. Someone outside their reach gets `out_of_scope`. The activity log leaves out amounts, because people can read it without being allowed to see salaries. Sample salaries are in `seed/salaries.json`.

## Tasks

Projects and their tasks, from start through QA to approval, in `backend/src/modules/tasks/`. The full reference is in [docs/api/tasks.md](docs/api/tasks.md).

| Routes | Needs | What they do |
|---|---|---|
| `GET`, `POST /tasks/projects`, `GET`, `PATCH /tasks/projects/:id` | `project.read`, `.create`, `.update` | List, create, read and change projects |
| `PUT /tasks/projects/:id/members` | `project.update` | Replace the members. Someone with open tasks stays. |
| `GET /tasks/projects/health`, `/roster` | `project.read` | Hours used against allocated, and who works on what |
| `GET`, `POST /tasks/tasks`, `GET`, `PATCH /tasks/tasks/:id` | `task.read`, `.create`, `.update` | List (with filters, search and sorting), create, read and change tasks |
| `GET /tasks/tasks/summary`, `/export`, `/search` | `task.read` | Totals, CSV export and quick search |
| `PATCH /tasks/tasks/:id/qa-estimate`, `/flag`, `/billable`, `/actual-hours` | `task.update` | QA estimate, follow-up flag, billing and timer corrections |
| `GET /tasks/points`, `/tasks/points/:userId` | `points.read` | Career points and where they came from |
| `/tasks/projects/:id/credentials` | `credential.*` | Shared project logins with one-time codes |
| `/tasks/tasks/:id/attachments` | `task.read` | Files, uploaded straight to R2 (or the local disk in development) |
| `/tasks/incentives`, `/tasks/projects/:id/incentives` | `incentive.*` | Monthly and project incentives |
| `POST /tasks/tasks/:id/start`, `/pause`, `/complete` | `task.read` | The assignee's timer. Only the assignee. |
| `POST /tasks/tasks/:id/qa-handover` | `task.update` | Hand to a project member for QA |
| `POST /tasks/tasks/:id/qa-start`, `/qa-pause`, `/qa-complete` | `task.read` | The QA timer and result. Only the QA person. |
| `POST /tasks/tasks/:id/approve`, `/revert` | `task.approve` | Settle hours and finish, or send back with a comment. Never on your own work. |
| `POST /tasks/tasks/:id/cancel` | `task.delete` | Cancel an open task. Tasks are never deleted. |
| `GET /tasks/tasks/:id/history`, `GET`, `POST /tasks/tasks/:id/comments`, `PUT /tasks/tasks/:id/references` | `task.read`, `task.update` for references | History, comments and links between tasks |

A task belongs to its assignee, TL, QA person and project lead, so the scope reaches it through any of them. The rules about the assignee, the QA person and approving your own work come from the task's fields, never from role names. QA hours are protected fields. Accounts invoices bill finished tasks at their estimate. The Tasks frontend is in `twintrack-tasks/`.

## Accounts

The company's money, in `backend/src/modules/accounts/`: categories, vendors, bank accounts with balances and statements, bills with two-person approval, payments, receipts allocated to invoices, invoices billed from Tasks work with a Word document emailed through Resend, monthly payroll from HR salaries and Tasks incentives, and evidence documents. Accounts has no frontend yet. The full reference is in [docs/api/accounts.md](docs/api/accounts.md).

Posted payments and receipts are never edited: a mistake gets a linked reversal. Whoever made a bill or payroll run can't approve it. Accounts reads and marks Tasks work only through `modules/tasks/billing/taskBilling.ts`, reads HR salaries through `findSalariesInEffect`, and marks Tasks incentives paid when payroll pays them.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Postman

The API requests and their tests are saved in `postman/`. That folder is ignored by git, so it only exists on machines where it has been added by hand, and `npm run test:postman` needs it. Update the collection whenever a route changes. If the folder is there, `npm test` fails when a route has no request in it. If it isn't, that check is skipped. Write route parameters as variables, so `/users/:id` is `{{baseUrl}}/users/{{userId}}`.

**In Postman:**
1. Choose **Import** and select both files in `postman/`.
2. Choose **TwinTrack Local** in the environment menu at the top right.
3. Start the backend with `npm run dev:backend`.
4. Send one request, or run the whole **TwinTrack Master API** collection to see its tests.

**From the terminal:** `npm run test:postman` runs the same collection. It starts its own copy of the API, so the dev server doesn't need to be running. MongoDB does. It empties and re-seeds its own `twintrack_postman` database on each run.

Running the **Admin** folder in Postman against a dev server adds one test person to that server's database each time, because people can't be deleted. Each full run also counts 3 failed logins, so a fourth run within 15 minutes can hit the rate limit there. The **Refusals** folder changes nothing and can run on its own. A rate limit, a database outage and an expired session need more setup than a collection can do, so `npm test` covers those.

## Let someone else test the API

`localhost` only works on the computer running the API, so other people need an address that reaches it. MongoDB stays private either way, because only the API talks to it.

With `TEST_PAGE_ENABLED=true`, the API serves a test page at `/try`, with nothing to install. It's off by default, and the API refuses to start with it on in production. On it, testers can:

- Sign in as any test account, listed in `backend/test-page/accounts.json`, see what that person can do and reach, and send any route as them.
- Sign in as the super admin, build or edit a profile, give it to someone, then sign in as that person to test the change.
- Run the ready-made scenarios for each route.

Use a separate database, so testers can't change your dev data. The test page fills in the password `demo1234` from `backend/test-page/accounts.json`, so **anyone with your link can sign in as any test person, including the super admin**. That reaches only this test database, not your computer, and it stops when you close the tunnel. If you seed with a different password, change it in that file too. In PowerShell, from `backend/`:

```powershell
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/twintrack_demo?replicaSet=rs0'
$env:SEED_PASSWORD = 'demo1234'
$env:TRUST_PROXY_HOPS = '1'
$env:TEST_PAGE_ENABLED = 'true'
$env:PORT = '4200'
npm run seed
npm run dev
```

Then, in a second terminal, open a temporary public address with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

```powershell
cloudflared tunnel --url http://localhost:4200
```

It prints an `https://….trycloudflare.com` address. Send testers that address followed by `/try`. It stops working when you close the tunnel, or when the computer sleeps. `TRUST_PROXY_HOPS=1` lets rate limits see each tester's own address through the tunnel. Environment variables set this way take priority over `backend/.env`, and last only for that terminal.

For someone on the same network, skip the tunnel and `TRUST_PROXY_HOPS`, allow the port through Windows Firewall, and use `http://<your computer's IP>:4200/try`.

**Resetting the test data:** scenarios tagged **Changes data** affect everyone testing. `npm run seed` keeps passwords already set, so to start completely fresh, stop the API, run `mongosh "mongodb://127.0.0.1:27017/twintrack_demo?replicaSet=rs0" --eval "db.dropDatabase()"`, then seed and start it again.

**Keeping the page current:** its scenarios are in `backend/test-page/scenarios.json`. `tests/test-page.test.ts` replays every one against the API, and fails if a built route has none. It also fails if `accounts.json` and `seed/users.json` list different people.
