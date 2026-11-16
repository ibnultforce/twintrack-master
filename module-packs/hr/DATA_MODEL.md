# HR: data model

What the HR API stores and returns. Module key: `hr`. Every route starts with `/hr`. Today that is salaries only.

This describes records **as the API returns them**. The same model is in `schema.json` as JSON Schema. Routes, bodies and error codes are in `api/hr.md`.

## Reading this document

- **Type** uses JSON types. `date-time` is an ISO 8601 string such as `2026-11-13T09:30:00.000Z`. `date` is a calendar day sent as `YYYY-MM-DD` and returned as midnight UTC.
- **Always** means the field is in every response. Anything else can be missing, because it isn't set or because field security hides it from this person.
- **Field access**: `controlled` fields follow the person's field access; `protected` fields are hidden unless their profile grants them. The levels are `hidden`, `read`, `create` (set on a new record only) and `edit`.

## Who reaches a record

`salary.*` permissions are scoped: `own` is the person's own salary, `team` adds everyone who reports to them at any depth, `all` is everyone. A share can let `salary.read` reach one more salary. The API applies all of this; the screen never filters.

## Salary

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes | | |
| `employeeId` | string | yes | | Whose salary it is |
| `employeeName` | string | | | Missing if the person no longer exists |
| `amount` | number | | protected | Above zero |
| `currency` | string | | controlled | Three capital letters, default `BDT` |
| `effectiveFrom` | date | | controlled | First day it applies |
| `status` | SalaryStatus | | controlled | |
| `approvedBy`, `approvedAt` | string, date-time | | | Set when approved |
| `version` | number | yes | | Send back with an edit |
| `createdBy`, `createdAt`, `updatedBy`, `updatedAt` | | yes | | |
| `deletedAt`, `deletedBy` | | | | Only while in the recycle bin |

Any edit sends an approved salary back to `pending`.

### SalaryStatus

| Value | Label | Pill |
|---|---|---|
| `pending` | Waiting for approval | `warning` |
| `approved` | Approved | `good` |

## Share

`id`, `granteeType` (`user` "Person", `orgRole` "Org role", `orgRoleAndBelow` "Org role and below"), `granteeId`, `access` (`read` "Can view", `edit` "Can edit"), `expiresAt` (optional), `sharedBy`, `createdAt`.

## HistoryEntry

`id`, `at`, `action` (`created`, `updated`, `deleted`, `restored`), `changes` (each `field`, `from`, `to`; hidden fields are left out), `actorId`, `actorName`.

## Shared types

**List pages:** `page` (from 1) and `pageSize` (up to 100) in the query; the answer has `total` and the list.

**Errors:** every error is `{ "error": { "code", "message", "fields"? } }`. Show `message`. Common codes: `403 forbidden`, `403 out_of_scope`, `403 field_not_editable`, `403 may_not_share`, `404 unknown_salary`, `409 version_conflict`, `422 validation_failed` (with `fields`).
