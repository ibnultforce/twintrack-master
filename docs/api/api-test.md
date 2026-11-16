# API Test API

A one-route module for checking that a module's routes, permissions and sessions work end to end. Every route starts with `/api-test`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

A person reaches API Test through their profile, given with `PUT /users/:id/profile`. See [Changing someone's access](master.md#changing-someones-access).

No profiles ship with the product, so only a super admin holds `test.read` until a profile grants it.

## Test

### `GET /api-test/test`

**Access:** `private`, needs `test.read`

**Returns:** `200` with `{ "status": "ok", "module": "api-test", "time": "<ISO timestamp>" }`. It does not touch module data, so it shows only that the caller reached the module and holds the permission.

**Errors:** `401 no_token` without a token, `403 forbidden` without `test.read`

```sh
curl "$API/api-test/test" -H "Authorization: Bearer eyJ..."
```
