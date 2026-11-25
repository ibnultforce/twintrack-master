# Master API

Sign-in, people, access and module administration. Routes have no path prefix. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## How access works

Each person holds one **profile**, and it is where all of their permissions in every module come from. No profiles ship with the product, so a super admin, who holds every permission, creates them and gives them out. The permissions below are what each route needs.

## Health

### `GET /health`

**Access:** `public`

**Returns:** `200` with `{ "status": "ok", "database": "connected" }`, or `503` with `"unavailable"` and `"disconnected"`.

### `GET /api-check`

**Access:** `public`

**Returns:** `200` with `{ "status": "ok", "module": "master", "commit": "<git hash>", "time": "<ISO timestamp>" }`. `commit` is the commit the server runs, set by the deploy (`DEPLOYED_COMMIT`), and `null` locally. Compare it with the latest commit on `main` to see whether the live server is up to date. It does not touch the database, so it answers even while `/health` reports `503`.

## Sign-in

Login, refresh and logout refuse a missing or unlisted `Origin` header with `403 origin_not_allowed`.

### `POST /auth/login`

**Access:** `public`

**Body:** `email`, `password`

**Returns:** `accessToken`, `expiresIn`, and sets the refresh cookie. Also records when the person last signed in.

**Errors:** `401 invalid_credentials`, `403 account_inactive`, `429 too_many_attempts`

### `POST /auth/refresh`

**Access:** `public`, using the refresh cookie

**Returns:** `accessToken`, `expiresIn`, and usually a new cookie.

**Errors:** `401 no_session`, `401 session_revoked`, `401 session_expired`, `401 account_inactive`

### `POST /auth/logout`

**Access:** `public`, using the refresh cookie if there is one

**Returns:** `{ "signedOut": true }`, and clears the cookie.

### `POST /auth/set-password`

**Access:** `public`. The one-time token from the emailed link is the credential, so wrong tokens count as failed attempts.

**Body:** `token`, `newPassword` (8 to 256 characters)

**Returns:** `{ "passwordSet": true }`. Uses the link up, removes the person's other links and signs them out everywhere.

**Errors:** `400 invalid_password_link` (unknown, used, replaced by a newer link, or expired), `422 validation_failed`, `429 too_many_attempts`

Links are sent by [`POST /users`](#post-users) and [`POST /users/password-links`](#post-userspassword-links) through Resend. They point at `PORTAL_URL/set-password?token=…` and last `PASSWORD_LINK_TTL_HOURS` (24 by default). Only a hash of each token is stored. Without `RESEND_API_KEY`, which production requires, emails are written to the backend log instead.

### `POST /modules/:key/handoff`

**Access:** `signed`, and the caller must have access to the module (any permission in it, or super admin). Refused while signed in as someone else.

**Body:** optional `redirectUrl`, which must be exactly one of the module's saved sign-in addresses. Leave it out for the first one.

**Returns:** `redirectTo`, the sign-in address with `?code=…` added, and `expiresIn` (60 seconds). The portal sends the browser there. The code works once; only its hash is stored.

**Errors:** `403 forbidden` (no access to the module), `403 impersonating`, `404 unknown_module`, `409 no_redirect_url` (a super admin hasn't saved one), `422 unknown_redirect_url`

### `POST /auth/handoff`

**Access:** `public`. The code is the credential, so wrong codes count as failed attempts. The request's `Origin` must be the origin of the address the code was sent to.

**Body:** `code`

**Returns:** `accessToken`, `expiresIn` and `module`. The token belongs to the person's Master session, so signing out of Master, or being deactivated, ends it too. There is no refresh cookie: when the token expires, the module sends the person back to the portal's `/open/<module key>` page, which signs them in again without a password while their Master session lasts. See [signing in from a module frontend](README.md#signing-in-from-a-module-frontend).

**Errors:** `400 invalid_code` (unknown, used or expired), `401 session_revoked`, `403 origin_not_allowed`, `422 validation_failed`, `429 too_many_attempts`

## My account

### `GET /auth/me`

**Access:** `signed`

**Returns:** `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `superAdmin`, `orgRoleId`, `manager`, `employeeNumber`, `photoUpdatedAt`, `canImpersonate`, and `impersonatedBy` (`id`, `name`) when a super admin is signed in as this person.

### `PATCH /auth/me`

**Access:** `signed`

**Body:** `name`

**Returns:** the updated profile.

### `POST /auth/change-password`

**Access:** `signed`, not while signed in as someone else

**Body:** `currentPassword`, `newPassword` (12 to 256 characters, different from the current one)

**Returns:** `{ "passwordChanged": true }`, and ends the person's other sessions.

**Errors:** `403 wrong_current_password`, `403 impersonating`, `429 too_many_attempts`

### `POST /auth/verify-password`

**Access:** `signed`

**Body:** `password`

**Returns:** `{ "verified": true }`. Asked for before showing something sensitive, such as a salary. Changes nothing.

**Errors:** `403 wrong_current_password` (not a 401, so frontends don't treat it as an expired token), `429 too_many_attempts`

### `POST /me/heartbeat`

**Access:** `signed`

**Returns:** `204`. Open apps call it every 45 seconds, and someone shows as online for two minutes after the last call.

### `GET /directory`

**Access:** `signed`

**Query:** `page`, `pageSize`, `search` (name, email or title)

**Returns:** `people`, `total`. Active people, without super admins, each with `id`, `name`, `email`, `title`, `department`, `team`, `employeeNumber`, `photoUpdatedAt`, and `online` only where the viewer's `presence.read` scope reaches them.

### `GET /me/modules`

**Access:** `signed`

**Returns:** `modules`, the ones this person can open, each with `key`, `name`, `description`, `frontendUrl`, `profileName`.

### `GET /me/permissions/:module`

**Access:** `signed`

**Returns:** `module`, `hasAccess`, `profile`, `profileName`, `permissions` (permission to scope), `apis` (each permission held, to the APIs it opens as `METHOD /path`, for trying them from Your permissions), `guides` (for each of those APIs, its `purpose`, `input` and `examples`: sample requests taken from the test page's scenarios, each with `title`, `outcome` (`accepted` or `refused`), `expectedStatus`, `expectedCode`, `sentBy` (who sends it in the example data), `parameters`, `parameterSources` (for an empty parameter, the earlier-step value it takes), `query`, `body`, `sendFirst` (requests the example sends before it), `needs` (values an earlier request makes, such as `projectId`) and `changesData`. Scenarios about a missing or forged token are left out, since Try sends your own. For a super admin, samples name real records in this database instead of the example data's ids, and a sample that creates something gets a fresh name, key and email, so it doesn't clash with an existing record. Each of a super admin's samples also has `choices`: the body fields and path parameters that take a record's id, each with `field`, `location` (`body` or `path`), `list` and `isMany`. The answer then adds `references`, up to 100 records of each kind (such as `User` or `OrgRole`) as `id` and `label`, for choosing them by name. `choices` also covers id fields the API's body schema names that the sample leaves out, such as `leadId`. Every guide has `fieldOptions`: the body fields that take one of a fixed set of values, each as `field`, `values` and `isMany`, read from the schema the API checks its body with, which a route declares as `bodySchema`), `fieldAccess` (protected fields, as `resource.field` to `hidden`, `read`, `create` or `edit`, for every controlled field, including levels that follow the actions)

**Errors:** `404 unknown_module`

## People

A "person" in these responses has `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `status`, `managerId`, `orgRoleId`, `profileId`, `superAdmin`, `employeeNumber`, `photoUpdatedAt` and `lastSignedInAt` (missing for someone who never signed in), plus `online` where the viewer's `presence.read` scope reaches them. Password data is never included.

Nobody is given a password. New people, and people whose password is reset, are emailed a one-time link to set their own.

### `GET /users`

**Access:** `private`, needs `user.read`

**Query:** `page`, `pageSize`, `search` (name, email or title), `status` (`active` or `inactive`)

**Returns:** `users`, `total`

### `POST /users`

**Access:** `private`, needs `user.create`

**Body:** `name`, `email`, `orgRoleId` (everyone has a place in the [org tree](#org-roles)), and optionally `title`, `department`, `team`, `contract` (`permanent`, `intern`, `contractor`), `managerId`

**Returns:** `201` with `user` and `invitationSent`. The person gets the next employee number and is emailed a link to set their password. `invitationSent` is `false` if the email failed, and the person is still added.

**Errors:** `409 email_taken`, `422 validation_failed` when `orgRoleId` is missing or no such org role exists

### `GET /users/next-employee-number`

**Access:** `private`, needs `user.create`

**Returns:** `employeeNumber`, the one the next person added will most likely get.

### `POST /users/password-links`

**Access:** `private`, needs `user.update`

**Body:** `userIds` (1 to 100)

**Returns:** `results`, one per person: `userId`, `email`, `sent`, and `error` when not sent (`unknown_user`, `account_inactive`, `super_admin_protected`, `own_account`, `email_failed`). One failure never stops the rest. Their current password keeps working until they use the link.

### `GET /users/access-options`

**Access:** `private`, needs `user.read` or `userProfile.update`

**Returns:** `modules`, each with `key` and `name`, for the Access screen.

### `GET /users/:id`

**Access:** `private`, needs `user.read`

**Returns:** the person.

**Errors:** `404 unknown_user`

### `PATCH /users/:id`

**Access:** `private`, needs `user.update`

**Body:** any of `name`, `email`, `title`, `department`, `team`, `contract`, `managerId`, `orgRoleId`, `employeeNumber`. `null` clears an optional field. A profile is given with [`PUT /users/:id/profile`](#put-usersidprofile), not here.

**Returns:** the updated person.

**Errors:** `403 super_admin_protected`, `403 own_account` when someone other than a super admin changes their own `orgRoleId` or `managerId`, `403 outside_own_team` when someone other than a super admin makes a person from outside their team report to them or to anyone in their team (a manager link widens `team` scope), `403 beyond_own_access` when someone other than a super admin changes the `email` of a person whose profile goes beyond their own access (password links go to the email, so it would hand that access over), `404 unknown_user`, `409 email_taken`, `409 employee_number_taken`, `422 validation_failed` for an org role that doesn't exist or another field such as `profileId`

### `PATCH /users/:id/status`

**Access:** `private`, needs `user.update`

**Body:** `status` (`active` or `inactive`). Deactivating signs the person out everywhere.

**Returns:** the updated person.

**Errors:** `403 own_account`, `403 super_admin_protected`, `404 unknown_user`

### `DELETE /users/:id`

**Access:** `private`, needs `user.delete`

**Returns:** `{ "deleted": true }`. Removes someone added by mistake, with their links, sessions, photo and shares made to them.

**Errors:** `403 own_account`, `403 super_admin_protected`, `404 unknown_user`, `409 has_signed_in` (only someone who never signed in can go: everyone else is deactivated), `409 user_in_use` (a module's records, or people reporting to them, still name them; the message says which)

### `GET /users/:id/photo`, `PUT /users/:id/photo`, `DELETE /users/:id/photo`

**Access:** `signed`. Anyone signed in sees photos. People change their own, and changing someone else's needs `user.update` in Master, never reaching a super admin's.

**PUT body:** the image itself, PNG, JPEG or WebP up to 2 MB, with its image content type. The type is read from the bytes.

**Returns:** GET the image, PUT `photoUpdatedAt`, DELETE `{ "removed": true }`.

**Errors:** `403 forbidden`, `403 super_admin_protected`, `404 no_photo`, `413` too large, `415 unsupported_photo`, `422 validation_failed` for an empty body

### `POST /users/:id/impersonate`

**Access:** `signed`, super admins only, and only with `IMPERSONATION_ENABLED=true`, which production refuses unless `IMPERSONATION_ALLOWED_IN_PRODUCTION=true` is also set.

**Returns:** `accessToken`, `expiresIn`, `user` (`id`, `name`). A session as that person that lasts one access token and can't be refreshed, so the super admin's own session is untouched. Logged as `auth.impersonation_started`. While it lasts, changing their name or password, making API tokens and approving OAuth apps are refused with `403 impersonating`.

**Errors:** `403 forbidden`, `403 super_admin_protected`, `404 impersonation_disabled`, `404 unknown_user`, `409 own_account`, `409 account_inactive`, `409 already_impersonating`

### `POST /auth/stop-impersonating`

**Access:** `signed`, as the person being impersonated

**Returns:** `accessToken`, `expiresIn` for the super admin's own session. Ends the impersonation session.

**Errors:** `409 not_impersonating`, `401 session_revoked` when the super admin's own session has ended too

## Changing someone's access

A person's access comes from their one profile, given with the route below. It needs the Master permission `userProfile.update`, whose scope decides whose profile someone may change: `team` reaches everyone who reports to them, at any depth, and `all` reaches everyone. The profile being given, and the one it replaces, must both stay within the giver's own access in every module.

Only a super admin can change a super admin's profile or their own.

### `PUT /users/:id/profile`

**Access:** `private`, needs `userProfile.update`

**Body:** `profileId`, or `null` to take the profile away

**Returns:** the updated person. The change applies on their next request.

**Errors:** `403 beyond_own_access` when the new or the current profile goes beyond your own access, `403 out_of_scope` for someone your scope doesn't reach, `403 own_access`, `404 unknown_user`, `409 super_admin`, `422 validation_failed` for a profile that doesn't exist

### `GET /modules/:key/people`

**Access:** `private`, needs `user.read` or `userProfile.update`. Without `user.read`, only the people your `userProfile.update` reaches are listed.

**Returns:** `module`, `people` whose profile gives them access, each with `id`, `name`, `email`, `status`, `orgRole` (`id` and `name`, or `null`), `profile` (`id` and `name`) and `profilePermissions`.

**Errors:** `404 unknown_module`

### `GET /access-profiles/:id/people`

**Access:** `private`, needs `user.read` or `userProfile.update`. Without `user.read`, only the people your `userProfile.update` reaches are listed.

**Returns:** `profile` (`id` and `name`) and `people` who hold it, by name, each with `id`, `name`, `email`, `status`, `orgRole` (`id` and `name`, or `null`) and `canRemove`. `canRemove` is true when you may take the profile away from them with `PUT /users/:id/profile` and `null`: the person is in your `userProfile.update` scope, isn't you, and the profile stays within your own access. Every holder has exactly what the profile allows, which `GET /access-profiles` lists.

**Errors:** `404 unknown_profile`

```sh
curl "$API/access-profiles/ap_developer/people" -H "Authorization: Bearer eyJ..."
```

### `GET /modules/:key/addable-people`

**Access:** `private`, needs `userProfile.update`

**Query:** `page`, `pageSize`, `search` (name, email or title)

**Returns:** `total`, `people`, each with `id`, `name`, `email`, `title` and `profileId` (the profile they hold now). Lists active people your scope reaches whose profile doesn't cover the module yet, leaving out super admins and the caller.

**Errors:** `404 unknown_module`

## Org roles

The organisation tree. Every org role has one parent, except the single root. Org roles describe job levels. They don't decide what `team` scope reaches, which follows each person's manager instead; they decide only who a share to an org role, or to a role and everything below it, reaches. The tree passes on no permissions.

An org role in these responses has `id`, `name`, `description`, `parentId` (`null` for the root), `depth` (`0` for the root), `peopleCount`, `createdAt` and `updatedAt`.

These org roles are separate from the per-module roles under [Roles and permissions](#roles-and-permissions), which decide what someone can do.

### `GET /org-roles`

**Access:** `private`, needs `orgRole.read`

**Returns:** `orgRoles`, parents before their children.

### `POST /org-roles`

**Access:** `private`, needs `orgRole.create`

**Body:** `name`, `parentId`, and optionally `description`. Leave out `parentId` only to create the root, while the tree is empty.

**Returns:** `201` with the org role.

**Errors:** `422 validation_failed` when the parent doesn't exist, or for a second root

### `PATCH /org-roles/:id`

**Access:** `private`, needs `orgRole.update`

**Body:** any of `name`, `description` (`null` clears it), `parentId`. A new `parentId` moves the role and everything below it.

**Returns:** the updated org role.

**Errors:** `403 own_org_role` when someone other than a super admin moves the role they hold, `404 unknown_org_role`, `422 validation_failed` when moving the root, or moving a role below itself or one of its descendants

### `DELETE /org-roles/:id`

**Access:** `private`, needs `orgRole.delete`

**Returns:** `204`

**Errors:** `404 unknown_org_role`, `409 org_role_has_children`, `409 org_role_in_use`

## Modules

Master can't be replaced or removed through the API.

### `GET /modules`

**Access:** `private`, needs `module.read`

**Returns:** `modules`, each with `key`, `name`, `version`, `description`, `core`, `frontendUrl`, `resources`, `apis`, `routes`, and `usedBy`, the APIs and profiles relying on each permission. `routes` lists every built API as `method`, `path` (with the module's base path), `access` (`public`: anyone without signing in, `signed`: any signed-in person, `private`: a profile permission) and `permissions`, any one of which opens a private API (empty otherwise). These are the rule in force; `declaredAccess` and `declaredPermissions` are what the API was built with, `isChanged` says a super admin changed it, and `allowedAccess` lists the rules it can be given (see [`PUT /modules/:key/route-access`](#put-moduleskeyroute-access)). Every manifest route must state its `access`; a private route must name a permission and the others may not.

### `POST /modules/import`

**Access:** `private`, needs `module.create`

**Body:** `password` (your own, to confirm it's you) and `manifest` (the whole module manifest). The manifest may carry the module's data model as `schema` (JSON Schema with `$defs`, as `GET /modules/:key/schema` returns); without one, the module keeps the schema it has.

**Returns:** `201` for a new module or `200` for a replacement, with `key`, `version`, `created`, `files`: what the change did to the repo, described under [Module files](#module-files), and `change` and `changeLog`, described under [Changes to build](#changes-to-build).

Replacing a module whose resources were edited in the app also needs `module.update`, unless you're a super admin. A manifest with the old `roles`, `grantable`, `managesAccessOf` or `permissionSets` fields is refused.

**Errors:** `403 wrong_current_password`, `403 core_module`, `409 permissions_edited`, `429 too_many_attempts`

### `GET /modules/:key/export`

**Access:** `private`, needs `module.read`

**Returns:** the module's manifest as it stands, including resources and custom objects changed in the app, and its data model as `schema` when it has one. It can be sent back as `manifest` to `POST /modules/import`.

**Errors:** `404 unknown_module`

### `PUT /modules/:key/frontend`

**Access:** `private`, needs `module.update`, and only a super admin may (`403 super_admin_only`): whoever controls a redirect address receives people's sign-ins.

**Body:** the whole setting, replacing what was saved:

- `frontendUrl`: the module's frontend address, such as `https://hr.twintrack.com`, or `null` to fall back to `MODULE_FRONTEND_URLS`.
- `redirectUrls`: up to 10 full addresses where [`POST /modules/:key/handoff`](#post-moduleskeyhandoff) may send one-time codes. The first is the default. Each must be on the frontend address or an allowed origin, with no `#fragment`.
- `allowedOrigins`: up to 20 addresses whose pages may call the API, on top of `ALLOWED_ORIGINS`. The frontend address is allowed without being listed.

Production accepts plain `http` only for addresses on the same computer (`localhost`, `*.localhost`, `127.0.0.1`).

**Returns:** `frontendSettings`: `frontendUrl`, `frontendUrlSource` (`app`, `environment` or `null`), `redirectUrls`, `allowedOrigins`, `changedAt`. `GET /modules` returns the same for each module. An import keeps it, since it isn't in the manifest. A change applies at once on this server and within 30 seconds on any other.

**Errors:** `403 super_admin_only`, `404 unknown_module`, `422 validation_failed` (each bad address named in `fields`)

### `GET /modules/:key/schema`

**Access:** `private`, needs `module.read`

**Returns:** the module's data model as JSON Schema: each record its API returns is an entry in `$defs`, and `x-fieldAccess` on a property marks field security (`controlled`, `protected`). It's loaded from `manifests/<key>.schema.json` by the seed, from a manifest's `schema` by `POST /modules/import`, or by `PUT /modules/:key/schema`. A module with none returns an outline with empty `$defs`. The download starts with `x-instructions`: what the file is, how to edit it and import it back, and the rules (`$defs` required, `x-fieldAccess` must agree with the manifest). `x-instructions` is never stored: `PUT /modules/:key/schema` and `POST /modules/import` drop it, so a downloaded file can be imported back unchanged. `GET /modules` returns each module's `schema` without it.

**Errors:** `404 unknown_module`

### `PUT /modules/:key/schema`

**Access:** `private`, needs `module.update`

**Body:** `schema`: a JSON Schema object with `$defs`, each definition named like `Project` and an object. Other keys (`$schema`, `title`, `description`, definitions' contents) are kept as sent.

**Returns:** `key`, `definitions` (how many), `files`: what the change did to the repo, described under [Module files](#module-files), and `change` and `changeLog`, described under [Changes to build](#changes-to-build). Replaces the module's data model, which the Modules screen, the pack's `schema.json` and `GET /modules/:key/export` then show. Resources, routes and access don't change. Recorded in the activity log as `module.schemaImported`.

**Errors:** `404 unknown_module`, `422 validation_failed`

### `GET /modules/:key/pack`

**Access:** `private`, needs `module.read`

**Returns:** `files`, each with `path` (relative to the pack, such as `api/manifest.json`) and `size` in bytes. These are the module's frontend handoff pack. Every loaded module has one: `api/manifest.json` and `schema.json` are built from the database on each request, so they include edits made in the app, and the other files (instructions, data model notes, API doc, Postman, `design.css`) come from `module-packs/<key>/` in the deployed code, made by `npm run export:module-pack`. Give them to Claude Code with the module starter to build the module's frontend.

**Errors:** `404 unknown_module`

### `GET /modules/:key/pack/file`

**Access:** `private`, needs `module.read`

**Query:** `path`, one of the paths `GET /modules/:key/pack` lists.

**Returns:** the file as a download. Any other path, including one that tries to leave the pack, is refused.

**Errors:** `404 unknown_module`, `404 unknown_pack_file`, `422 validation_failed`

### `DELETE /modules/:key`

**Access:** `private`, needs `module.delete`

**Returns:** `removed`, `key`, `affectedUsers` (people whose profile covers the module) and `files`: what the change did to the repo, described under [Module files](#module-files). Profiles keep their part for it, which gives nothing until it's imported again.

**Errors:** `403 core_module`, `404 unknown_module`, `409 permissions_edited`

### Module files

The seed and every deploy load modules from `manifests/<key>.manifest.json` and `manifests/<key>.schema.json`, so a change made only in the database is replaced by the next `npm run seed:modules` or deploy. When `MODULE_FILE_SYNC_ENABLED` is on (the default in development, refused in production), `POST /modules/import`, `PUT /modules/:key/schema` and `DELETE /modules/:key` also write or delete those files in the repo, after the database change is saved, and rebuild `module-packs/<key>/` with `npm run export:module-pack`. Commit the files they name.

`files` in their responses holds:

- `synced`: whether the repo files were written. `false` on a server that doesn't write them, or when writing failed; `warning` then says the change lasts only until the next deploy.
- `written`, `removed`: repo paths, such as `manifests/demo.schema.json`. A manifest import writes the schema file only when the manifest carries a `schema`. Custom objects are never written: they live in the database, and an import keeps them.
- `unchanged`: files that already held the same content. They are left alone, keeping their hand formatting. A changed file keeps its key order and line endings, so its diff shows only what changed.
- `pack`: `rebuilt`, and a `message` saying why not, such as a new module having no `docs/api/<key>.md` yet. A removal keeps the pack folder, which holds hand-written files. The pack's `api/manifest.json` and `schema.json` are built from the database on each download either way.
- `routesWithoutCode`: routes the manifest lists, not marked `planned`, that the backend doesn't serve, as `GET /demo/notes`. They answer `404 no_route` until their code is built and registered.

A failed write never undoes the import. Only the manifest, the schema and the pack follow an import: the backend's models and validators, Postman, `docs/api/` and `/try` scenarios still change in code. [Changes to build](#changes-to-build) lists what that leaves to do.

### Changes to build

Every `POST /modules/import` and `PUT /modules/:key/schema` that changes something records what it changed, in the same transaction, as one pending change in `module_changes`. Each of its `items` has:

- `kind`: `added`, `removed` or `changed`.
- `subject`: what changed, such as `Route POST /demo/notes/:id/archive`, `Actions of demo.note`, `recordFields of hr.salary` or `Field Note.status`.
- `detail`: how, when the kind alone doesn't say, such as `access private, note.read → signed`, `No backend code serves it yet` or `"required" names fields it doesn't define: status`.
- `where`: the places to update, such as `backend/src/modules/demo/models/ (the stored record)`, `docs/api/demo.md`, `module-packs/demo/DATA_MODEL.md` or the Profiles screen.

Resources, actions, their settings (`scoped`, `sharingModel`, `recordFields`, `protectedFields`, `trackedFields`), routes and their access, schema definitions and their fields are compared. Custom objects aren't: they need no code. A manifest without a `schema` compares no schema. An import that changes nothing records nothing, and `change` is `null`.

The import's response carries the record as `change`, and `changeLog`: where a server with `MODULE_FILE_SYNC_ENABLED` wrote the list, as `{ "path": "manifests/changes/demo.md", "outcome": "written" }` (`written`, `removed`, `unchanged` or `failed`; `null` on a server that writes no files). That file lists every pending change of the module, oldest first, and is rewritten from the database each time, so commit it with the manifest and edit it only by marking changes done. Removing the module deletes it. The Modules screen shows the same list under "Changes to build".

### `GET /modules/:key/changes`

**Access:** `private`, needs `module.read`

**Query:** `status` (`pending` or `done`; both when left out), `page`, `pageSize` (up to 100, 25 by default)

**Returns:** `changes`, newest first, each with `id`, `module`, `moduleName`, `source` (`manifest` or `schema`), `versionBefore` (`null` for a new module), `versionAfter`, `items`, `changedAt`, `changedBy`, `changedByName`, `status`, and `doneAt`, `doneBy`, `doneByName` once done; plus `total`, `pending` (the module's pending count whatever the filter), `page` and `pageSize`.

**Errors:** `404 unknown_module`, `422 validation_failed`

### `POST /modules/:key/changes/:changeId/done`

**Access:** `private`, needs `module.update`

Marks one change as built: the code, docs and frontends match it. Recorded in the activity log as `module.changeDone`.

**Returns:** `change`, now `done`, and `changeLog`, the rewritten `manifests/changes/<key>.md` (`removed` once nothing is pending).

**Errors:** `404 unknown_change`, `409 already_done`

## Profiles

Profiles are org-wide. Each one has `grants` keyed by module, and a person holds at most one, given with [`PUT /users/:id/profile`](#put-usersidprofile).

A grant can also hold `fieldAccess`, such as `{ "salary": { "actions": ["read"], "scope": "team", "fieldAccess": { "amount": "read" } } }`. It can name any field the resource controls: those in its manifest's `recordFields` and `protectedFields`, or a custom object's fields. A resource's optional `fieldLabels` gives some of those fields the name the Profiles screen shows, such as `{ "lines": "Salary per person" }`; it changes no access, and a label for a field the resource doesn't control is refused. Levels are `hidden`, `read`, `create` and `edit`, from narrowest to widest. `read` shows the field, `create` also lets the person set it on a new record but not change it afterwards, and `edit` lets them set it at any time. A field the grant doesn't name follows its actions (`update` gives edit, `create` gives create, `read` gives read), except a protected field, which stays hidden. Profiles return only the levels they state in `fieldAccess`. A protected field nobody gave access to is left out of responses and history, and a write the level doesn't allow is refused (`403 field_not_editable`). Nobody can give field access beyond their own. Someone other than a super admin can only put in a profile what they hold themselves, at no wider reach, and can't change or remove a profile that goes beyond their own access (`403 beyond_own_access`). Only a super admin can use `"*"` for a module.

A profile in these responses has `id`, `name`, `description`, `grants`, `holders` (how many people hold it) and `modules`, each with `key`, `name`, `loaded`, `grants` (short labels) and `permissions`.

### `GET /access-profiles`

**Access:** `private`, needs `accessProfile.read`

**Returns:** `profiles`

### `POST /access-profiles`

**Access:** `private`, needs `accessProfile.create`

**Body:** `name`, `grants`, and optionally `description`. `grants` is a map such as `{ "hr": { "salary": { "actions": ["read"], "scope": "own" } } }`, and each module must be loaded.

**Returns:** `201` with the profile.

**Errors:** `403 beyond_own_access`, `422 validation_failed`

### `PATCH /access-profiles/:id`

**Access:** `private`, needs `accessProfile.update`

**Body:** any of `name`, `description` (`null` clears it), `grants` (replaces every module's grants)

**Returns:** the updated profile. It applies to everyone holding it on their next request.

**Errors:** `403 beyond_own_access`, `404 unknown_profile`, `422 validation_failed`

### `DELETE /access-profiles/:id`

**Access:** `private`, needs `accessProfile.delete`

**Returns:** `removed`, `id`

**Errors:** `403 beyond_own_access`, `404 unknown_profile`, `409 profile_in_use`

## Module resources

### `PUT /modules/:key/resources/:resource`

**Access:** `private`, needs `module.create` to add a resource or `module.update` to change one. Removing an action a profile or API uses is refused, unless you're a super admin: profiles then lose that action, and an API needing it can be used only by super admins.

**Body:** `label`, `actions` (`read`, `create`, `update`, `delete`, `approve`), and optionally `scoped`

**Returns:** `201` for a new resource or `200` for a change, with `created`, `module`, `resource`.

**Errors:** `404 unknown_module`

### `PUT /modules/:key/route-access`

**Access:** `private`, needs `module.update`, and only a super admin may (`403 super_admin_only` otherwise).

Changes who may call one API, from the next request on. Saved on the module, kept when its manifest is imported again, and written to the activity log as `module.routeAccessChanged`. Setting the rule the API was built with removes the change.

**Body:** `method`, `path` (as the API is called, with the module's base path, such as `/hr/salaries`), `access` (`signed` or `private`), and `permission` (a `resource.action` of the module) to make it private. Without one, a private API keeps the permission it was built with.

- An API built `public` stays public: it works before anyone signs in.
- Any other API can be `signed` or `private` but not `public`, because its code needs to know who is calling.
- A built-private API made `signed` keeps the scope of anyone holding its permission; anyone else reaches only their own records (`own`).

**Returns:** `route`, the API as `GET /modules` lists it.

**Errors:** `404 unknown_module`, `404 unknown_route`, `422 access_not_allowed`, `422 validation_failed`

### `DELETE /modules/:key/resources/:resource`

**Access:** `private`, needs `module.delete`. Refused while a profile or API uses the resource, unless you're a super admin. A custom object is refused while it has records, including any in the recycle bin, as with [`DELETE /modules/:key/objects/:object`](#delete-moduleskeyobjectsobject).

**Returns:** `removed`, `module`, `resource`

**Errors:** `404 unknown_resource`, `409 object_in_use`

## Custom objects

An admin can define an object in any module, such as Trainings in HR, with its own fields. It becomes a resource of that module with the actions `read`, `create`, `update`, `delete` and `share`, so profiles give access to it like any other resource, with a scope, field access and sharing. Records are owned by whoever creates them and kept in `custom_records`. Re-importing a module's manifest keeps its custom objects.

A field has `key`, `label`, `type` (`text`, `number`, `date`, `boolean` or `select`), and optionally `required`, `options` (for `select`), `tracked` (changes go in the history) and `protected` (hidden unless field access is given).

### `POST /modules/:key/objects`

**Access:** `private`, needs `module.create`

**Body:** `key`, `label`, `fields`, and optionally `sharingModel` (default `private`)

**Returns:** `201` with `module` and `object`, the new resource.

**Errors:** `409 object_exists`, `422 validation_failed`

### `PUT /modules/:key/objects/:object`

**Access:** `private`, needs `module.update`

**Body:** `label`, `fields`, and optionally `sharingModel`. Values of removed fields stay in records but are no longer shown.

**Errors:** `404 unknown_object`, `422 validation_failed`

### `DELETE /modules/:key/objects/:object`

**Access:** `private`, needs `module.delete`. Refused while any record, even a deleted one, or a profile uses it.

**Errors:** `404 unknown_object`, `409 object_in_use`

### `GET /records`

**Access:** `signed`

**Returns:** `objects`, the custom objects you can read, each with `module`, `moduleName`, `key`, `label`, `fields` (leaving out protected ones you can't see, each with `editable`, and `creatable` for whether it can be set on a new record) and `can` (`create`, `update`, `delete`).

### Records: `/records/:module/:object`

All are `signed`: the module comes from the path, so the service checks the permission in that module, as the middleware does for built routes. `unknown_module`, `unknown_object` and `unknown_record` answer `404`.

| Route | Needs | What it does |
|---|---|---|
| `GET /records/:module/:object` | `<object>.read` | Lists the records your scope reaches, plus those shared with you. `deleted=true` lists the recycle bin, which needs `<object>.delete`. |
| `POST /records/:module/:object` | `<object>.create` | Adds a record from `values`, checked against the fields. You own it. |
| `GET /records/:module/:object/:id` | `<object>.read` | Returns one record. |
| `PATCH /records/:module/:object/:id` | `<object>.update` | Changes `values`, with optional `version`. `null` clears a field that isn't required. |
| `DELETE`, `POST .../:id/restore` | `<object>.delete` | Moves a record to the recycle bin, or back. |
| `GET .../:id/history` | `<object>.read` | What changed, who changed it and when. |
| `GET`, `POST .../:id/shares`, `DELETE .../:id/shares/:shareId` | `<object>.read` | List, add and remove shares, as for salaries. |

A record has `id`, `module`, `object`, `ownerId`, `values`, `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, and `deletedAt` and `deletedBy` while it's in the recycle bin.

## Activity log

### `GET /audit`

**Access:** `private`, needs `audit.read`

**Query:** `page`, `pageSize`, `actionPrefix` (such as `auth.`)

**Returns:** `total`, `entries`, newest first.

## Clients

Companies TwinTrack works for, shared by every module: projects are done for them, and invoices and receipts are billed to them. They aren't scoped, so `client.read` sees them all. A client is made inactive, never deleted. Changes to `name`, `initials`, `contactEmail`, `contactPhone`, `address` and `status` are kept in history, and every field can be controlled with field access.

A client has `id`, `name`, `initials`, `contactEmail`, `contactPhone`, `address`, `notes`, `status`, `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`.

### `GET /clients`

**Access:** `private`, needs `client.read`

**Query:** `page`, `pageSize`, `search` (name, initials or email, leaving out any of them the caller's field access hides), `status` (`active` or `inactive`)

**Returns:** `clients`, `total`

### `POST /clients`

**Access:** `private`, needs `client.create`

**Body:** `name`, and optionally `initials` (1 to 8 letters or digits, stored in capitals, unique: used in invoice numbers), `contactEmail`, `contactPhone`, `address`, `notes`

**Returns:** `201` with the client.

**Errors:** `409 initials_taken`, `422 validation_failed`

### `GET /clients/:id`

**Access:** `private`, needs `client.read`

**Errors:** `404 unknown_client`

### `PATCH /clients/:id`

**Access:** `private`, needs `client.update`

**Body:** any of the fields above, with `null` to clear an optional one, and `version` to refuse an edit made from an old copy.

**Errors:** `404 unknown_client`, `409 initials_taken`, `409 version_conflict`

### `PATCH /clients/:id/status`

**Access:** `private`, needs `client.update`

**Body:** `status`, and optionally `version`

### `GET /clients/:id/history`

**Access:** `private`, needs `client.read`

**Query:** `page`, `pageSize`

**Returns:** `entries`, newest first, with fields the caller may not see left out.

## API tokens, connected apps and MCP

Tools such as Claude Code and claude.ai connectors reach TwinTrack through the MCP endpoint. Each acts as one person, with exactly their access, read on every call.

The Master resource `apiToken` (scoped) controls this:

| Action | Allows |
|---|---|
| `apiToken.create` | Making a personal token, and approving an app on the consent page. Declining never needs it. |
| `apiToken.read` | Seeing the tokens and connected apps of the people the scope reaches (`/api-tokens`, `/connected-apps`). |
| `apiToken.delete` | Revoking those tokens and disconnecting those apps. |

Everyone can always list and revoke their own tokens and apps, so nobody is stuck with a credential they can't stop. Super admins' tokens and apps are out of reach for everyone except super admins.

### `GET /me/api-tokens`, `POST /me/api-tokens`, `POST /me/api-tokens/:id/revoke`

**Access:** listing and revoking are `signed`, your own tokens only. Making one is `private` and needs `apiToken.create`, and is refused while signed in as someone else.

**POST body:** `name`, and optionally `expiresInDays` (1 to 365; missing means never)

**Returns:** POST `201` with the token's details and `token` (`tt_pat_…`), shown this once. Only a hash is stored. Lists never include it.

**Errors:** `409 too_many_tokens` (ten active at most), `404 unknown_token`, `403 forbidden`, `403 impersonating`

### `GET /api-tokens`

**Access:** `private`, needs `apiToken.read`. The scope decides whose tokens: `own`, `team` or `all`.

**Query:** `page`, `pageSize`, `userId` (optional: one person)

**Returns:** `total`, `tokens`, newest first, each with the fields above plus `owner` (`id`, `name`). Never the token itself.

### `POST /api-tokens/:id/revoke`

**Access:** `private`, needs `apiToken.delete`, scoped

**Returns:** the token, with `revokedAt`. Revoking one already revoked returns it unchanged.

**Errors:** `404 unknown_token`, also for a token out of reach

### `GET /me/connected-apps`, `POST /me/connected-apps/:id/revoke`

**Access:** `signed`, your own apps only

**Returns:** `apps`, each with `id`, `clientName`, `createdAt`, `lastUsedAt`. Disconnecting stops its tokens at once.

### `GET /connected-apps`

**Access:** `private`, needs `apiToken.read`, scoped

**Query:** `page`, `pageSize`, `userId` (optional)

**Returns:** `total`, `apps`, each with `owner` (`id`, `name`) as well.

### `POST /connected-apps/:id/revoke`

**Access:** `private`, needs `apiToken.delete`, scoped

**Returns:** `id`, `revoked: true`

**Errors:** `404 unknown_connection`, also for an app out of reach

### `GET /oauth/requests/:id`, `POST /oauth/requests/:id/decision`

**Access:** `signed`. For the portal's consent page at `/oauth/consent?request=…`.

**Decision body:** `approve` (`true` or `false`)

**Returns:** GET `clientName` (the app's own claim), `redirectHost` (where the browser goes next, which it can't fake), `expiresAt`. POST `redirectUrl`, back to the app with a code or `error=access_denied`.

**Errors:** `404 unknown_request`, `409 request_answered`, `409 request_expired`, `403 forbidden` (approving without `apiToken.create`), `403 impersonating`

### OAuth protocol endpoints

`POST /oauth/register` (RFC 7591), `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`, and the discovery documents `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. These come from the MCP SDK and are the one allowed exception to registering routes directly (see `modules/master/oauth/oauthProtocol.ts`). Authorization needs PKCE (S256). Access tokens (`tt_oat_…`) last an hour and refresh tokens 30 days; refreshing replaces both. A code used twice revokes what it gave. Client secrets are stored encrypted with `ENCRYPTION_KEY`.

### `POST /mcp`

**Access:** `public` in the access model, because it checks its own bearer token: a personal API token or an OAuth access token, never a session. Any origin may call. 120 calls a minute per address.

**Body:** an MCP JSON-RPC message. Clients must accept `application/json, text/event-stream`. The endpoint is stateless, so `GET` and `DELETE /mcp` answer `405`.

**Tools from Master:** `whoami`, `my_permissions`, `find_colleagues`, `list_clients` (needs `client.read`). Each module adds its own through `MasterExtensions.mcpToolProviders`, checking permissions the way its routes do.

**Errors:** `401 no_token` or `401 invalid_token`, with a `WWW-Authenticate` header naming the OAuth metadata, which is how an app knows to start signing in.
