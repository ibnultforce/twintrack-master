# Accounts API

Ledger, vouchers, bills, invoices, payroll and reports. Module key `accounts`, every path starts with `/accounts`. Shared rules (tokens, errors, paging) are in the [API guide](README.md).

Built so far: a status check, settings, the chart of accounts, the ledger core, journal vouchers with approval, and the Accounts activity log. The rest follows the Accounts build plan.

## Permissions

| Permission | Lets you |
|---|---|
| `setting.read` | Check the module's status, and read the settings |
| `setting.update` | Change the settings, and list who may be the stand-in approver |
| `ledgerAccount.read` | List and read the chart of accounts, and an account's history |
| `ledgerAccount.create` | Add an account |
| `ledgerAccount.update` | Rename, recode, move, deactivate or reactivate an account |
| `journalVoucher.read` | List and read journal vouchers and their history |
| `journalVoucher.create` | Save a new journal voucher as a draft |
| `journalVoucher.update` | Edit a draft, and submit it for approval |
| `journalVoucher.approve` | Approve, return or reverse other people's vouchers |
| `auditLog.read` | Read the Accounts activity log |

No resource is scoped: each is one list for the whole organisation. Only a super admin holds these until a profile grants them.

**Protected field:** `ledgerAccount.bankAccountNumber` is hidden in accounts, lists and history unless the grant's `fieldAccess` names it (`read` to see it, `create` or `edit` to write it). Only a super admin sees it by default.

## Approvals: the maker never decides

Whoever made a record can't approve, return or reverse it, super admins included: `403 own_record`. This is a safety rule in code. Anyone else may decide if they hold the record's `approve` permission, or are the stand-in approver named in Settings and today is on or before `standInUntil`. Otherwise `403 forbidden`. Journal vouchers use it now; bills, payroll runs and update requests will too.

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

## Dummy employees

HR isn't built yet, so payroll (plan Day 3) pays dummy employees. `npm run seed` adds 13 of them from `seed/accounts-employees.json` to `accounts_employees`: employee code (`EMP-001`), name, designation, department, join date (`YYYY-MM-DD`), monthly gross salary in integer paisa, an optional bank account number, and `isActive` (one has left, so payroll must skip them). Like the chart, the seed only adds employees whose id is missing. No route serves them yet; the payroll routes will, with the salary and bank number as protected fields.

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

**Body:** `code` (3 to 10 digits, unique), `name` (1 to 200 characters), `type`, optional `parentId` (an active account of the same type), optional `description` (up to 1000), optional `bankAccountNumber` (3 to 34 letters, digits, spaces or hyphens; needs `create` or `edit` field access)

**Returns:** `201` with the account.

**Errors:** `409 duplicate_account_code`, `422 validation_failed` (bad field, or a parent that is missing, inactive or of another type)

### `PATCH /accounts/ledger-accounts/:id`

**Access:** `private`, needs `ledgerAccount.update`

**Body:** at least one of `code`, `name`, `type`, `parentId` (`null` makes it a top-level account), `description`, `bankAccountNumber` (`null` removes it), `isActive`; optional `version`, the version you last read, to refuse the change if someone else saved first.

**Returns:** the account.

**Errors:**

| Status and code | When |
|---|---|
| `404 unknown_ledger_account` | No such account |
| `409 duplicate_account_code` | Another account uses the code |
| `409 account_has_sub_accounts` | Changing the type of an account that has sub-accounts |
| `409 account_has_ledger_lines` | Changing the type of an account that has ledger lines; open a new account instead |
| `409 account_has_active_sub_accounts` | Deactivating an account whose sub-accounts are still active |
| `409 account_has_balance` | Deactivating an account whose ledger balance isn't zero; move the money out first |
| `409 version_conflict` | `version` is older than the saved account |
| `422 validation_failed` | Bad field; a parent that is missing, inactive or of another type; a parent that is the account itself or one of its sub-accounts; a parent that has ledger lines, since a group holds no money itself; or a chart deeper than 10 levels |

### `GET /accounts/ledger-accounts/:id/history`

**Access:** `private`, needs `ledgerAccount.read`

**Query:** `page`, `pageSize`

**Returns:** `entries`, newest first, each with `action`, `changes` (field, from, to), `actorName` and `at`, and `total`. A bank number change is left out unless the grant names the field.

**Errors:** `404 unknown_ledger_account`

## Ledger

The ledger has no routes of its own. Journal vouchers write to it now, and bills and payroll will. The ledger core is in `backend/src/modules/accounts/ledger/`. Entries are stored in `accounts_ledger_entries`.

- **`postEntry`** writes one journal entry inside the caller's transaction, so the source record, its history and the ledger lines save together or not at all. It refuses (`422 unbalanced_entry`) fewer than two lines or debits that don't equal credits, and (`422 validation_failed`) a line with both or neither side, an amount that isn't a whole number of paisa or cents, a missing `source` (every entry names the record that caused it, such as `{ "type": "journalVoucher", "id": "jv_1" }`), an unknown or inactive account, a group account that has sub-accounts, a date that isn't a real `YYYY-MM-DD`, or a blank memo. It writes `ledgerEntry.posted` to the activity log.
- **`reverseEntry`** never changes an entry. It writes a new one with every line's debit and credit swapped, dated today in the server's time zone unless a date is given, links the two (`reversalOf` and `reversedBy`) and writes `ledgerEntry.reversed`. An entry can be reversed once (`409 entry_already_reversed`, also when two reversals race), a reversal can't be reversed (`409 entry_is_a_reversal`), and an unknown id answers `404 unknown_ledger_entry`. It works even if an account in the entry has since been deactivated.
- **`getTrialBalance`** sums every line per account, optionally up to a date, with debit and credit totals and their difference, which is always zero.

### An entry

```json
{
  "_id": "le_6f1c…",
  "entryDate": "2026-11-02",
  "memo": "Owner capital",
  "source": { "type": "journalVoucher", "id": "jv_1" },
  "lines": [
    { "accountId": "la_1200", "debit": 5000000, "credit": 0 },
    { "accountId": "la_3100", "debit": 0, "credit": 5000000 }
  ],
  "total": 5000000,
  "reversedBy": "le_93ab…",
  "createdBy": "u_01",
  "createdAt": "2026-11-19T10:00:00.000Z"
}
```

Amounts are whole paisa or cents: `5000000` is 50,000.00.

## Settings

One record for the whole module, created empty the first time it is read.

### `GET /accounts/settings`

**Access:** `private`, needs `setting.read`

**Returns:**

```json
{
  "standInApprover": { "id": "u_05", "name": "Rumana" },
  "standInUntil": "2026-12-31",
  "isStandInActive": true,
  "currencies": [{ "code": "EUR", "name": "Euro" }, { "code": "USD", "name": "US dollar" }],
  "exchangeRates": [
    { "currency": "EUR", "effectiveFrom": "2026-11-01", "paisaPerUnit": 13100 },
    { "currency": "USD", "effectiveFrom": "2026-11-01", "paisaPerUnit": 12250 }
  ],
  "taxRates": [{ "code": "VAT15", "name": "VAT 15%", "basisPoints": 1500 }],
  "version": 3
}
```

The books are kept in taka (BDT). `currencies` lists the foreign currencies the company deals in (`code`, 3 to 10 capital letters such as USD or USDT, and a `name`), by code. `exchangeRates` holds rates for them: `currency` must be one of those codes, and `paisaPerUnit` is taka per one unit in paisa (USD 12250 is 122.50 taka per dollar). Listed by currency, then newest first; a document in another currency will use that currency's rate on its date. `basisPoints` is the rate in hundredths of a percent (1500 is 15%).

Each part of the settings is a field of the `setting` resource (`standInApproverId`, `standInUntil`, `currencies`, `exchangeRates`, `taxRates`), so the Profiles screen can make it hidden, read-only or editable per profile. A hidden part is left out of the answer (hiding `standInApproverId` also leaves out `standInApprover` and `isStandInActive`).

### `PATCH /accounts/settings`

**Access:** `private`, needs `setting.update`

**Body:** at least one of `standInApproverId` (`null` clears it, and its end date), `standInUntil` (YYYY-MM-DD, the last day; `null` for no end), `currencies`, `exchangeRates`, `taxRates`; optional `version`. Rate lists replace the saved list whole.

**Errors:** `403 field_not_editable` (a part the profile can't edit), `409 version_conflict`, `422 validation_failed` (a stand-in who isn't an active person able to open journal vouchers, an end date with no stand-in, the same currency and date or the same tax code listed twice, a currency code that isn't 3 to 10 capital letters or is BDT, a rate for a currency not in the list, removing a currency that still has rates, a rate that isn't whole paisa or basis points, a tax code that isn't capitals, digits or underscores)

Changes to the stand-in and rates are kept in the record history, and each save writes `setting.updated`.

### `GET /accounts/settings/approver-candidates`

**Access:** `private`, needs `setting.update`

**Returns:** `people` (`id`, `name`, `email`): active super admins and holders of a profile that grants anything on journal vouchers.

## Journal vouchers

A manual journal entry that a second person approves before it reaches the ledger.

| Status | Means | Next |
|---|---|---|
| `draft` | The maker is writing it | Edit, or submit |
| `submitted` | Waiting for a decision | Approve (records it), or return to draft with a note |
| `recorded` | In the ledger; never edited again | Reverse |
| `reversed` | A reversal has cancelled it in the ledger | None |

A voucher is checked like a ledger entry when it is saved and again when it is submitted: lines balance, amounts are whole paisa, accounts exist, are active and aren't groups. Numbers run `JV-0001`, `JV-0002` and so on and are never reused. Every step writes the record history and the activity log (`journalVoucher.created`, `.updated`, `.submitted`, `.approved`, `.returned`, `.reversed`); approving also writes `ledgerEntry.posted`, and reversing `ledgerEntry.reversed`.

### A voucher

```json
{
  "id": "jv_6f1c…",
  "number": "JV-0001",
  "voucherDate": "2026-11-02",
  "memo": "November office rent",
  "lines": [
    { "accountId": "la_5300", "debit": 2500000, "credit": 0 },
    { "accountId": "la_1100", "debit": 0, "credit": 2500000 }
  ],
  "total": 2500000,
  "status": "recorded",
  "createdBy": { "id": "u_04", "name": "Rahim" },
  "submittedBy": { "id": "u_04", "name": "Rahim" },
  "approvedBy": { "id": "u_09", "name": "Mehedi" },
  "ledgerEntryId": "le_93ab…",
  "version": 3
}
```

`GET /accounts/journal-vouchers/:id` also returns `allowedActions` (`edit`, `submit`, `approve`, `return`, `reverse`, each `true` or `false`) for the caller, so a screen shows only buttons that will work. The routes still check.

### `GET /accounts/journal-vouchers`

**Access:** `private`, needs `journalVoucher.read`

**Query:** `page`, `pageSize`, `status`

**Returns:** `vouchers`, newest date first, `total`, `page`, `pageSize`.

### `POST /accounts/journal-vouchers`

**Access:** `private`, needs `journalVoucher.create`

**Body:** `voucherDate`, `memo`, `lines` (2 to 200, each `accountId` and either `debit` or `credit` in paisa, optional `memo`)

**Returns:** `201` with the draft.

**Errors:** `422 unbalanced_entry`, `422 validation_failed`

### `GET /accounts/journal-vouchers/:id`

**Access:** `private`, needs `journalVoucher.read`

**Errors:** `404 unknown_journal_voucher`

### `PATCH /accounts/journal-vouchers/:id`

**Access:** `private`, needs `journalVoucher.update`

**Body:** at least one of `voucherDate`, `memo`, `lines`; optional `version`

**Errors:** `409 voucher_not_draft`, `409 version_conflict`, `422 unbalanced_entry`, `422 validation_failed`

### `POST /accounts/journal-vouchers/:id/submit`

**Access:** `private`, needs `journalVoucher.update`

**Body:** optional `version`

**Errors:** `409 voucher_not_draft`, `422` when a line names an account closed since the draft was saved

### `POST /accounts/journal-vouchers/:id/approve`

**Access:** `private`, needs `journalVoucher.read` at the route; the service then needs `journalVoucher.approve` or the stand-in, and never the maker.

**Body:** optional `version`

Records the voucher in the ledger in the same transaction: if the ledger refuses the entry, nothing changes and the voucher stays submitted. Two approvals at once: one wins, the other gets `409 version_conflict`.

**Errors:** `403 own_record`, `403 forbidden`, `409 voucher_not_submitted`, `409 version_conflict`, `422` from the ledger

### `POST /accounts/journal-vouchers/:id/return`

**Access:** as approve

**Body:** `note` (what to fix, up to 1000 characters), optional `version`

Sends it back to `draft`, keeping the note until the maker submits again.

**Errors:** `403 own_record`, `403 forbidden`, `409 voucher_not_submitted`

### `POST /accounts/journal-vouchers/:id/reverse`

**Access:** as approve

**Body:** optional `memo` for the reversal, optional `version`

Writes a reversal in the ledger dated today and marks the voucher `reversed`. The voucher and its original entry stay as they were.

**Errors:** `403 own_record`, `403 forbidden`, `409 voucher_not_recorded`

### `GET /accounts/journal-vouchers/:id/history`

**Access:** `private`, needs `journalVoucher.read`

**Returns:** `entries` and `total`, as for an account's history.

## Activity log

### `GET /accounts/audit-log`

**Access:** `private`, needs `auditLog.read`

**Query:** `page`, `pageSize`, `actionPrefix` (such as `journalVoucher.`)

**Returns:** `entries`, newest first, each with `at`, `actorName`, `action`, `targetType`, `targetId`, `targetName`, and `total`. Only entries the Accounts module wrote; Master's `/audit` shows everything and needs a Master permission.
