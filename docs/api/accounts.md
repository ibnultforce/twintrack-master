# Accounts API

Ledger, vouchers, bills, invoices, payroll and reports. Module key `accounts`, every path starts with `/accounts`. Shared rules (tokens, errors, paging) are in the [API guide](README.md).

Built so far: a status check and the chart of accounts. The rest follows the Accounts build plan.

## Permissions

| Permission | Lets you |
|---|---|
| `setting.read` | Check the module's status (later: read Accounts settings) |
| `ledgerAccount.read` | List and read the chart of accounts |
| `ledgerAccount.create` | Add an account |
| `ledgerAccount.update` | Rename, recode, move, deactivate or reactivate an account |

Neither resource is scoped: the chart of accounts is one list for the whole organisation. Only a super admin holds these until a profile grants them.

### `GET /accounts/status`

**Access:** `private`, needs `setting.read`

**Returns:**

```json
{ "module": "accounts", "status": "ok", "time": "2026-11-18T10:00:00.000Z" }
```

**Errors:** `401 no_token`, `403 forbidden` (signed in without `setting.read`)

## Chart of accounts

Every account has a type, which decides its normal balance side: assets and expenses increase with debits, and liabilities, equity and income with credits. A parent groups accounts of the same type, such as Bank accounts under Assets.

Accounts are never deleted, because ledger lines will name them. Deactivate one instead with `isActive: false`. Field changes to `code`, `name`, `type`, `parentId` and `isActive` are kept in the record history, and every change goes in the activity log (`ledgerAccount.created`, `.updated`, `.activated`, `.deactivated`).

`npm run seed` adds a starting chart from `seed/chart-of-accounts.json`: five groups (1000 Assets, 2000 Liabilities, 3000 Equity, 4000 Income, 5000 Expenses) and 28 accounts under them. It only adds accounts whose id is missing, so seeding again never undoes changes made in the app.

### An account

```json
{
  "id": "la_1200",
  "code": "1200",
  "name": "Bank accounts",
  "type": "asset",
  "normalBalance": "debit",
  "parentId": "la_1000",
  "isActive": true,
  "version": 0,
  "createdAt": "2026-11-18T10:00:00.000Z",
  "updatedAt": "2026-11-18T10:00:00.000Z"
}
```

### `GET /accounts/ledger-accounts`

**Access:** `private`, needs `ledgerAccount.read`

**Query:** `page`, `pageSize` (up to 100, 25 by default), `type` (`asset`, `liability`, `equity`, `income`, `expense`), `isActive` (`true` or `false`), `search` (the start of a code, or any part of a name)

**Returns:** `accounts` in code order, `total`, `page`, `pageSize`.

### `GET /accounts/ledger-accounts/:id`

**Access:** `private`, needs `ledgerAccount.read`

**Returns:** the account.

**Errors:** `404 unknown_ledger_account`

### `POST /accounts/ledger-accounts`

**Access:** `private`, needs `ledgerAccount.create`

**Body:** `code` (3 to 10 digits, unique), `name` (1 to 200 characters), `type`, optional `parentId` (an active account of the same type), optional `description` (up to 1000)

**Returns:** `201` with the account.

**Errors:** `409 duplicate_account_code`, `422 validation_failed` (bad field, or a parent that is missing, inactive or of another type)

### `PATCH /accounts/ledger-accounts/:id`

**Access:** `private`, needs `ledgerAccount.update`

**Body:** at least one of `code`, `name`, `type`, `parentId` (`null` makes it a top-level account), `description`, `isActive`; optional `version`, the version you last read, to refuse the change if someone else saved first.

**Returns:** the account.

**Errors:**

| Status and code | When |
|---|---|
| `404 unknown_ledger_account` | No such account |
| `409 duplicate_account_code` | Another account uses the code |
| `409 account_has_sub_accounts` | Changing the type of an account that has sub-accounts |
| `409 account_has_active_sub_accounts` | Deactivating an account whose sub-accounts are still active |
| `409 version_conflict` | `version` is older than the saved account |
| `422 validation_failed` | Bad field; a parent that is missing, inactive or of another type; a parent that is the account itself or one of its sub-accounts; or a chart deeper than 10 levels |
