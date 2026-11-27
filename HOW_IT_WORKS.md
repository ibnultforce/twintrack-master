# How TwinTrack Master works

A detailed explanation of what Master does and how, for team members and developers who need to understand the system before changing or supporting it. For using the screens, see [USER_GUIDE.md](USER_GUIDE.md). For the exact API, see [docs/api/master.md](docs/api/master.md).

## 1. The shape of the system

TwinTrack is **one backend and many frontends**.

```
                 ┌──────────────────────────────┐
 Master app  ───▶│                              │
 (:3100)         │   Master backend (:4100)     │──▶ MongoDB (replica set)
 Projects app ──▶│   every module's API,        │──▶ File storage (R2, or local disk)
 (:3300)         │   permissions and sessions   │──▶ Email (Resend)
 Accounts app ──▶│                              │
 (:3400)         └──────────────────────────────┘
 Claude / apps ──▶  MCP and API tokens
```

- **The backend** in `twintrack-master/backend` serves the API for Master and every module (Project management under `/projects/*`, Accounts under `/accounts/*`, and so on). A module's code lives in `backend/src/modules/<module>/`.
- **Each module has its own frontend** on its own subdomain (`accounts.twintrack.localhost:3400`). It holds no business rules: it calls the backend and shows what comes back.
- **One sign-in** covers all of them. A module frontend reuses the Master session.
- A new module is a frontend plus routes in this backend, never a new backend.

The database is MongoDB run as a replica set, because the API uses transactions: a record, its history and its activity-log entry save together or not at all.

## 2. Signing in and sessions

1. A new person never gets a password. Creating them, or a reset, emails a **one-time link** (through Resend). The link lets them set a password of at least 8 characters.
2. Signing in returns two things:
   - an **access token**, valid 15 minutes, holding only *who* the person is. The frontend keeps it in memory.
   - a **refresh token**, in an `HttpOnly`, `SameSite=Strict` cookie that only the `/auth` routes receive. Only its hash is stored.
3. When the access token runs out, the frontend calls refresh. The refresh token is **replaced every time**.
4. **Limits:** a session ends after 7 days unused and after 30 days in any case.
5. **Two tabs:** a just-replaced refresh token keeps working for 10 seconds, so two tabs refreshing at once don't sign the person out.
6. **Theft protection:** an old refresh token used after that window ends the whole session and is logged as `auth.session_token_reused`.
7. **Origin check:** sign-in, refresh and sign-out refuse requests from any site not listed in `ALLOWED_ORIGINS`.
8. **Rate limit:** failed sign-ins and password changes are limited per address. Counts are stored in MongoDB, so every server shares them.
9. Changing a password ends the person's other sessions.

## 3. How a request is checked

Every API route declares an **access rule** in its route file:

| Access | Checks, in order |
| --- | --- |
| `public` | None (sign-in, file links checked by signed tokens) |
| `signed` | A valid session and an active account |
| `private` | The same, then a named permission (or one of several) |

The route list is passed to `registerRoutes`, which attaches the right checks. A protected route can't go live without them. Each module's **manifest** (`manifests/<module>.manifest.json`) lists every route and its rule, and a test fails if code and manifest disagree.

**Permissions are never in the token.** On every call the backend reads the person and their profile from the database. So a change to someone's access applies on their next click, even with a token they already hold.

A super admin can tighten or loosen a route's rule in the app (Modules → APIs). The change is stored on the module and read on every call.

## 4. Where access comes from

### Profiles

- A **profile** is a named set of grants, keyed by module: for each kind of record, which actions (read, create, update, approve, delete…) and with what reach.
- Each person holds **at most one profile**, and it is the **only** source of their access. There are no permission sets and no access from roles.
- **Nothing ships with the product.** A new organisation has no profiles; only the super admin can do anything until profiles are built.

### Reach (scope)

Each permission has a scope: `own` < `team` < `all`.

| Scope | Reaches |
| --- | --- |
| `own` | Records the person owns or that are about them |
| `team` | The person, plus everyone who reports to them through `managerId`, at any depth |
| `all` | Everything |

`team` follows the **reporting line**, not job titles. Two project managers at the same level each reach only their own people.

### Org roles

Every person has an **org role** in a tree with one root (for example CEO → Director → Project manager → Developer). Org roles are **job levels only**: they never give access. They are used when a record is shared with "a role and everything below it".

### Giving and building profiles

- Building profiles needs the `accessProfile.*` permissions, and only from permissions the builder holds. A super admin alone can use the wildcard `"*"`.
- Giving a profile (`PUT /users/:id/profile`) needs `userProfile.update`, which is **scoped**: `team` means "people in my reporting line".
- The new profile **and** the one it replaces must both stay within the giver's own access, in every module. This is how access is delegated: a project manager can give developers a profile, but never more than they hold themselves.

### Safety rules kept in code

Whatever the data says:

- Only a super admin changes a super admin.
- Nobody changes their own access: profile, org role or manager.
- Only a super admin builds or gives a profile beyond their own access.
- Nobody but a super admin makes someone from outside their team report to them.

## 5. Records, sharing, field security and history

These are shared by every module's business records.

**Record base.** A business record gets `createdBy`, `updatedBy`, `version` and soft delete (`deletedAt`). Deleted records are hidden from every query but kept, and can be restored.

**Versions.** Each update names the version it read. If someone else saved in between, the update is refused (`409 version_conflict`) instead of silently overwriting.

**History.** For the fields a module's manifest lists as `trackedFields`, every change is written to record history (who, when, field, before, after) in the same transaction as the change.

**Sharing** lets one record reach beyond a permission's scope:

- shared with a person, an org role, or a role and everything below it;
- for `read` or `edit`;
- it **never adds a permission**: the person must already hold that kind of permission;
- the owner, anyone above them, or someone with the record's `share` permission may share;
- approving, deleting and restoring stay scope-only, never by sharing.

The check that combines scope, the manifest's sharing model and shares is `assertCanReachRecord`.

**Field-level security.** Every field of a record has a level per profile: `hidden`, `read`, `create` (set on a new record only) or `edit`. Fields a grant doesn't name follow its actions, except **protected** fields (salaries, bank numbers), which stay hidden unless named. Responses and history are redacted, and writes to fields above the person's level are refused.

**Custom objects.** A super admin can define new kinds of record with their own fields. Their records live in `custom_records` under `/records/:module/:object`, with the same permissions, sharing, field security and history.

## 6. Modules and manifests

A **manifest** is a module's contract: its resources (kinds of record), actions, fields, tracked fields, sharing model and routes. `npm run seed:modules` loads manifests into the database. A manifest the database hasn't loaded grants nothing, and the Modules and Profiles screens don't show it.

Modules plug into Master in two ways, without Master importing their data:

- **userReferenceChecks:** what still names a person, so a person on a project or voucher can't be deleted (deactivate them instead).
- **mcpToolProviders:** the module's tools for Claude and other connected apps.

## 7. Connected apps (MCP and API tokens)

- People can connect Claude (or another app) through **OAuth and MCP**. The app acts **as that person**, with exactly their access and scope.
- People can also make **API tokens** for scripts. Administrators see and revoke them under API tokens.
- Module tools (such as `list_tasks` in Project management, or the read-only Accounts tools) go through the same checks as the screens.

## 8. Files

Task files and other uploads go **straight from the browser to storage** in parts: Cloudflare R2 in production, or a local folder in development (served by `/files/parts` and `/files/content`, checked by signed tokens instead of a session). The backend hands out short-lived signed addresses and checks sizes when an upload finishes.

## 9. The activity log

Sign-ins, failed sign-ins, every access change (profiles, roles, managers), reveals of protected numbers and every module's important steps are written to the activity log, with who, when and what. It can be read but not changed.

## 10. Keeping everything in step

When a route changes, these change in the same commit (tests catch most of them):

1. the module's manifest, with a raised version, loaded with `npm run seed:modules`;
2. the Postman collection (a test fails if a route has no request);
3. the README, `docs/api/<module>.md`, `.env.example`, seed data and the progress page;
4. at least one scenario on the test page (`backend/test-page/scenarios.json`).

Every push to `main` runs the full tests and deploys to demo.twintrack.work.
