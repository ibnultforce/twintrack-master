# HR API

Salaries are the only part of HR built so far. Every route starts with `/hr`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

A person reaches HR through their profile, given with `PUT /users/:id/profile`. See [Changing someone's access](master.md#changing-someones-access).

No profiles ship with the product, so a super admin creates them first. These permissions control salaries: `salary.read`, `salary.create`, `salary.update`, `salary.approve`, `salary.delete` and `salary.share`.

The scope decides whose salaries the caller reaches. A salary outside it is refused with `403 out_of_scope`.

## Salaries

A salary has `id`, `employeeId`, `employeeName`, `amount`, `currency`, `effectiveFrom`, `status` (`pending` or `approved`), `approvedBy`, `approvedAt`, `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, and `deletedAt` and `deletedBy` while it's in the recycle bin.

Each change is written to the record's history in the same transaction. The history holds field values, so it follows the same reach as reading the record. Which fields it tracks comes from `trackedFields` on the resource in the module's manifest. Sending the `version` you last read with an edit refuses it with `409 version_conflict` if someone changed the record since. Deleting moves a record to the recycle bin, which hides it everywhere until it's restored.

A history entry has `id`, `at`, `action` (`created`, `updated`, `deleted` or `restored`), `changes` (each with `field`, `from` and `to`), `actorId` and `actorName`.

### `GET /hr/salaries`

**Access:** `private`, needs `salary.read`

**Query:** `page`, `pageSize`, and `deleted=true` for the recycle bin, which needs `salary.delete`

**Returns:** `scope`, `total`, `salaries`, limited to the caller's scope.

### `POST /hr/salaries`

**Access:** `private`, needs `salary.create`

**Body:** `employeeId`, `amount` (above zero), `effectiveFrom` (such as `2026-12-01`), and optionally `currency` (three capital letters, default `BDT`)

**Returns:** `201` with the salary, as `pending`.

**Errors:** `403 out_of_scope`

```sh
curl -X POST "$API/hr/salaries" \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"u_08","amount":99000,"effectiveFrom":"2027-01-01"}'
```

### `PATCH /hr/salaries/:id`

**Access:** `private`, needs `salary.update`

**Body:** any of `amount`, `currency`, `effectiveFrom`, and optionally `version`

**Returns:** the salary, which goes back to `pending`.

**Errors:** `403 out_of_scope`, `404 unknown_salary`, `409 version_conflict`

### `PATCH /hr/salaries/:id/approve`

**Access:** `private`, needs `salary.approve`

**Body:** optionally `version`

**Returns:** the salary as `approved`, recording who approved it. Approving one already approved changes nothing.

**Errors:** `403 out_of_scope`, `404 unknown_salary`, `409 version_conflict`

## Sharing

Field access controls `amount`, `currency`, `effectiveFrom` and `status`. `currency`, `effectiveFrom` and `status` follow the grant's actions unless it names them. `amount` is a protected field. Someone needs `fieldAccess: { "amount": "read" }` in their profile to see it, `create` to set it when creating a salary only, and `edit` to set it when creating or changing one. Without read access it's left out of salaries and their history, and writing it returns `403 field_not_editable`.

A share lets someone's salary.read permission reach one salary beyond their scope. It never adds a permission: without `salary.read` a share does nothing. A `read` share counts for reading, the history and the share list. An `edit` share also counts for changing it. Approving, deleting and restoring always follow the scope alone.

A salary belongs to its employee. The owner, anyone above them (whom a `team` scope reaches), or someone holding `salary.share` with a scope that reaches it may share or stop sharing. Anyone else gets `403 may_not_share`. Sharing again with the same grantee changes the access instead of adding a second share. The resource's `sharingModel` in the manifest (`private`, `publicRead` or `publicReadWrite`) decides who sees salaries nobody has shared. It starts as `private`.

A share has `id`, `granteeType` (`user`, `orgRole`, or `orgRoleAndBelow` for a role and every role under it), `granteeId`, `access` (`read` or `edit`), `expiresAt`, `sharedBy` and `createdAt`. Sharing and stopping are recorded in the activity log as `record.shared` and `record.unshared`.

### `GET /hr/salaries/:id/shares`

**Access:** `private`, needs `salary.read`, reaching the salary

**Returns:** `shares`

### `POST /hr/salaries/:id/shares`

**Access:** `private`, needs `salary.read`, and the right to share described above

**Body:** `granteeType`, `granteeId`, `access`, and optionally `expiresAt` (a future date and time)

**Returns:** `201` with the share.

**Errors:** `403 may_not_share`, `404 unknown_salary`, `422 validation_failed` for a grantee that doesn't exist or an expiry in the past

### `DELETE /hr/salaries/:id/shares/:shareId`

**Access:** `private`, needs `salary.read`, and the right to share

**Returns:** `removed`, `id`

**Errors:** `403 may_not_share`, `404 unknown_salary`, `404 unknown_share`

### `DELETE /hr/salaries/:id`

**Access:** `private`, needs `salary.delete`

**Returns:** the salary, now in the recycle bin.

**Errors:** `403 out_of_scope`, `404 unknown_salary`

### `POST /hr/salaries/:id/restore`

**Access:** `private`, needs `salary.delete`

**Returns:** the salary, out of the recycle bin.

**Errors:** `403 out_of_scope`, `404 unknown_salary` when it isn't in the recycle bin

### `GET /hr/salaries/:id/history`

**Access:** `private`, needs `salary.read`, within the caller's scope. Someone with `salary.delete` can also read the history of a deleted salary.

**Query:** `page`, `pageSize`

**Returns:** `total`, `entries`, newest first.

**Errors:** `403 out_of_scope`, `404 unknown_salary`
