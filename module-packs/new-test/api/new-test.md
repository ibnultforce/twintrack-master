# New test API

A two-route module for checking that a module answers and that its permissions and sessions work end to end. Every route starts with `/new-test`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

A person reaches New test through their profile, given with `PUT /users/:id/profile`. See [Changing someone's access](master.md#changing-someones-access).

No profiles ship with the product, so only a super admin holds `test.read` until a profile grants it.

## Test

### `GET /new-test/test`

**Access:** `private`, needs `test.read`

**Returns:** `200` with `{ "status": "ok", "module": "new-test", "time": "<ISO timestamp>" }`. It does not touch module data, so it shows only that the caller reached the module and holds the permission.

**Errors:** `401 no_token` without a token, `403 forbidden` without `test.read`

```sh
curl "$API/new-test/test" -H "Authorization: Bearer eyJ..."
```

## Health

### `GET /new-test/health`

**Access:** `public`, no token needed

**Returns:** `200` with `{ "status": "ok", "module": "new-test", "time": "<ISO timestamp>" }`. It reads no module data, so it shows only that the module's routes are answering. For the database, use Master's `GET /health`.

```sh
curl "$API/new-test/health"
```
