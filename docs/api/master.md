# Master API

Sign-in, people, access and module administration. Routes have no path prefix. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Roles

No roles ship with the product. A super admin holds every permission and creates the others, and the permissions below are what each route needs.

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

**Returns:** `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `superAdmin`, `mustChangePassword`, `manager`

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

**Returns:** `modules`, the ones this person can open, each with `key`, `name`, `description`, `frontendUrl`, `roleName`.

### `GET /me/permissions/:module`

**Access:** `signed`

**Returns:** `module`, `hasAccess`, `role`, `roleName`, `permissions` (permission to scope), `specialPrivileges`

**Errors:** `404 unknown_module`

## People

A "person" in these responses has `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `status`, `managerId`, `superAdmin`, `mustChangePassword`, `assignments`, `privileges` and `superAdminGrants`.

Temporary passwords are returned once and never stored in plain text.

### `GET /users`

**Access:** `private`, needs `user.read`

**Query:** `page`, `pageSize`, `search` (name, email or title), `status` (`active` or `inactive`)

**Returns:** `users`, `total`

### `POST /users`

**Access:** `private`, needs `user.create`

**Body:** `name`, `email`, and optionally `title`, `department`, `team`, `contract` (`permanent`, `intern`, `contractor`), `managerId`

**Returns:** `201` with `user`, `temporaryPassword`

**Errors:** `409 email_taken`

### `GET /users/access-options`

**Access:** `signed`. Needs `user.read`, or the right to change access in at least one module.

**Returns:** `modules`, each with `key`, `name`, `roles`, `grantable`, `canChange`.

### `GET /users/:id`

**Access:** `private`, needs `user.read`

**Returns:** the person.

**Errors:** `404 unknown_user`

### `PATCH /users/:id`

**Access:** `private`, needs `user.update`

**Body:** any of `name`, `email`, `title`, `department`, `team`, `contract`, `managerId`. `null` clears an optional field.

**Returns:** the updated person.

**Errors:** `403 super_admin_protected`, `404 unknown_user`, `409 email_taken`

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

These routes and `GET /modules/:key/people` are `signed`, because a module admin may have no Master role. To change access in a module, the caller needs one of:

| Right | Reaches |
|---|---|
| `user.update` | Every module |
| `hrAccess.update` | HR |
| `employeeAccess.update` | Employee |
| `access.update` in that module, such as HR Admin in HR | That module |

Only a super admin can change a super admin's access or their own, or give a permission the module doesn't mark `grantable`.

### `PATCH /users/:id/roles`

**Access:** `signed`, and the rights above

**Body:** `module`, `role` (`null` removes it)

**Returns:** the updated person.

**Errors:** `403 hr_roles_only`, `403 own_access`, `404 unknown_user`, `404 unknown_module`, `409 super_admin`, `422 unknown_role`

### `PUT /users/:id/privileges`

**Access:** `signed`, and the rights above

**Body:** `module`, `permissions` (the full new list), and `reason` when adding any

**Returns:** the updated person.

**Errors:** `403 hr_roles_only`, `403 own_access`, `404 unknown_user`, `404 unknown_module`, `409 super_admin`, `422 not_grantable`

### `GET /modules/:key/people`

**Access:** `signed`. Needs `user.read`, or the right to change access in that module.

**Returns:** `module`, `people`, each with `id`, `name`, `email`, `status`, `role`, `privileges`, `superAdminGrants`.

**Errors:** `404 unknown_module`

### `GET /modules/:key/addable-people`

**Access:** `signed`, and the right to change access in that module

**Query:** `page`, `pageSize`, `search` (name, email or title)

**Returns:** `total`, `people`, each with `id`, `name`, `email`, `title`. Lists active people with no access to the module yet, leaving out super admins and the caller.

**Errors:** `404 unknown_module`

## Modules

Master can't be replaced or removed through the API.

### `GET /modules`

**Access:** `private`, needs `module.read`

**Returns:** `modules`, each with `key`, `name`, `version`, `description`, `core`, `frontendUrl`.

### `POST /modules/import`

**Access:** `private`, needs `module.create`

**Body:** `password` (your own, to confirm it's you) and `manifest` (the whole module manifest)

**Returns:** `201` for a new module or `200` for a replacement, with `key`, `version`, `created`, `orphanedAssignments`.

Unless you're a super admin, the manifest can't add or change roles or widen what's `grantable`, so a new module must have neither. Replacing a module whose permissions were edited also needs `module.update` and that module's `role.update`.

**Errors:** `403 wrong_current_password`, `403 core_module`, `403 beyond_own_access`, `409 permissions_edited`, `429 too_many_attempts`

### `GET /modules/:key/export`

**Access:** `private`, needs `module.read`

**Returns:** the module's manifest as it stands, including roles and edits made in the app. It can be sent back as `manifest` to `POST /modules/import`.

**Errors:** `404 unknown_module`

### `DELETE /modules/:key`

**Access:** `private`, needs `module.delete`

**Returns:** `removed`, `key`, `affectedUsers`

**Errors:** `403 core_module`, `404 unknown_module`, `409 permissions_edited`

## Roles and permissions

Each module has its own `role.update`. Holding it lets someone create and edit roles in that module only, using permissions they hold there and no wider reach, and they can't change a role stronger than their own access. Going beyond that returns `403 beyond_own_access`. Only a super admin can use `"*"`. Resource routes need `module.update` in Master. Edits are saved in the database, and `npm run seed` replaces them with the manifest files.

### `GET /roles`

**Access:** `private`, needs `role.read`

**Returns:** `roles`, the role templates of every loaded module.

### `GET /roles/manageable`

**Access:** `signed`, and `role.update` in at least one module

**Returns:** `modules`, each with `key`, `name`, `resources`, `apis` (each permission and the APIs it opens), `assignable` (what you may put in a role) and `roles`.

### `POST /roles/:module`

**Access:** `signed`, and `role.update` in that module

**Body:** `key`, `name`, `grants`, and optionally `description`. `grants` is `"*"`, or a map such as `{ "salary": { "actions": ["read"], "scope": "team" } }`.

**Returns:** `201` with the role.

**Errors:** `404 unknown_module`

### `PATCH /roles/:module/:key`

**Access:** `signed`, and `role.update` in that module

**Body:** any of `name`, `description`, `grants`

**Returns:** the updated role.

**Errors:** `404 unknown_module`, `404 unknown_role`

### `DELETE /roles/:module/:key`

**Access:** `signed`, and `role.update` in that module

**Returns:** `removed`, `module`, `key`

**Errors:** `404 unknown_role`, `409 role_in_use`

### `PUT /modules/:key/resources/:resource`

**Access:** `private`, needs `module.update`

**Body:** `label`, `actions` (`read`, `create`, `update`, `delete`, `approve`), and optionally `scoped`

**Returns:** `201` for a new resource or `200` for a change, with `created`, `module`, `resource`.

**Errors:** `404 unknown_module`

### `DELETE /modules/:key/resources/:resource`

**Access:** `private`, needs `module.update`. Refused while a role or route uses the resource.

**Returns:** `removed`, `module`, `resource`

**Errors:** `404 unknown_resource`

### `PUT /modules/:key/resources/:resource/grantable`

**Access:** `private`, needs `module.update`

**Body:** `actions`, the ones that can be given to one person. Only a super admin can add to the list.

**Returns:** `module`, `resource`, `grantable`

**Errors:** `403 beyond_own_access`

**Errors:** `404 unknown_module`, `404 unknown_resource`

## Activity log

### `GET /audit`

**Access:** `private`, needs `audit.read`

**Query:** `page`, `pageSize`, `actionPrefix` (such as `auth.`)

**Returns:** `total`, `entries`, newest first.
