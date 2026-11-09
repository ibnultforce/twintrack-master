# Employee API

The caller's own profile is the only part of Employee built so far. Every route starts with `/employee`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

Someone who can change Employee access gives a person a role with `PATCH /users/:id/roles`, using `"module": "employee"`. See [Changing someone's access](master.md#changing-someones-access).

No roles ship with the product, so a super admin creates them first. `profile.read` and `profile.update` control the profile.

`profile.read` and `profile.update` can also be given to one person as special privileges:

```sh
curl -X PUT "$API/users/u_13/privileges" \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"module":"employee","permissions":["profile.update"],"reason":"Keeps his own details current"}'
```

This replaces the person's whole list of privileges in Employee, so send `"permissions": []` to remove them.

## Profile

Both routes only ever reach the caller's own record.

### `GET /employee/me/profile`

**Access:** `private`, needs `profile.read`

**Returns:** `id`, `name`, `email`, `title`, `department`, `team`, `contract`, `superAdmin`, `mustChangePassword`, `manager`

### `PATCH /employee/me/profile`

**Access:** `private`, needs `profile.update`

**Body:** `name`

**Returns:** the updated profile.

`PATCH /auth/me` in Master also changes the caller's name, and doesn't need this permission.
