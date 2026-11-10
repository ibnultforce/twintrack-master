# Master API

Sign-in, people, access and module administration. Routes have no path prefix. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## How access works

Each person has one **profile**, which sets their baseline permissions in every module, and any number of **permission sets**, named bundles that each belong to one module and add to the profile. The widest scope wins. No profiles or permission sets ship with the product, so a super admin, who holds every permission, creates the others. The permissions below are what each route needs.

## Health

### `GET /health`

**Access:** `public`

**Returns:** `200` with `{ "status": "ok", "database": "connected" }`, or `503` with `"unavailable"` and `"disconnected"`.

## Sign-in

Login, refresh and logout refuse a missing or unlisted `Origin` header with `403 origin_not_allowed`.

### `POST /auth/login`

**Access:** `public`

**Body:** `email`, `password`

**Returns:** `accessToken`, `expiresIn`, `mustChangePassword`, and sets the refresh cookie.

**Errors:** `401 invalid_credentials`, `403 account_inactive`, `429 too_many_attempts`

### `POST /auth/refresh`

**Access:** `public`, using the refresh cookie

**Returns:** `accessToken`, `expiresIn`, and usually a new cookie.

**Errors:** `401 no_session`, `401 session_revoked`, `401 session_expired`, `401 account_inactive`

### `POST /auth/logout`

**Access:** `public`, using the refresh cookie if there is one

**Returns:** `{ "signedOut": true }`, and clears the cookie.

## My account

### `GET /auth/me`

**Access:** `signed`. Works with a temporary password.

**Returns:** `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `superAdmin`, `mustChangePassword`, `orgRoleId`, `manager`

### `PATCH /auth/me`

**Access:** `signed`

**Body:** `name`

**Returns:** the updated profile.

### `POST /auth/change-password`

**Access:** `signed`. Works with a temporary password.

**Body:** `currentPassword`, `newPassword` (12 to 256 characters, different from the current one)

**Returns:** `{ "passwordChanged": true }`, and ends the person's other sessions.

**Errors:** `403 wrong_current_password`, `429 too_many_attempts`

### `GET /me/modules`

**Access:** `signed`

**Returns:** `modules`, the ones this person can open, each with `key`, `name`, `description`, `frontendUrl`, `profileName`, `permissionSets`.

### `GET /me/permissions/:module`

**Access:** `signed`

**Returns:** `module`, `hasAccess`, `profile`, `profileName`, `permissions` (permission to scope), `permissionSets` (the keys of the sets that count here), `fieldAccess` (protected fields, as `resource.field` to `read` or `edit`)

**Errors:** `404 unknown_module`

## People

A "person" in these responses has `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `status`, `managerId`, `orgRoleId`, `profileId`, `superAdmin`, `mustChangePassword` and `permissionSets` (module key to the keys of the sets held there).

Temporary passwords are returned once and never stored in plain text.

### `GET /users`

**Access:** `private`, needs `user.read`

**Query:** `page`, `pageSize`, `search` (name, email or title), `status` (`active` or `inactive`)

**Returns:** `users`, `total`

### `POST /users`

**Access:** `private`, needs `user.create`

**Body:** `name`, `email`, `orgRoleId` (everyone has a place in the [org tree](#org-roles)), and optionally `title`, `department`, `team`, `contract` (`permanent`, `intern`, `contractor`), `managerId`, `profileId`

**Returns:** `201` with `user`, `temporaryPassword`

**Errors:** `409 email_taken`, `422 validation_failed` when `orgRoleId` is missing or no such org role exists

### `GET /users/access-options`

**Access:** `signed`. Needs `user.read`, or the right to change access in at least one module.

**Returns:** `modules`, each with `key`, `name`, `permissionSets` (each with `key`, `name`, `description`, `grants` and `permissions`), `canChange`.

### `GET /users/:id`

**Access:** `private`, needs `user.read`

**Returns:** the person.

**Errors:** `404 unknown_user`

### `PATCH /users/:id`

**Access:** `private`, needs `user.update`

**Body:** any of `name`, `email`, `title`, `department`, `team`, `contract`, `managerId`, `orgRoleId`, `profileId`. `null` clears an optional field, and `"profileId": null` takes the profile away. `orgRoleId` can be changed but not cleared.

**Returns:** the updated person.

**Errors:** `403 super_admin_protected`, `403 own_account` when someone other than a super admin changes their own `orgRoleId` or `profileId`, `404 unknown_user`, `409 email_taken`, `422 validation_failed` for a profile or org role that doesn't exist

### `PATCH /users/:id/status`

**Access:** `private`, needs `user.update`

**Body:** `status` (`active` or `inactive`). Deactivating signs the person out everywhere.

**Returns:** the updated person.

**Errors:** `403 own_account`, `403 super_admin_protected`, `404 unknown_user`

### `POST /users/:id/reset-password`

**Access:** `private`, needs `user.update`

**Returns:** `user`, `temporaryPassword`, and signs the person out everywhere.

**Errors:** `403 own_account`, `403 super_admin_protected`, `404 unknown_user`

## Changing someone's access

A person's profile is changed with `PATCH /users/:id` and `profileId`, which needs `user.update`. Permission sets are given one module at a time with the route below. It and `GET /modules/:key/people` are `signed`, because a module admin may have no Master access. To change permission sets in a module, the caller needs one of:

| Right | Reaches |
|---|---|
| `user.update` | Every module |
| `hrAccess.update` | HR |
| `access.update` in that module, such as HR Admin in HR | That module |

Only a super admin can change a super admin's access or their own.

### `PUT /users/:id/permission-sets`

**Access:** `signed`, and the rights above

**Body:** `module`, `permissionSets` (the full new list of keys, `[]` takes them all away), and `reason` when giving a new one

**Returns:** the updated person.

**Errors:** `403 module_access_only`, `403 own_access`, `404 unknown_user`, `404 unknown_module`, `409 super_admin`, `422 unknown_permission_set`, `422 validation_failed` when a new set has no reason

### `GET /modules/:key/people`

**Access:** `signed`. Needs `user.read`, or the right to change access in that module.

**Returns:** `module`, `people` with access through their profile or a permission set, each with `id`, `name`, `email`, `status`, `profile` (`id` and `name`, or `null`), `profilePermissions` and `permissionSets`.

**Errors:** `404 unknown_module`

### `GET /modules/:key/addable-people`

**Access:** `signed`, and the right to change access in that module

**Query:** `page`, `pageSize`, `search` (name, email or title)

**Returns:** `total`, `people`, each with `id`, `name`, `email`, `title`. Lists active people with no access to the module yet, leaving out super admins and the caller.

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

**Returns:** `modules`, each with `key`, `name`, `version`, `description`, `core`, `frontendUrl`, `resources`, `apis`, and `usedBy`, the APIs, permission sets and profiles relying on each permission.

### `POST /modules/import`

**Access:** `private`, needs `module.create`

**Body:** `password` (your own, to confirm it's you) and `manifest` (the whole module manifest)

**Returns:** `201` for a new module or `200` for a replacement, with `key`, `version`, `created`, `orphanedPermissionSets` (people holding a set the new manifest no longer has).

Unless you're a super admin, the manifest can't add or change permission sets. Replacing a module whose permissions were edited also needs `module.update` and that module's `permissionSet.update`. A manifest with the old `roles` or `grantable` fields is refused.

**Errors:** `403 wrong_current_password`, `403 core_module`, `403 beyond_own_access`, `409 permissions_edited`, `429 too_many_attempts`

### `GET /modules/:key/export`

**Access:** `private`, needs `module.read`

**Returns:** the module's manifest as it stands, including permission sets and edits made in the app. It can be sent back as `manifest` to `POST /modules/import`.

**Errors:** `404 unknown_module`

### `DELETE /modules/:key`

**Access:** `private`, needs `module.delete`

**Returns:** `removed`, `key`, `affectedUsers`

**Errors:** `403 core_module`, `404 unknown_module`, `409 permissions_edited`

## Profiles

Profiles are org-wide. Each one has `grants` keyed by module, in the same form as a permission set's grants, and a person holds at most one.

A grant can also hold `fieldAccess`, such as `{ "salary": { "actions": ["read"], "scope": "team", "fieldAccess": { "amount": "read" } } }`. It names the resource's protected fields, listed as `protectedFields` in the manifest, and gives `read` or `edit`. A protected field nobody gave access to is left out of responses and history, and can't be written (`403 field_not_editable`). The widest access from the profile and permission sets counts, and nobody can give field access beyond their own. Someone other than a super admin can only put in a profile what they hold themselves, at no wider reach, and can't change or remove a profile that goes beyond their own access (`403 beyond_own_access`). Only a super admin can use `"*"` for a module.

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

## Permission sets

Each module has its own `permissionSet.read`, `permissionSet.create`, `permissionSet.update` and `permissionSet.delete`, which are separate and work in that module only. Someone can build or edit sets using permissions they hold there and no wider reach, and they can't change a set stronger than their own access. Going beyond that returns `403 beyond_own_access`. Only a super admin can use `"*"`. Resource routes need `module.update` in Master. Edits are saved in the database, and `npm run seed` replaces them with the manifest files.

### `GET /permission-sets`

**Access:** `signed`, and any permission set permission in at least one module

**Returns:** `modules`, each with `key`, `name`, `resources`, `apis` (each permission and the APIs it opens), `can` (`create`, `update`, `delete`), `assignable` (what you may put in a set) and `permissionSets`.

### `POST /permission-sets/:module`

**Access:** `signed`, and `permissionSet.create` in that module

**Body:** `key`, `name`, `grants`, and optionally `description`. `grants` is `"*"`, or a map such as `{ "salary": { "actions": ["read"], "scope": "team" } }`.

**Returns:** `201` with the permission set.

**Errors:** `404 unknown_module`

### `PATCH /permission-sets/:module/:key`

**Access:** `signed`, and `permissionSet.update` in that module

**Body:** any of `name`, `description`, `grants`

**Returns:** the updated permission set.

**Errors:** `404 unknown_module`, `404 unknown_permission_set`

### `DELETE /permission-sets/:module/:key`

**Access:** `signed`, and `permissionSet.delete` in that module

**Returns:** `removed`, `module`, `key`

**Errors:** `404 unknown_permission_set`, `409 permission_set_in_use`

## Module resources

### `PUT /modules/:key/resources/:resource`

**Access:** `private`, needs `module.create` to add a resource or `module.update` to change one. Removing an action a permission set, profile or API uses is refused, unless you're a super admin: sets and profiles then lose that action, and an API needing it can be used only by super admins.

**Body:** `label`, `actions` (`read`, `create`, `update`, `delete`, `approve`), and optionally `scoped`

**Returns:** `201` for a new resource or `200` for a change, with `created`, `module`, `resource`.

**Errors:** `404 unknown_module`

### `DELETE /modules/:key/resources/:resource`

**Access:** `private`, needs `module.delete`. Refused while a permission set, profile or API uses the resource, unless you're a super admin.

**Returns:** `removed`, `module`, `resource`

**Errors:** `404 unknown_resource`

## Custom objects

An admin can define an object in any module, such as Trainings in HR, with its own fields. It becomes a resource of that module with the actions `read`, `create`, `update`, `delete` and `share`, so profiles and permission sets give access to it like any other resource, with a scope, field access and sharing. Records are owned by whoever creates them and kept in `custom_records`. Re-importing a module's manifest keeps its custom objects.

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

**Access:** `private`, needs `module.delete`. Refused while any record, even a deleted one, or a permission set uses it.

**Errors:** `404 unknown_object`, `409 object_in_use`

### `GET /records`

**Access:** `signed`

**Returns:** `objects`, the custom objects you can read, each with `module`, `moduleName`, `key`, `label`, `fields` (leaving out protected ones you can't see, each with `editable`) and `can` (`create`, `update`, `delete`).

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
