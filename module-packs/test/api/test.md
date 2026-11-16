# Test API

A small module for checking that a module's routes, permissions and sessions work end to end, and that it can read people from Master. Its routes are `/test` and `/test/users`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

A person reaches Test through their profile, given with `PUT /users/:id/profile`. See [Changing someone's access](master.md#changing-someones-access).

No profiles ship with the product, so only a super admin holds `test.read` until a profile grants it.

## Test

### `GET /test`

**Access:** `private`, needs `test.read`

**Returns:** `200` with `{ "status": "ok", "module": "test", "time": "<ISO timestamp>" }`. It does not touch module data, so it shows only that the caller reached the module and holds the permission.

**Errors:** `401 no_token` without a token, `403 forbidden` without `test.read`

```sh
curl "$API/test" -H "Authorization: Bearer eyJ..."
```

## Users

### `GET /test/users`

**Access:** `private`, needs `test.read`

**Query:** `page` (from 1), `pageSize` (1 to 100, default 25), `search` (up to 100 characters; matches name, email or title). All optional.

**Returns:** `200` with `{ "people": [...], "total": <number> }`. Each person is a colleague from the directory: `id`, `name`, `email`, and when set `title`, `department`, `team`, `employeeNumber`, `photoUpdatedAt`. `online` is included only for people your Master `presence.read` scope reaches. Only active people are listed, and super admins are left out: the same people and fields `GET /directory` shows anyone signed in, so it reveals nothing more. Access details such as profile and status stay with Master's `GET /users`.

**Errors:** `401 no_token` without a token, `403 forbidden` without `test.read`, `422 validation_failed` for a bad page, page size or search

```sh
curl "$API/test/users?search=kamrul" -H "Authorization: Bearer eyJ..."
```
