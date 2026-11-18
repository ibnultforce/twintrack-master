# Accounts API

Ledger, vouchers, bills, invoices, payroll and reports. Module key `accounts`, every path starts with `/accounts`. Shared rules (tokens, errors, paging) are in the [API guide](README.md).

Only a status check is built so far. The rest follows the Accounts build plan.

## Permissions

| Permission | Lets you |
|---|---|
| `setting.read` | Check the module's status (later: read Accounts settings) |

`setting` isn't scoped. Only a super admin holds it until a profile grants it.

### `GET /accounts/status`

**Access:** `private`, needs `setting.read`

**Returns:**

```json
{ "module": "accounts", "status": "ok", "time": "2026-11-18T10:00:00.000Z" }
```

**Errors:** `401 no_token`, `403 forbidden` (signed in without `setting.read`)
