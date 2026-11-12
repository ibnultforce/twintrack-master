# Master API

Sign-in, people, access and module administration. Routes have no path prefix. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## How access works

Each person holds one **profile**, and it is where all of their permissions in every module come from. No profiles ship with the product, so a super admin, who holds every permission, creates them and gives them out. The permissions below are what each route needs.

## Health

### `GET /health`

**Access:** `public`

**Returns:** `200` with `{ "status": "ok", "database": "connected" }`, or `503` with `"unavailable"` and `"disconnected"`.

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

**Returns:** `module`, `hasAccess`, `profile`, `profileName`, `permissions` (permission to scope), `apis` (each permission held, to the APIs it opens as `METHOD /path`, for trying them from Your permissions), `guides` (for each of those APIs, its `purpose`, `input` and `examples`: sample requests taken from the test page's scenarios, each with `title`, `outcome` (`accepted` or `refused`), `expectedStatus`, `expectedCode`, `sentBy` (who sends it in the example data), `parameters`, `query`, `body`, `sendFirst` (requests the example sends before it), `needs` (values an earlier request makes, such as `projectId`) and `changesData`. Scenarios about a missing or forged token are left out, since Try sends your own), `fieldAccess` (protected fields, as `resource.field` to `hidden`, `read`, `create` or `edit`, for every controlled field, including levels that follow the actions)

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

**Errors:** `403 super_admin_protected`, `403 own_account` when someone other than a super admin changes their own `orgRoleId`, `404 unknown_user`, `409 email_taken`, `409 employee_number_taken`, `422 validation_failed` for an org role that doesn't exist or another field such as `profileId`

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

**Access:** `signed`, super admins only, and only with `IMPERSONATION_ENABLED=true`, which production refuses.

**Returns:** `accessToken`, `expiresIn`, `user` (`id`, `name`). A session as that person that lasts one access token and can't be refreshed, so the super admin's own session is untouched. Logged as `auth.impersonation_started`. While it lasts, changing their name or password, making API tokens and approving OAuth apps are refused with `403 impersonating`.

**Errors:** `403 forbidden`, `403 super_admin_protected`, `404 impersonation_disabled`, `404 unknown_user`, `409 own_account`, `409 account_inactive`, `409 already_impersonating`

### `POST /auth/stop-impersonating`

**Access:** `signed`, as the person being impersonated

**Returns:** `accessToken`, `expiresIn` for the super admin's own session. Ends the impersonation session.

**Errors:** `409 not_impersonating`, `401 session_revoked` when the super admin's own session has ended too

## Changing someone's access

A person's access comes from their one profile, given with the route below. It needs the Master permission `userProfile.update`, whose scope decides whose profile someone may change: `team` reaches their direct reports and everyone in the org roles below theirs, and `all` reaches everyone. The profile being given, and the one it replaces, must both stay within the giver's own access in every module.

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

### `GET /modules/:key/addable-people`

**Access:** `private`, needs `userProfile.update`

**Query:** `page`, `pageSize`, `search` (name, email or title)

**Returns:** `total`, `people`, each with `id`, `name`, `email`, `title` and `profileId` (the profile they hold now). Lists active people your scope reaches whose profile doesn't cover the module yet, leaving out super admins and the caller.

**Errors:** `404 unknown_module`

## Org roles

The organisation tree. Every org role has one parent, except the single root. A person in a role sees records owned by people in the roles below it, at any depth, but only with their own permissions: the tree passes on visibility, never permissions. People who share a role are peers and don't see each other's records through the tree.

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

**Returns:** `modules`, each with `key`, `name`, `version`, `description`, `core`, `frontendUrl`, `resources`, `apis`, and `usedBy`, the APIs and profiles relying on each permission.

### `POST /modules/import`

**Access:** `private`, needs `module.create`

**Body:** `password` (your own, to confirm it's you) and `manifest` (the whole module manifest)

**Returns:** `201` for a new module or `200` for a replacement, with `key`, `version`, `created`.

Replacing a module whose resources were edited in the app also needs `module.update`, unless you're a super admin. A manifest with the old `roles`, `grantable`, `managesAccessOf` or `permissionSets` fields is refused.

**Errors:** `403 wrong_current_password`, `403 core_module`, `409 permissions_edited`, `429 too_many_attempts`

### `GET /modules/:key/export`

**Access:** `private`, needs `module.read`

**Returns:** the module's manifest as it stands, including resources and custom objects changed in the app. It can be sent back as `manifest` to `POST /modules/import`.

**Errors:** `404 unknown_module`

### `DELETE /modules/:key`

**Access:** `private`, needs `module.delete`

**Returns:** `removed`, `key`, `affectedUsers` (people whose profile covers the module). Profiles keep their part for it, which gives nothing until it's imported again.

**Errors:** `403 core_module`, `404 unknown_module`, `409 permissions_edited`

## Profiles

Profiles are org-wide. Each one has `grants` keyed by module, and a person holds at most one, given with [`PUT /users/:id/profile`](#put-usersidprofile).

A grant can also hold `fieldAccess`, such as `{ "salary": { "actions": ["read"], "scope": "team", "fieldAccess": { "amount": "read" } } }`. It can name any field the resource controls: those in its manifest's `recordFields` and `protectedFields`, or a custom object's fields. Levels are `hidden`, `read`, `create` and `edit`, from narrowest to widest. `read` shows the field, `create` also lets the person set it on a new record but not change it afterwards, and `edit` lets them set it at any time. A field the grant doesn't name follows its actions (`update` gives edit, `create` gives create, `read` gives read), except a protected field, which stays hidden. Profiles return only the levels they state in `fieldAccess`. A protected field nobody gave access to is left out of responses and history, and a write the level doesn't allow is refused (`403 field_not_editable`). Nobody can give field access beyond their own. Someone other than a super admin can only put in a profile what they hold themselves, at no wider reach, and can't change or remove a profile that goes beyond their own access (`403 beyond_own_access`). Only a super admin can use `"*"` for a module.

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

### `DELETE /modules/:key/resources/:resource`

**Access:** `private`, needs `module.delete`. Refused while a profile or API uses the resource, unless you're a super admin.

**Returns:** `removed`, `module`, `resource`

**Errors:** `404 unknown_resource`

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

**Query:** `page`, `pageSize`, `search` (name, initials or email), `status` (`active` or `inactive`)

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
