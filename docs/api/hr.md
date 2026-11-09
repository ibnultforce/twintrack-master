# HR API

Salaries are the only part of HR built so far. Every route starts with `/hr`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

Someone who can change HR access gives a person a role with `PATCH /users/:id/roles`, using `"module": "hr"`. See [Changing someone's access](master.md#changing-someones-access).

No roles ship with the product, so a super admin creates them first. These permissions control salaries: `salary.read`, `salary.create`, `salary.update` and `salary.approve`.

`salary.read` can also be given to one person as a special privilege, and reaches `team`. Holding `access.update` lets someone change anyone's HR access.

The scope decides whose salaries the caller reaches. A salary outside it is refused with `403 out_of_scope`.

## Salaries

A salary has `id`, `employeeId`, `employeeName`, `amount`, `currency`, `effectiveFrom`, `status` (`pending` or `approved`), `approvedBy` and `approvedAt`.

### `GET /hr/salaries`

**Access:** `private`, needs `salary.read`

**Query:** `page`, `pageSize`

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

**Body:** any of `amount`, `currency`, `effectiveFrom`

**Returns:** the salary, which goes back to `pending`.

**Errors:** `403 out_of_scope`, `404 unknown_salary`

### `PATCH /hr/salaries/:id/approve`

**Access:** `private`, needs `salary.approve`

**Returns:** the salary as `approved`, recording who approved it. Approving one already approved changes nothing.

**Errors:** `403 out_of_scope`, `404 unknown_salary`
