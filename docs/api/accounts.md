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
| `clientAccount.read` / `.update` | See / set how each client is billed: terms, currency, hourly rate |
| `invoice.read` / `.create` / `.update` | See invoices; make one; edit, submit and cancel drafts |
| `invoice.approve` | Issue, return or cancel other people's invoices |
| `vendor.read` / `.create` / `.update` | See, add and change vendors |
| `bill.read` / `.create` / `.update` | See bills; make one; edit, submit and cancel drafts |
| `bill.approve` | Record, return or cancel other people's bills |
| `payrollRun.read` / `.create` / `.update` | See payroll runs; make a month's run; edit, submit and cancel drafts |
| `payrollRun.approve` | Record, return or cancel other people's runs |
| `fixedAsset.read` / `.create` / `.update` | See the asset register; add assets; change them and run depreciation |
| `inventoryItem.read` / `.create` / `.update` | See stock; add items; change them and record movements |
| `bankReconciliation.read` / `.create` / `.update` | See statements; load one from CSV; match lines and sign it off |
| `staffPayout.read` / `.create` / `.update` / `.approve` | Bonus, incentive and commission payouts, as for payroll runs |
| `commissionRule.read` / `.create` / `.update` | See commission rules and earnings; add and change rules |
| `employeeLoan.read` / `.create` / `.update` / `.approve` | Loans and advances, as for payroll runs |
| `unpaidLeave.read` / `.update` | See and set unpaid leave days that payroll deducts |
| `auditLog.read` | Read the Accounts activity log |

No resource is scoped: each is one list for the whole organisation. Only a super admin holds these until a profile grants them.

**Protected fields:** `payrollRun.lines` (each person's pay) is hidden unless a grant names it. `ledgerAccount.bankAccountNumber` is hidden in accounts, lists, history and Cash and bank unless the grant's `fieldAccess` names it (`read` to see it, `create` or `edit` to write it). Only a super admin sees it by default. Even then it is masked, as `•••• 7712`; the full number comes only from `POST /accounts/ledger-accounts/:id/reveal-bank-number`, and every reveal is written to the activity log (`ledgerAccount.bankNumberRevealed`).

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

Each account also has `balance`: paisa from ledger lines only, on its normal side (debits minus credits for assets and expenses, credits minus debits for liabilities, equity and income).

### `POST /accounts/ledger-accounts/:id/reveal-bank-number`

**Access:** `private`, needs `ledgerAccount.read`, and read access to the `bankAccountNumber` field.

The full bank account number, which every other response masks. Each call writes `ledgerAccount.bankNumberRevealed` to the activity log. A POST so it is never cached.

**Returns:** `{ bankAccountNumber }`.

**Errors:** `403 field_hidden` (the profile doesn't name the field), `404 unknown_ledger_account`, `404 no_bank_account_number`.

### `POST /accounts/ledger-accounts`

**Access:** `private`, needs `ledgerAccount.create`

**Body:** `code` (3 to 10 digits, unique), `name` (1 to 200 characters), `type`, optional `parentId` (an active account of the same type), optional `description` (up to 1000), optional `bankAccountNumber` (3 to 34 letters, digits, spaces or hyphens; needs `create` or `edit` field access), optional `cashOrBank` (`cash` or `bank`; only on an asset account that groups no others, and it then can't become a parent), optional `bankName` (1 to 200 characters; only with `cashOrBank: "bank"`)

**Returns:** `201` with the account.

**Errors:** `409 duplicate_account_code`, `422 validation_failed` (bad field, or a parent that is missing, inactive or of another type)

### `PATCH /accounts/ledger-accounts/:id`

**Access:** `private`, needs `ledgerAccount.update`

**Body:** at least one of `code`, `name`, `type`, `parentId` (`null` makes it a top-level account), `description`, `bankAccountNumber` (`null` removes it), `cashOrBank` (`null`: no longer cash or bank), `bankName` (`null` removes it), `isActive`; optional `version`, the version you last read, to refuse the change if someone else saved first.

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
  "homeCurrency": "BDT",
  "currencies": [{ "code": "EUR", "name": "Euro" }, { "code": "USD", "name": "US dollar" }],
  "defaultCurrency": "USD",
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

**Body:** at least one of `standInApproverId` (`null` clears it, and its end date), `standInUntil` (YYYY-MM-DD, the last day; `null` for no end), `currencies`, `defaultCurrency`, `exchangeRates`, `taxRates`, `providentFundBasisPoints` (the employee share of gross pay taken by payroll; the company adds the same; `1000` is 10%, `0` is none), `gratuityBasisPoints` (set aside each month on gross pay; `833` is about a month's pay a year); optional `version`. Rate lists replace the saved list whole. Payroll runs keep the rates they were made with.

`homeCurrency` is always `BDT`: the books are kept in taka. `defaultCurrency` is the currency new documents, such as invoices and bills, start in: `BDT` or one of `currencies` (`BDT` until set). People can still choose another currency on each document, and a foreign-currency document uses that currency's rate on its date. It is a field of the setting resource like the others, so a profile can hide or lock it.

**Errors:** `403 field_not_editable` (a part the profile can't edit), `409 version_conflict`, `422 validation_failed` (a stand-in who isn't an active person able to open journal vouchers, an end date with no stand-in, the same currency and date or the same tax code listed twice, a currency code that isn't 3 to 10 capital letters or is BDT, a rate for a currency not in the list, removing a currency that still has rates, a `defaultCurrency` that isn't BDT or a listed currency, removing the currency that is the default, a rate that isn't whole paisa or basis points, a tax code that isn't capitals, digits or underscores)

Changes to the stand-in, default currency and rates are kept in the record history, and each save writes `setting.updated`.

### `GET /accounts/settings/approver-candidates`

**Access:** `private`, needs `setting.update`

**Returns:** `people` (`id`, `name`, `email`): active super admins and holders of a profile that grants anything on journal vouchers.

## Vouchers: journal, payment and receipt

A voucher is an entry that a second person approves before it reaches the ledger. There are three types, in one list with one approval flow and the same `journalVoucher` permissions:

| `voucherType` | Numbered | Made with | Lines |
|---|---|---|---|
| `journal` | `JV-0001` | `POST /accounts/journal-vouchers` | Any balanced debit and credit lines |
| `payment` | `PV-0001` | `POST /accounts/payment-vouchers` | Items debited (what was paid for, such as `2100 Accounts payable`), and one credit to the cash or bank account `moneyAccountId`, which the API adds |
| `receipt` | `RV-0001` | `POST /accounts/receipt-vouchers` | Items credited (what the money was for, such as `1300 Accounts receivable`), and one debit to the cash or bank account, which the API adds |

Each type is created and edited on its own path; listing, reading, submitting, approving, returning, reversing and history use the `/accounts/journal-vouchers` paths for every type. Vouchers saved before types existed are `journal`.

**Every edit to a draft needs a `reason`**, saved with the change in the voucher's history (`reason` on the history entry).

| Status | Means | Next |
|---|---|---|
| `draft` | The maker is writing it | Edit, or submit |
| `submitted` | Waiting for a decision | Approve (records it), or return to draft with a note |
| `recorded` | In the ledger; never edited again | Reverse |
| `reversed` | A reversal has cancelled it in the ledger | None |

A voucher is checked like a ledger entry when it is saved and again when it is submitted: lines balance, amounts are whole paisa, accounts exist, are active and aren't groups. Each type has its own number series, and a number is never reused. Every step writes the record history and the activity log (`journalVoucher.created`, `.updated`, `.submitted`, `.approved`, `.returned`, `.reversed`); approving also writes `ledgerEntry.posted`, and reversing `ledgerEntry.reversed`.

### A voucher

```json
{
  "id": "jv_6f1c…",
  "voucherType": "payment",
  "number": "PV-0001",
  "voucherDate": "2026-11-10",
  "memo": "Paying Desh Furniture",
  "party": "Desh Furniture",
  "reference": "Cheque 004512",
  "moneyAccountId": "la_1100",
  "lines": [
    { "accountId": "la_2100", "debit": 1800000, "credit": 0, "memo": "Bill DF-221" },
    { "accountId": "la_1100", "debit": 0, "credit": 1800000, "memo": "Paid out" }
  ],
  "total": 1800000,
  "status": "recorded",
  "createdBy": { "id": "u_04", "name": "Rahim" },
  "submittedBy": { "id": "u_04", "name": "Rahim" },
  "approvedBy": { "id": "u_09", "name": "Mehedi" },
  "ledgerEntryId": "le_93ab…",
  "version": 3
}
```

`GET /accounts/journal-vouchers/:id` also returns `allowedActions` (`edit`, `submit`, `approve`, `return`, `reverse`, `requestCorrection`, each `true` or `false`) for the caller, so a screen shows only buttons that will work, and `waitingUpdateRequest` (`{ id, number }`) when a correction is waiting; `requestCorrection` is then `false`. The routes still check.

### `GET /accounts/journal-vouchers`

**Access:** `private`, needs `journalVoucher.read`

**Query:** `page`, `pageSize`, `type` (`journal`, `payment` or `receipt`), `status`, `from` and `to` (the first and last voucher date, `YYYY-MM-DD`, either or both), `search` (the start of a voucher number such as `JV-00`, or any part of the memo or party, ignoring case). Filters combine.

**Errors:** 422 `validation_failed` for a date that isn't real, or `to` before `from`.

**Returns:** `vouchers`, newest date first, `total`, `page`, `pageSize`.

### `POST /accounts/journal-vouchers`

**Access:** `private`, needs `journalVoucher.create`

**Body:** `voucherDate`, `memo`, optional `party` and `reference`, `lines` (2 to 200, each `accountId` and either `debit` or `credit` in paisa, optional `memo`)

**Returns:** `201` with the draft.

**Errors:** `422 unbalanced_entry`, `422 validation_failed`

### `POST /accounts/payment-vouchers` and `POST /accounts/receipt-vouchers`

**Access:** `private`, needs `journalVoucher.create`

**Body:** `voucherDate`, `memo`, `party` (who was paid, or who paid; required), optional `reference` (such as a cheque number), `moneyAccountId` (an active account marked cash or bank), `lines` (1 to 199 items, each `accountId`, `amount` in paisa above zero, optional `memo`). The API adds the cash or bank line for the total.

**Returns:** `201` with the draft.

**Errors:** `422 validation_failed` when `moneyAccountId` isn't an active cash or bank account, or an item names it; `422` from the ledger checks, as for a journal voucher

### `PATCH /accounts/payment-vouchers/:id` and `PATCH /accounts/receipt-vouchers/:id`

**Access:** `private`, needs `journalVoucher.update`

**Body:** `reason` (required) and at least one of `voucherDate`, `memo`, `party`, `reference` (empty removes it), `moneyAccountId`, `lines` (items, as on create); optional `version`. A new `moneyAccountId` alone keeps the items; new `lines` alone keep the money account.

**Errors:** `409 voucher_not_draft`, `409 wrong_voucher_type` (the id is another type of voucher), `409 version_conflict`, `422 validation_failed`, `422 unbalanced_entry`

### `GET /accounts/journal-vouchers/:id`

**Access:** `private`, needs `journalVoucher.read`

**Errors:** `404 unknown_journal_voucher`

### `PATCH /accounts/journal-vouchers/:id`

**Access:** `private`, needs `journalVoucher.update`

**Body:** `reason` (required) and at least one of `voucherDate`, `memo`, `party`, `reference` (empty removes it), `lines`; optional `version`. Journal vouchers only.

**Errors:** `409 voucher_not_draft`, `409 wrong_voucher_type`, `409 version_conflict`, `422 unbalanced_entry`, `422 validation_failed`

### `POST /accounts/journal-vouchers/:id/submit`

**Access:** `private`, needs `journalVoucher.update`

**Body:** optional `version`

**Errors:** `409 voucher_not_draft`, `422` when a line names an account closed since the draft was saved

### `POST /accounts/journal-vouchers/:id/approve`

**Access:** `private`, needs `journalVoucher.read` at the route; the service then needs `journalVoucher.approve` or the stand-in, and never the maker.

**Body:** optional `version`

Records the voucher in the ledger in the same transaction: if the ledger refuses the entry, nothing changes and the voucher stays submitted. Two approvals at once: one wins, the other gets `409 version_conflict`. A payment or receipt made from a document is refused with `409 more_than_owed` when the document's recorded payments plus this one would pass `linkedDocument.amountDue`, such as a second voucher from a double click on Pay.

**Errors:** `403 own_record`, `403 forbidden`, `409 voucher_not_submitted`, `409 version_conflict`, `409 more_than_owed`, `422` from the ledger

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

## Client billing

How each active Master client is billed. The client itself (name, contacts, status) stays in Master; Accounts keeps only how it bills them. A client nobody has set up is billed on the defaults: Net 30, the default currency from Settings, and no hourly rate.

### `GET /accounts/clients`

**Access:** `private`, needs `clientAccount.read`

**Returns:** `clients`, by name: `clientId`, `clientName`, `termsDays`, `currency`, `hourlyRate` (minor units of the currency per hour; missing until set), `version`.

### `PATCH /accounts/clients/:id`

**Access:** `private`, needs `clientAccount.update`

**Body:** at least one of `termsDays` (0 to 365), `currency` (`BDT` or a currency listed in Settings), `hourlyRate` (minor units above zero, such as `4500` for $45.00; `null` clears it); optional `version`. The first change creates the client's billing record.

**Errors:** `404 unknown_client`, `409 version_conflict`, `422 validation_failed` (a currency not in Settings)

## Invoices

Money a client owes. An invoice is built from finished, billable Project management tasks that no invoice has billed yet, plus typed items such as milestones. A task bills its **estimated** hours × the client's hourly rate, rounded to the cent, so the price doesn't change with how long the work took. Its tasks are marked invoiced as soon as the draft is saved, so two invoices never bill the same task; cancelling the invoice frees them.

| Status | Means | Next |
|---|---|---|
| `draft` | Being written | Edit (with a reason), submit, cancel |
| `submitted` | Waiting for someone other than its maker | Approve (issues it), return with a note |
| `issued` | Recorded: Dr 1300 Accounts receivable, Cr 4100 Service income, in taka at the rate on the issue date | Receive payment; cancel with a reversal while it has no receipts |
| `cancelled` | Given up, or reversed in the ledger | None |

An invoice is in its own currency (the client's, by default the Settings default). It needs a rate in Settings on or before its issue date (`422 no_exchange_rate` otherwise); approving stores that `exchangeRate` (paisa per unit) and `totalInTaka`. Numbers run `INV-0001` and are never reused. Due date defaults to the issue date plus the client's terms.

**Paid is never typed.** An issued invoice shows `paid` (recorded receipts linked to it), `outstanding`, `pending` (receipts drafted or waiting for approval), `paymentStatus` (`unpaid`, `part_paid`, `paid`, `overdue` from the day after the due date) and `daysOverdue`.

### `GET /accounts/invoices`

**Access:** `private`, needs `invoice.read`

**Query:** `page`, `pageSize`, `status`, `paymentStatus`, `clientId`, `from` and `to` (issue dates), `search` (the start of a number, or part of the client's name)

**Returns:** `invoices`, newest issue date first, `total`, `page`, `pageSize`.

### `POST /accounts/invoices`

**Access:** `private`, needs `invoice.create`

**Body:** `clientId`, `issueDate`, optional `dueDate`, `currency`, `taskIds` (finished, billable tasks on the client's projects that no other invoice bills; the invoice must be in the client's billing currency and the client needs an hourly rate), `items` (each `description`, `amount` in the currency's minor units, optional `milestone`). At least one task or item.

**Returns:** `201` with the draft.

**Errors:** `404 unknown_client`, `422 validation_failed` (a task that isn't the client's, finished, billable or free; no lines; a due date before the issue date), `422 no_exchange_rate`

### `GET /accounts/invoices/billable-tasks`

**Access:** `private`, needs `invoice.create`

**Query:** `clientId`, `from`, `to` (completion dates)

**Returns:** `client` (its billing settings) and `tasks`: `id`, `number`, `title`, `projectId`, `projectName`, `hours`, `date`, and `amount` at the client's rate when it has one.

### `GET /accounts/invoices/:id`

**Access:** `private`, needs `invoice.read`

**Returns:** the invoice, `receipts` (`id`, `number`, `voucherDate`, `amount`, `status`) and `allowedActions` (`edit`, `submit`, `approve`, `return`, `cancel`, `receivePayment`).

### `PATCH /accounts/invoices/:id`

**Access:** `private`, needs `invoice.update`

**Body:** `reason` (required, kept in the history) and at least one of `issueDate`, `dueDate`, `currency`, `taskIds`, `items` (each replaces the whole set); optional `version`. Drafts only.

**Errors:** `409 invoice_not_draft`, `409 version_conflict`, `422 validation_failed`, `422 no_exchange_rate`

### `POST /accounts/invoices/:id/submit`, `/approve`, `/return`

As for vouchers: submit needs `invoice.update`; approve and return need `invoice.read` at the route, and `invoice.approve` or being today's stand-in in the service, never the maker (`403 own_record`). Approve records the receivable in the same transaction. Return takes `note`.

**Errors:** `409 invoice_not_draft`, `409 invoice_not_submitted`, `403 own_record`, `403 forbidden`, `409 version_conflict`

### `POST /accounts/invoices/:id/cancel`

**Access:** `private`, needs `invoice.read`; a draft needs `invoice.update`, an issued invoice needs `invoice.approve` or the stand-in, never its maker.

**Body:** `reason`, optional `version`. An issued invoice is reversed in the ledger, dated today. Its tasks are freed.

**Errors:** `409 invoice_has_receipts` (reverse them first), `409 invoice_not_draft` for one already cancelled or still submitted

### `POST /accounts/invoices/:id/receive-payment`

**Access:** `private`, needs `journalVoucher.create` (the result is a receipt voucher) and `invoice.read`

**Body:** `receivedDate`, `moneyAccountId` (cash or a bank account), optional `amount` in the invoice's currency (all that is still open when left out), `reference`.

**Returns:** `201` with a draft **receipt voucher** (`RV-…`) linked to the invoice (`linkedDocument`). It reaches the books when someone other than its maker approves it. Its lines: Dr the bank at the rate on the received date; Cr 1300 Accounts receivable at the invoice's rate (worked out on the running total, so the last receipt clears exactly what was recorded); the difference to 4200 Exchange gain or 5800 Exchange loss.

**Errors:** `409 invoice_not_issued`, `409 nothing_owed`, `422 more_than_owed` (counting receipts waiting for approval), `422 no_exchange_rate`

### `GET /accounts/invoices/:id/history`

**Access:** `private`, needs `invoice.read`. Changes newest first, with each edit's `reason`.

## Vendors

### `GET /accounts/vendors`, `GET /accounts/vendors/:id`, `GET /accounts/vendors/:id/history`

**Access:** `private`, needs `vendor.read`. The list takes `page`, `pageSize`, `category`, `isActive` (`true` or `false`), `search` (part of the name).

### `POST /accounts/vendors`

**Access:** `private`, needs `vendor.create`

**Body:** `name`, `category` (`rent`, `cloud`, `utilities`, `equipment`, `food_and_events`, `other`), `tdsBasisPoints` (tax deducted at source from their bills: `500` is 5%), optional `contactEmail`, `contactPhone`.

### `PATCH /accounts/vendors/:id`

**Access:** `private`, needs `vendor.update`

**Body:** any of the above (`null` clears a contact), `isActive`; optional `version`. A vendor is deactivated, never deleted. A new TDS rate applies to bills saved after it.

## Bills

Money owed to a vendor, in taka. Each line is quantity (up to 3 decimals) × unit price, rounded to the paisa, and names the expense or asset account it is charged to. TDS is the vendor's rate on the total, rounded to the paisa; the vendor is owed the rest (`netPayable`). Numbers run `B-0001`.

| Status | Means | Next |
|---|---|---|
| `draft` | Being written | Edit (with a reason), submit, cancel |
| `submitted` | Waiting for someone other than its maker | Approve (records it), return with a note |
| `recorded` | Dr each line's account; Cr 2100 Accounts payable the net; Cr 2300 VAT and tax payable the TDS | Pay; cancel with a reversal while it has no payments |
| `cancelled` | Given up, or reversed in the ledger | None |

A recorded bill shows `paid`, `outstanding`, `pending`, `paymentStatus` and `daysOverdue`, worked out from the payment vouchers linked to it, as for invoices.

### `GET /accounts/bills`

**Access:** `private`, needs `bill.read`. **Query:** `page`, `pageSize`, `status`, `paymentStatus`, `vendorId`, `from`, `to` (bill dates), `search` (the start of a number, or part of the vendor's name or reference).

### `POST /accounts/bills`

**Access:** `private`, needs `bill.create`

**Body:** `vendorId` (active), optional `vendorReference`, `billDate`, optional `dueDate` (on or after the bill date; defaults to it), `lines` (1 to 200, each `description`, `accountId`, `quantity`, `unitPrice` in paisa), optional `vatCode` (a tax rate code from Settings, such as `VAT15`). The lines are checked as the ledger will check them.

VAT and TDS are each a rate on the amount before tax, rounded to the paisa: `vat` = `amount` × the rate, and `netPayable` = `amount` + `vat` − `tds`. Recording a bill with VAT also writes Dr 1700 VAT and tax receivable, as VAT paid on purchases is claimed back. A bill made from a regular expense carries `regularExpense` (`id`, `period`).

**Errors:** `404 unknown_vendor`, `422 validation_failed` (an inactive vendor, an unknown or inactive account, a group account, a total of zero)

### `GET /accounts/bills/:id`

**Access:** `private`, needs `bill.read`. Returns the bill, `payments` and `allowedActions` (`edit`, `submit`, `approve`, `return`, `cancel`, `pay`).

### `PATCH /accounts/bills/:id`

**Access:** `private`, needs `bill.update`. **Body:** `reason` (required) and at least one of `vendorId`, `vendorReference` (empty removes it), `billDate`, `dueDate`, `lines`, `vatCode` (`null` removes the VAT); optional `version`. New lines, a new vendor or a VAT change price it again at the vendor's current TDS rate and the Settings VAT rate. Drafts only (`409 bill_not_draft`).

### `POST /accounts/bills/:id/submit`, `/approve`, `/return`, `/cancel`

As for invoices, with `bill.update` and `bill.approve`. Cancelling a recorded bill reverses it and is refused while it has payments (`409 bill_has_payments`).

### `POST /accounts/bills/:id/pay`

**Access:** `private`, needs `journalVoucher.create` (the result is a payment voucher) and `bill.read`

**Body:** `paymentDate`, `moneyAccountId` (cash or a bank account), optional `amount` in paisa (all that is open when left out), `reference`.

**Returns:** `201` with a draft **payment voucher** (`PV-…`) linked to the bill: Dr 2100 Accounts payable, Cr the bank. It reaches the books when someone other than its maker approves it.

**Errors:** `409 bill_not_recorded`, `409 nothing_owed`, `422 more_than_owed`

### `GET /accounts/bills/:id/history`

**Access:** `private`, needs `bill.read`.

## Payments linked to invoices and bills

A receipt or payment voucher made by Receive payment or Pay carries `linkedDocument` (`type`, `id`, `number`, `amount` in the document's currency, and `amountDue`: what the document was owed in all when the voucher was made, checked again on approval). It can't be edited (`409 linked_voucher`) or corrected by an update request (`409 linked_voucher`): a wrong one is returned to its maker or reversed, and a new one made from the document. A reversed voucher no longer counts as paid, so the document opens again.

The accounts these post to are the starting chart's 1300, 2100, 2300, 4100, 4200 and 5800, named in one place (`accounts/postingAccounts.ts`). Choosing them in Settings is not built yet.

## Payroll

Monthly payroll on the dummy employees (`seed/accounts-employees.json`) until HR is built. A run (`PR-0001`) is made from the active employees for one month: each is paid their monthly salary, or for someone who joined during the month, the share of calendar days from their join date, rounded to the paisa. Each person's unpaid leave comes off their gross, and each loan instalment due comes off their pay (see Loans and advances); the run's `netTotal` is what the bank pays. Tax and provident fund deductions come later in Day 5. One run per month that isn't cancelled (`409 payroll_month_taken`).

| Status | Means | Next |
|---|---|---|
| `draft` | Made from the employees | Edit (with a reason), submit, cancel |
| `submitted` | Waiting for someone other than its maker | Approve, return with a note |
| `recorded` | Dr 5100 Salaries and wages per person (gross); Cr 1400 Employee advances and loans per loan repaid; Cr 2200 Salaries payable the net, dated the pay date | Pay; cancel with a reversal while it has no payments |
| `cancelled` | Given up, or reversed; the month can be run again | None |

**Protected field:** `payrollRun.lines` (each person's pay) is hidden in runs and their history unless the grant's `fieldAccess` names it; changing a person's pay needs `edit` on it. `total` and `headcount` show to anyone who can read payroll. A recorded run shows `paid`, `outstanding`, `pending` and `paymentStatus`, worked out from linked payment vouchers, overdue from the day after the pay date.

### `GET /accounts/payroll-runs`, `GET /accounts/payroll-runs/:id`, `GET /accounts/payroll-runs/:id/history`

**Access:** `private`, needs `payrollRun.read`. The list takes `page`, `pageSize`, `status`. One run adds `payments` and `allowedActions` (`edit`, `submit`, `approve`, `return`, `cancel`, `pay`).

### `POST /accounts/payroll-runs`

**Access:** `private`, needs `payrollRun.create`. **Body:** `month` (`YYYY-MM`), `payDate`.

**Errors:** `409 payroll_month_taken`, `422 no_employees`

### `PATCH /accounts/payroll-runs/:id`

**Access:** `private`, needs `payrollRun.update` (and `edit` on `lines` for adjustments). **Body:** `reason` (required) and `payDate` and/or `adjustments` (each `employeeId` on the run, `gross` in paisa, optional `note`; a gross of 0 takes them off this run); optional `version`. Drafts only.

**Errors:** `403 field_not_editable`, `409 payroll_run_not_draft`, `422 validation_failed`

### `POST /accounts/payroll-runs/:id/submit`, `/approve`, `/return`, `/cancel`

As for bills, with `payrollRun.update` and `payrollRun.approve`; never by the maker (`403 own_record`). Cancelling a recorded run reverses it and is refused while it has payments (`409 payroll_run_has_payments`). Errors use `payroll_run_not_draft`, `payroll_run_not_submitted`.

### `POST /accounts/payroll-runs/:id/pay`

**Access:** `private`, needs `journalVoucher.create` and `payrollRun.read`. **Body:** `paymentDate`, `moneyAccountId`, optional `amount` (all that is open when left out), `reference`.

**Returns:** `201` with one draft **payment voucher** for the run: Dr 2200 Salaries payable, Cr the bank, linked to the run (`linkedDocument.type: payrollRun`).

**Errors:** `409 payroll_run_not_recorded`, `409 nothing_owed`, `422 more_than_owed`

## Disbursements

Every payment going out is a payment voucher, so the Disbursements screen is `GET /accounts/journal-vouchers?type=payment`. No route of its own.

## Fixed assets

The register of things the company owns and uses for years. A purchase reaches the books through a bill charged to 1600 Fixed assets; the register adds what depreciation needs. Numbers run `FA-0001`.

**Depreciation** is straight-line, monthly, from the purchase month: (cost − salvage value) ÷ useful life in whole paisa, the last month taking what rounding left, so the months add up exactly. Depreciation reaches the books only through a month's **depreciation run**: one journal voucher for all active assets, Dr 5600 Depreciation, Cr 1650 Accumulated depreciation, each credit line naming its asset (`FA-0001`). An asset's `accumulatedDepreciation` and `bookValue` are read back from recorded runs. Each month has at most one run that isn't reversed; reversing it frees the month.

### `GET /accounts/fixed-assets`, `GET /accounts/fixed-assets/:id/history`

**Access:** `private`, needs `fixedAsset.read`. The list takes `page`, `pageSize`, `category`, `isActive`, `search` (number, name or tag). Each asset shows `monthlyDepreciation`, `accumulatedDepreciation`, `bookValue`.

### `GET /accounts/fixed-assets/:id`

Adds `schedule`: each month of its life with `amount`, `monthLabel`, and `voucher` (`voucherId`, `number`, `status`) when that month has a run.

### `POST /accounts/fixed-assets`

**Access:** `private`, needs `fixedAsset.create`. **Body:** `name`, optional `assetTag`, `category` (`computers`, `furniture`, `office_equipment`, `vehicles`, `software`, `other`), `purchaseDate`, `cost` (paisa, above zero), `salvageValue` (not above the cost), `usefulLifeMonths` (1 to 600), optional `billId`.

### `PATCH /accounts/fixed-assets/:id`

**Access:** `private`, needs `fixedAsset.update`. Any of the above and `isActive`; optional `version`. Cost, purchase date, salvage value and life are refused once any of its depreciation is recorded or waiting (`409 asset_depreciated`).

### `GET /accounts/fixed-assets/depreciation`

**Access:** `private`, needs `fixedAsset.read`. **Query:** `month`. **Returns:** `lines` (`assetId`, `number`, `name`, `amount`), `total`, and `existingRun` when the month has one.

### `POST /accounts/fixed-assets/depreciation`

**Access:** `private`, needs `fixedAsset.update`, and `journalVoucher.create` (checked in the service). **Body:** `month`, optional `voucherDate` (the month's last day by default).

**Returns:** `201` with the draft journal voucher (`linkedDocument.type: depreciation`, `number: DEP 2026-11`). It can't be edited; it reaches the books when someone other than its maker approves it.

**Errors:** `403 forbidden` (no voucher access), `409 depreciation_month_taken`, `422 nothing_to_depreciate`

## Inventory

Office stock counted in units: quantities only, since what it cost reaches the books through its bill. Stock on hand is worked out from the item's movements, never typed. No return to vendors (decision 5).

### `GET /accounts/inventory-items`, `GET /accounts/inventory-items/:id`

**Access:** `private`, needs `inventoryItem.read`. The list takes `page`, `pageSize`, `isActive`, `search` (name, tag or category). Each item shows `onHand` and `isLow` (at or below its reorder level). One item adds `movements`, newest first.

### `POST /accounts/inventory-items`

**Access:** `private`, needs `inventoryItem.create`. **Body:** `name`, optional `assetTag`, `category`, `unit` (such as pcs or boxes), optional `reorderLevel`.

### `PATCH /accounts/inventory-items/:id`

**Access:** `private`, needs `inventoryItem.update`. Any of the above (`null` clears the tag or reorder level) and `isActive`; optional `version`.

### `POST /accounts/inventory-items/:id/movements`

**Access:** `private`, needs `inventoryItem.update`. **Body:** `date`, `kind` (`in`, `out`, `adjust`), `quantity` (up to 3 decimals; above zero for in and out; signed for adjust), optional `note`, `reference`. Movements are never edited; a mistake is put right by an adjustment.

**Returns:** `201` with the item and its movements.

**Errors:** `409 inventory_item_inactive`, `422 not_enough_stock`, `422 validation_failed`

## General ledger and trial balance

### `GET /accounts/general-ledger`

**Access:** `private`, needs `ledgerAccount.read`

**Query:** `accountId`, `from`, `to` (entry dates, inclusive), `page`, `pageSize`

**Returns:** `account` (`id`, `code`, `name`, `type`, `normalBalance`), `opening` (the balance before `from`), `totalDebit`, `totalCredit`, `closing`, `payPerPersonHidden`, `total` (lines in the period), and `lines`, oldest first: `entryId`, `entryDate`, `memo` (the line's, or the entry's), `entryMemo`, `source` (`type`, `id`, `number` such as `PV-0001`), `isReversal`, `debit`, `credit`, `balance` (running, debits minus credits, carried across pages). Read straight from ledger entries, so an account's `closing` over all dates equals its trial balance figure.

A payroll run records one salary line per person. When the caller's profile hides the payroll run's `lines` field (each person's pay), `payPerPersonHidden` is `true` and each payroll entry's lines on the account are added into one line, with the entry's memo (`PR-0001 salaries, November 2026`). Totals, `closing`, `total` and running balances are the same either way.

**Errors:** `404 unknown_ledger_account`, `422 validation_failed` (`to` before `from`)

### `GET /accounts/trial-balance`

**Access:** `private`, needs `ledgerAccount.read`. **Query:** optional `to` (entries up to and including it).

**Returns:** `rows` (`accountId`, `code`, `name`, `type`, `debit`, `credit`, `balance`), `totalDebit`, `totalCredit`, `difference` (always 0).

## Reports and dashboard

The four financial reports and the Accounts dashboard, read straight from ledger lines, so they always agree with the trial balance and a reversed entry nets out. Amounts are paisa on each account's normal side (income, liabilities and equity as positive credits; assets and expenses as positive debits). All need `ledgerAccount.read`, like the trial balance, so no new permission is needed. The financial year runs July to June. Each report section is `key`, `label`, `rows` (`accountId`, `code`, `name`, `amount`, accounts with nothing on them left out) and `total`.

### `GET /accounts/reports/profit-and-loss`

**Query:** `from`, `to` (entry dates, inclusive). **Returns:** `income` and `expenses` sections, `netProfit` (income less expenses). **Errors:** `422 validation_failed` (a missing date, or `to` before `from`).

### `GET /accounts/reports/balance-sheet`

**Query:** `to`. **Returns:** `financialYear`, `assets`, `liabilities`, `equity` (the equity accounts' rows, plus `profitRows`: `earlierProfit` and `yearProfit`, profit not yet closed into equity, left out when zero; `total` includes them), `totalLiabilitiesAndEquity`, and `difference` (assets less liabilities and equity, always 0). **Errors:** `422 validation_failed`.

### `GET /accounts/reports/cash-flow`

**Query:** `from`, `to`. **Returns:** `opening` (cash and bank before `from`), `sections` (`operating` "Running the business", `investing` "Buying and selling assets" for fixed assets, `financing` "Owners and financing" for equity), `netChange`, `closing`, and `difference` (closing less opening less the net change, always 0). The direct method: each movement in a cash or bank account is listed under the account on the other side of its entry, money in positive. Transfers between cash and bank accounts drop out. **Errors:** `422 validation_failed`.

### `GET /accounts/dashboard`

**Query:** `month` (YYYY-MM). **Returns:** `from`, `to` (the month's days), `financialYear`, `cash` (`accounts`: each cash and bank account's balance at the month end, and `total`), `receivable` (1300) and `payable` (2100) at the month end, `thisMonth` and `yearToDate` (`income`, `expenses`, `profit`), `trend` (each month of the financial year up to this one, with the same three figures) and `topExpenses` (the month's five largest expense accounts). **Errors:** `422 validation_failed`.

## Export center

Every list and report as a CSV file, for a spreadsheet or the auditors. Each dataset loads its rows through the service its screen uses, so it holds only what the person may read, and needs that screen's read permission. A column for a protected field (such as a bank account number) is left out, header and all, when the profile hides the field; a dataset made only of a protected field (salary per person, from payroll runs' `lines`) is not offered at all. Money is taka with two decimals; text that would start a spreadsheet formula (`=`, `+`, `-`, `@`) is written with a leading `'`. Every download is written to the audit log as `accounts.exported`.

### `GET /accounts/exports`

**Access:** `private`, needs any one of the datasets' read permissions. **Returns:** `datasets` the person may download: `key`, `label`, `group` (Reports, Books, Receivables, Payables, People money, Tax and assets) and `period` (`range` needs `from` and `to`, `date` needs `to`, `year` takes `year` and defaults to this financial year, `none` takes nothing).

### `GET /accounts/exports/:dataset`

**Access:** `private`, as above, then the dataset's own permission. **Query:** `from`, `to`, `year`, as the dataset's `period` says. **Returns:** `text/csv` with a byte order mark and CRLF line ends, as an attachment named after the dataset and its period, such as `profit-and-loss-2026-11-01-to-2026-11-30.csv`.

Datasets: `profit-and-loss`, `balance-sheet`, `cash-flow`, `trial-balance`, `chart-of-accounts`, `vouchers`, `invoices`, `vendors`, `bills`, `regular-expenses`, `payroll-runs`, `salaries`, `staff-payouts`, `loans`, `tax-filings`, `budget`, `fixed-assets`, `inventory`.

**Errors:** `403 forbidden` (no permission for the dataset), `403 field_hidden` (the dataset is made of a field the profile hides), `404 unknown_export`, `422 validation_failed` (a missing date, or `to` before `from`).

## Assistant tools (MCP)

Read-only Accounts tools on Master's MCP server (`POST /mcp`), for Claude or any MCP client signed in as the person. Each needs `ledgerAccount.read` in Accounts, like the reports, and answers in paisa: `accounts_dashboard` (`month`), `accounts_cash_and_bank` (`from`, `to`, this month if left out), `accounts_trial_balance` (`to`), `accounts_profit_and_loss` (`from`, `to`), `accounts_balance_sheet` (`to`) and `accounts_cash_flow` (`from`, `to`). None of them changes anything.

## Client accounts

What each client was billed, paid and still owes, worked out from issued invoices and the recorded receipts linked to them. Amounts are in taka at each invoice's issue rate, as the books recorded them, so the total outstanding equals the 1300 Accounts receivable balance.

### `GET /accounts/client-accounts`

**Access:** `private`, needs `invoice.read`

**Returns:** `ageingBuckets` (`notYetDue`, `days1To30`, `days31To60`, `over60` with labels), `totals` (`billed`, `received`, `outstanding`, `ageing`), and `clients` (active clients with issued invoices): `clientId`, `clientName`, `invoiceCount`, `billed`, `received`, `outstanding`, `overdueCount`, `ageing`, `lastPayment`, `averageDaysToPay` (issue to last receipt, over paid invoices), `rating` (`watch` when any invoice is overdue, otherwise `good`).

### `GET /accounts/client-accounts/:id`

**Access:** `private`, needs `invoice.read`

**Returns:** `client`, the same summary as above, `lines` (invoices and receipts by date: `kind`, `number`, `currency`, `amount` in the invoice currency, `charge` and `payment` in taka, `balance` owed after it) and `dueSoon` (invoice numbers due within 30 days).

**Errors:** `404 unknown_client`

## Bank reconciliation

A bank's statement, loaded from its CSV (decision 8), matched line by line against the account's ledger entries. The books are never changed here: a line the books don't have yet, such as a bank charge, is recorded with an ordinary voucher, then matched. A sample statement is in `docs/samples/city-bank-statement-november-2026.csv`.

**The CSV:** a header row decides the columns: a date (`Date`, `Transaction date`, `Value date`…), a description (`Description`, `Narration`, `Particulars`…), an optional reference (`Reference`, `Cheque No`…), and either one signed `Amount` column or separate money in (`Credit`, `Deposit`) and money out (`Debit`, `Withdrawal`) columns. Dates may be `2026-11-03`, `03/11/2026` or `03-11-2026` (day first). Amounts may use commas, `Tk`, or brackets for minus. Rows with no amount (a balance line) are skipped; any other bad row refuses the file, naming it (`422 invalid_statement`).

**Matching:** a statement line matches a ledger entry on the account that moves exactly the same amount (money in as a debit), the nearest in date within 7 days. An entry matches one line on one statement only.

**The summary:** `closingBalance` should equal `bookBalance` (the ledger at `to`) plus `inBankNotBooks` (unmatched statement lines) less `inBooksNotBank` (entries the bank hasn't cleared by `to`, such as a cheque not yet presented). `difference` is what is left unexplained.

**Which entries count:** every entry on the account from the start of its earliest statement up to `to`, other than those matched on an earlier statement of the same account. So a cheque written in one month and presented in the next is matched on the next month's statement, and a reconciled statement stays as it was when a later one matches its open items. Entries before the first statement are in its opening balance. A transfer between two bank accounts is matched once on each account.

### `GET /accounts/bank-reconciliations`

**Access:** `private`, needs `bankReconciliation.read`. **Query:** optional `accountId`. **Returns:** `statements` (`id`, `number` BR-0001, `accountId`, `from`, `to`, `closingBalance`, `lineCount`, `matchedCount`, `status`) and `lastReconciled` (account id to the last reconciled statement's end date).

### `POST /accounts/bank-reconciliations`

**Access:** `private`, needs `bankReconciliation.create`

**Body:** `accountId` (cash or bank), `from`, `to`, `openingBalance` and `closingBalance` (paisa, as the statement says), `csv` (the file's text), optional `fileName`. Opening plus the lines must equal closing, and every line must fall in the period.

**Returns:** `201` with the statement as below, already matched where it can be.

**Errors:** `422 statement_does_not_add_up`, `422 invalid_statement`, `422 validation_failed`

### `GET /accounts/bank-reconciliations/:id`

**Access:** `private`, needs `bankReconciliation.read`. **Returns:** the statement, its `lines` (each with `matchedEntryId` and `matchedEntry` when matched), `unmatchedBookItems`, `summary` (`bookBalance`, `inBankNotBooks`, `inBooksNotBank`, `adjustedBookBalance`, `difference`, `matchedCount`, `unmatchedCount`) and `canComplete`.

### `POST /accounts/bank-reconciliations/:id/lines/:lineId/match`, `/unmatch`, `POST /accounts/bank-reconciliations/:id/rematch`

**Access:** `private`, needs `bankReconciliation.update`. Match takes `entryId`: an entry on the account for the same amount, not matched on another of this account's statements. Rematch matches unmatched lines again, such as after recording a bank charge.

**Errors:** `404 unknown_statement_line`, `409 line_matched`, `409 line_not_matched`, `409 entry_matched`, `409 statement_reconciled`, `422 validation_failed`

### `POST /accounts/bank-reconciliations/:id/complete`

**Access:** `private`, needs `bankReconciliation.update`. Signs it off once every line is matched and `difference` is 0. Entries the bank hasn't cleared may remain. A reconciled statement never changes.

**Errors:** `409 statement_has_unmatched_lines`, `409 reconciliation_difference`, `409 statement_reconciled`

## Office expenses

### `GET /accounts/office-expenses`

**Access:** `private`, needs `ledgerAccount.read`. **Query:** `from`, `to`.

**Returns:** `categories` (expense accounts with their net amount in the period), `total`, and `lines` newest first (`entryDate`, `accountId`, `memo`, `source` with its number, `isReversal`, `amount`). Every expense account counts except salaries, bonus and incentives, commission, depreciation and exchange loss (`NOT_OFFICE_EXPENSES` in `postingAccounts.ts`). Read from the ledger, so a reversal nets out. Expenses are added with a bill or a payment voucher.

## Bonus, incentive and commission

A **staff payout** (`BI-0001`) pays several people at once. It is drafted, submitted and approved by someone other than its maker like a bill; approving records Dr 5200 Bonus and incentives (5250 Commission for commission) per person, Cr 2200 Salaries payable; **Pay** makes one linked payment voucher.

| `kind` | People | Amounts |
|---|---|---|
| `incentive` | TwinTrack people | Project management's unpaid monthly incentives for `month` (taka there, converted to paisa). Approving marks each one paid in Project management in the same transaction; if any was paid meanwhile, nothing is recorded (`409 incentive_already_paid`). A person's month is on one live payout only, so **an incentive is paid once**. A recorded incentive payout can't be cancelled. |
| `bonus` | Payroll employees | Typed per employee. |
| `commission` | Payroll employees | Every employee's unpaid commission (below), with the receipts it is earned on; a receipt is paid once. |

### `GET /accounts/staff-payouts`, `GET /accounts/staff-payouts/:id`, `GET /accounts/staff-payouts/:id/history`

**Access:** `private`, needs `staffPayout.read`. The list takes `page`, `pageSize`, `kind`, `status`. One payout adds `payments` and `allowedActions` (`submit`, `approve`, `return`, `cancel`, `pay`).

### `POST /accounts/staff-payouts`

**Access:** `private`, needs `staffPayout.create`. **Body:** `kind` and: for `incentive`, `month` and `payDate`; for `bonus`, `title`, `payDate`, `lines` (each `employeeId`, `amount` in paisa, optional `note`); for `commission`, `payDate`.

**Errors:** `422 nothing_to_pay`, `422 validation_failed`

### `POST /accounts/staff-payouts/:id/submit`, `/approve`, `/return`, `/cancel`, `/pay`

As for payroll runs, with `staffPayout.update` and `staffPayout.approve`. Errors use `payout_not_draft`, `payout_not_submitted`, `payout_not_recorded`, `incentive_already_paid`, `incentive_payout_recorded`, `payout_has_payments`.

### Commission rules

Commission is earned on **money received**, not on invoices: each recorded receipt from the rule's client, dated on or after its start, earns the rate on what reached the bank (in taka), rounded to the paisa.

- `GET /accounts/commission-rules` (`commissionRule.read`): `rules`, each with `employeeName`, `clientName`, `rateBasisPoints`, `startDate`, `isActive`, `received`, `earned`, `inPayouts`, `unpaid`, and `items` (per receipt: `receiptNumber`, `date`, `invoiceNumber`, `received`, `commission`, `payoutNumber` when in a payout).
- `POST /accounts/commission-rules` (`commissionRule.create`): `employeeId`, `clientId`, `rateBasisPoints` (200 is 2%), `startDate`. One active rule per employee and client (`409 commission_rule_exists`).
- `PATCH /accounts/commission-rules/:id` (`commissionRule.update`): `rateBasisPoints`, `startDate`, `isActive`, `version`. Commission already in a payout keeps the amount it was paid at.

## Employee payments

### `GET /accounts/employee-payments`

**Access:** `private`, needs `payrollRun.read` or `staffPayout.read`. **Query:** optional `employeeId`, `from`, `to` (pay dates).

**Returns:** `employees` (the payroll employee list), `payments` newest first (`employeeId`, `employeeName`, `type` salary, bonus or commission, `forWhat`, `date`, `amount`, `record` with its number, `isPaid` when the whole run or payout is paid from the bank), `totals` per type, and `maySeeSalaries`. Salaries come from recorded payroll runs and show only with read access to the payroll run's protected `lines` field.

## Loans and advances

Money lent to an employee (`loan`, such as a house or laptop loan) or advanced on salary or for travel (`advance`), numbered `LN-0001`, repaid **only through payroll**. Approving records Dr 1400 Employee advances and loans, Cr 2200 Salaries payable; **Pay** makes a linked payment voucher that hands the money over. From `firstRepaymentMonth`, each payroll run takes `monthlyInstallment` from the person's pay (the last instalment takes what is left, and never more than they earn), crediting 1400 one line per loan. Only money actually paid out (recorded payment vouchers) is repaid: a loan approved but not yet handed over takes nothing from pay. `outstanding` is the amount less repayments in recorded payroll runs, so it always equals what 1400 says for the loan.

### `GET /accounts/employee-loans`, `GET /accounts/employee-loans/:id`, `GET /accounts/employee-loans/:id/history`

**Access:** `private`, needs `employeeLoan.read`. The list takes `page`, `pageSize`, `status`, `employeeId`. Each loan shows `lastRepaymentMonth`, `payout` (paid out to the employee), `repaid`, `repaymentPending` (in runs not yet recorded), `outstanding` and `repayments` (run, month, amount). One loan adds `schedule` (each planned month and amount, with `taken` from the run that repaid it), `payments` and `allowedActions`.

### `POST /accounts/employee-loans`

**Access:** `private`, needs `employeeLoan.create`. **Body:** `employeeId` (active), `kind`, `purpose`, `issueDate`, `amount` and `monthlyInstallment` (paisa; the instalment not above the amount), `firstRepaymentMonth` (`YYYY-MM`, not before the issue month).

### `POST /accounts/employee-loans/:id/submit`, `/approve`, `/return`, `/cancel`, `/pay`

As for payroll runs, with `employeeLoan.update` and `employeeLoan.approve`; never by the maker. Cancelling a recorded loan reverses it, and is refused once anything is paid out or repaid (`409 loan_in_use`). Errors use `loan_not_draft`, `loan_not_submitted`, `loan_not_recorded`.

## Unpaid leave

Kept in Accounts until HR is built. A month's payroll run takes each person's unpaid leave off their gross at a day's pay: monthly salary ÷ 30, rounded to the paisa, never more than they earn. The run's line shows `unpaidLeaveDays` and `leaveDeduction`.

### `GET /accounts/unpaid-leave`

**Access:** `private`, needs `unpaidLeave.read`. **Query:** `month`. **Returns:** `employees` (each active employee's `days`, `dailyRate`, `deduction`, `note`) and `total`.

### `PUT /accounts/unpaid-leave/:employeeId/:month`

**Access:** `private`, needs `unpaidLeave.update`. **Body:** `days` (whole or half days, 0 removes it), optional `note`. Refused once the month has a payroll run that isn't cancelled (`409 payroll_run_exists`): cancel the run, change the leave, make it again.

**Errors:** `404 unknown_employee`, `409 payroll_run_exists`, `422 validation_failed`

## Provident fund and gratuity

Payroll takes `providentFundBasisPoints` of each person's gross into the fund (`lines[].providentFund`) and the company adds the same; it also sets `gratuityBasisPoints` aside (`lines[].gratuity`). Recording a run writes both shares and the gratuity as staff cost (5100), Cr 2400 Provident fund payable for both shares and Cr 2500 Gratuity payable; net pay is gross less the employee share and loan repayments. Nothing is stored apart from the run lines, so the figures always agree with the books. Gratuity is paid when someone leaves, which isn't built yet.

### `GET /accounts/provident-fund`

**Access:** `private`, needs `providentFund.read`. **Query:** optional `year` (the calendar year the July to June financial year starts in; default the current one). Returns `months` (per recorded run: `members`, `employeeShare`, `companyShare`, `total`, `gratuity`, and `paid`, `outstanding`, `pending`, `paymentStatus` from its deposits), `employees` (each person's fund, both shares, and gratuity built up across every recorded run) and `totals`.

### `POST /accounts/provident-fund/:month/deposit`

**Access:** `private`, needs `journalVoucher.create`. **Body:** `paymentDate`, `moneyAccountId` (cash or bank), optional `reference`. Makes a draft payment voucher, Dr 2400, Cr the money account, linked to the month (`providentFund`), which someone else approves. **Errors:** `404 unknown_fund_month` (no recorded run), `409 nothing_owed` (deposited, or a deposit is waiting).

## Regular expenses

A cost that comes back each month or year, such as rent or a subscription. It never writes to the ledger itself: each period it makes a **draft bill** (decision 4), approved and paid like any bill. A period has at most one live bill: a unique key on the bill holds even when two people make bills at once, and cancelling the bill frees the period.

### `GET /accounts/regular-expenses`

**Access:** `private`, needs `regularExpense.read`. **Query:** optional `category`, `isActive`. Each expense has `nextDue` (the first period from this month on without a bill, with its date) and `latestBill`.

### `POST /accounts/regular-expenses`

**Access:** `private`, needs `regularExpense.create`. **Body:** `name`, `category` (`rent`, `cloud_software`, `utilities`, `office_services`, `food_events`, `travel`, `insurance`, `government_fees`), `vendorId` (active), `accountId` (an active expense account), `frequency` (`monthly` or `yearly`; a yearly one falls in its start month), `amount` (paisa per period, before VAT), optional `vatCode`, `dayOfMonth` (1 to 28: each bill's date and due date), `startMonth`, optional `endMonth`.

### `PATCH /accounts/regular-expenses/:id`, `GET /accounts/regular-expenses/:id/history`

**Access:** `private`, needs `regularExpense.update` (history: `regularExpense.read`). Any field above, `isActive` to stop or restart it, `null` for `vatCode` or `endMonth` to remove them, optional `version`. Bills already made keep what they were made with. **Errors:** `404 unknown_regular_expense`.

### `POST /accounts/regular-expenses/bills`

**Access:** `private`, needs `bill.create`. **Body:** `month`. Makes the draft bill for each active expense due in the month that has none. Returns `made` (the bills) and `skipped` (each with a `reason`: already billed, or an inactive vendor or unknown VAT rate). Running it again makes nothing new.

## Office rent

### `GET /accounts/office-rent`

**Access:** `private`, needs `bill.read`. **Query:** optional `year`. The rent agreements (regular expenses in the `rent` category) and their bills dated in the financial year, with `totals`: `monthly` (active monthly rent), `charged` (recorded rent bills before VAT), `paid` and `owed`.

## Tax and VAT

Worked out each month from recorded bills, never stored. TDS withheld from vendors is owed to the tax authority (2300), due by the 7th of the next month, and paid with a challan. VAT on purchases (1700) is claimed back, so it is listed for the return (due by the 15th), not paid. Rates are set in Settings and per vendor; there is no challan format (decision 6). Income tax on salaries isn't built yet.

### `GET /accounts/tax-filings`

**Access:** `private`, needs `taxFiling.read`. **Query:** optional `year`. Returns `filings`, newest first, one `vendor_tds` and one `vat_purchases` per month up to this month (`base`, `amount`, `dueDate`; TDS also has `paid`, `outstanding`, `pending`, `paymentStatus`), the Settings `taxRates` and `totals` (`tdsWithheld`, `tdsToPay`, `vatToClaim`).

### `POST /accounts/tax-filings/:month/pay`

**Access:** `private`, needs `journalVoucher.create`. **Body:** `paymentDate`, `moneyAccountId`, `challanNumber` (kept as the voucher's reference). Makes a draft payment voucher, Dr 2300, Cr the money account, linked to the month (`taxFiling`), which someone else approves. **Errors:** `409 nothing_owed`.

## Budget against actual

One budget per financial year (July to June), an amount per expense account. Actual comes from the ledger (bills, payroll, vouchers, reversals netting out), and bills still in draft or waiting for approval count as `pending`, so spending is flagged before it is recorded. `status` is `under`, `near_limit` (90% or more used), `over`, or `unbudgeted` (spending with no budget).

### `GET /accounts/budgets/:year`

**Access:** `private`, needs `budget.read`. Returns `lines` (each expense account with a budget or spending: `budget`, `actual`, `pending`, `used`, `difference`, `usedBasisPoints`, `status`), `totals` and the budget's `version`.

### `PUT /accounts/budgets/:year`

**Access:** `private`, needs `budget.update` (the specification gives it to the CEO; that is a profile choice). **Body:** `lines` (each `accountId`, an expense account, and `amount` for the year; `0` removes it), optional `version`. Replaces the year's lines whole. **Errors:** `422 validation_failed` (not an expense account, listed twice), `409 version_conflict`.

## Activity log

### `GET /accounts/cash-bank`

**Access:** `private`, needs `ledgerAccount.read`

The Cash and bank screen: every account marked `cashOrBank`, with figures worked out from ledger lines only. A balance is never typed in; an opening balance is a journal voucher between the account and `3900 Opening balance equity`.

**Query:** `from` and `to` (`YYYY-MM-DD`). Default: the first of this month to today.

**Returns:** `from`, `to`, `accounts` and `totals`. Each account: `id`, `code`, `name`, `cashOrBank`, `bankName`, `bankAccountNumber` (protected, as in the chart), `isActive`, and in paisa `opening` (debits minus credits dated before `from`), `moneyIn` (debits from `from` to `to`), `moneyOut` (credits in the period) and `balance` (`opening + moneyIn - moneyOut`). A reversal counts as money moving back. Inactive accounts are left out unless they had money in the period. `totals` sums the four figures.

**Errors:** `422 validation_failed` for a date that isn't real, or `to` before `from`.

### Update requests

A recorded voucher is never edited. To correct one, someone asks with an update request, and someone else approves it. Applying a request, in one transaction, reverses the voucher's ledger entry (dated today), records the corrected entry (on the corrected date), and saves the voucher with the new details and a history entry; the voucher keeps its number and stays `recorded`. Only one request per voucher may wait at a time. The requester can't approve or reject their own request, super admins included; the approve permission or being today's stand-in approver is needed. Waiting requests appear in `GET /accounts/approvals` as type `updateRequest`.

Each request returns `id`, `number` (`UR-0001`), `recordType` (`journalVoucher`), `recordId`, `recordNumber`, `reason`, `before` and `after` (each `voucherDate`, `memo`, `lines`, `total` in paisa), `status` (`waiting`, `applied`, `rejected`), `createdBy`, `createdAt`, `decidedBy`, `decidedAt`, `rejectionNote`, and once applied `reversalEntryId` and `correctedEntryId`.

### `GET /accounts/update-requests`

**Access:** `private`, needs `updateRequest.read`

**Query:** `page`, `pageSize`, `status`, `recordId`

**Returns:** `requests`, newest first, `total`, `page`, `pageSize`, and `summary` for the screen's tiles: `waiting`, `appliedThisWeek` (last 7 days), `rejected`, `averageReviewMinutes` (asking to a decision, over every decided request; `null` when none). Only requests about record types the caller can read are counted or listed.

### `POST /accounts/update-requests`

**Access:** `private`, needs `updateRequest.create`, and `journalVoucher.read` (checked in the service)

**Body:** `recordType` (`journalVoucher`), `recordId`, `reason` (1 to 1000 characters), `changes` with at least one of `voucherDate`, `memo`, `lines` (checked like a new voucher's: balanced, active accounts that group nothing; a payment's lines must still credit its cash or bank account, and a receipt's still debit it, or `422 validation_failed` on `changes.lines`). Parts left out stay as recorded.

**Returns:** `201` with the request, `waiting`.

**Errors:**

| Status and code | When |
|---|---|
| `403 forbidden` | The caller can't read vouchers |
| `404 unknown_journal_voucher` | No such voucher |
| `409 record_not_recorded` | The voucher is a draft, waiting or reversed; drafts are edited directly |
| `409 update_request_already_waiting` | Another request for this voucher is waiting |
| `422 unbalanced_entry`, `422 validation_failed` | The corrected lines are invalid |
| `422 no_change` | The corrected voucher is the same as the recorded one |

### `GET /accounts/update-requests/:id`

**Access:** `private`, needs `updateRequest.read`

**Returns:** the request, plus `allowedActions` (`approve`, `reject`) for the caller.

**Errors:** `403 forbidden` (the caller can't read the record type the request is about), `404 unknown_update_request`

### `POST /accounts/update-requests/:id/approve`

**Access:** `private`, needs `updateRequest.read`; the service also needs `updateRequest.approve` or being today's stand-in approver, and refuses the requester.

**Body:** optional `version`.

**Returns:** the request, `applied`.

**Errors:** `403 own_record`, `403 forbidden`, `404 unknown_update_request`, `409 update_request_not_waiting`, `409 voucher_not_recorded` (the voucher was reversed after the request; nothing is applied and the request stays waiting), `409 version_conflict`, and the ledger's `422` errors when an account in the corrected lines was closed since.

### `POST /accounts/update-requests/:id/reject`

**Access:** as approve.

**Body:** `note` (why, 1 to 1000 characters), optional `version`.

**Returns:** the request, `rejected`. Nothing in the books changes, and a new request for the voucher may be made.

**Errors:** as approve, without the ledger errors.

### `GET /accounts/change-history`

**Access:** `private`, needs `journalVoucher.read` or `updateRequest.read`

Every change to a recorded voucher after it reached the books, newest first: reversals (shown with `journalVoucher.read`) and corrections (applied update requests, shown with both `journalVoucher.read` and `updateRequest.read`, since they show the voucher before and after). Up to 200 of each.

**Returns:** `entries`, each `kind` (`correction` or `reversal`), `at`, `recordType`, `recordId`, `recordNumber`, `request` (`{ id, number }`, corrections only), `reason`, `changes` (`field` of `voucherDate`, `memo`, `total` or `lines`, with `from` and `to`; a reversal shows the total going to `0`), `askedBy` (corrections only) and `approvedBy`.

### `GET /accounts/approvals`

**Access:** `private`, needs any of `journalVoucher.read` or `updateRequest.read` (the read permission of each record type that waits for approval; bills and payroll runs will join the list)

The one approvals queue. Only record types the caller can read are included.

**Returns:**

- `waitingForYou`: `{ total, items }`, records submitted for approval that the caller may decide now. Never records they made, super admins included, and only types whose approve permission they hold, unless they are today's stand-in approver from Settings.
- `yoursWaiting`: `{ total, items }`, records the caller made that are waiting for someone else.

Each item: `type` (such as `journalVoucher`), `id`, `number`, `title`, `amount` (paisa), `date` (`YYYY-MM-DD`), `createdBy` (`{ id, name }`), `submittedAt`. Oldest submission first; up to 200 items per record type, with `total` counting all of them.

### `GET /accounts/audit-log`

**Access:** `private`, needs `auditLog.read`

**Query:** `page`, `pageSize`, `actionPrefix` (such as `journalVoucher.`)

**Returns:** `entries`, newest first, each with `at`, `actorName`, `action`, `targetType`, `targetId`, `targetName`, and `total`. Only entries the Accounts module wrote; Master's `/audit` shows everything and needs a Master permission.
