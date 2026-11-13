# Accounts API

The company's money: categories, vendors, bank accounts, bills, payments, receipts, invoices to clients, monthly payroll, and evidence documents. Every route starts with `/accounts`. Read the [getting-started guide](README.md) first for tokens, error format and errors every route can return.

## Getting access

A person reaches Accounts through their profile. No profiles ship with the product. Accounts records belong to the company, not to people, so its resources aren't scoped: a permission reaches every record.

| Permission | Lets someone |
|---|---|
| `category.read`, `.create`, `.update` | See and manage categories of income and spending |
| `vendor.read`, `.create`, `.update` | See and manage vendors |
| `bankAccount.read`, `.create`, `.update` | See and manage bank accounts, their balances and statements |
| `companyBankDetails.read`, `.update` | See and change the payment details printed on invoices |
| `bill.read`, `.create`, `.update`, `.delete` | See, record, change and submit bills; delete drafts and reverse approved ones |
| `bill.approve` | Approve or reject bills |
| `payment.read`, `.create`, `.delete` | See and post payments; `delete` reverses one |
| `receipt.read`, `.create`, `.update`, `.delete` | See and post receipts; `update` allocates them to invoices; `delete` reverses one |
| `invoice.read`, `.create`, `.update`, `.delete` | See, generate, change, email and delete draft invoices |
| `payrollRun.read`, `.create`, `.update`, `.delete` | See, make, change, submit and settle payroll runs; delete drafts |
| `payrollRun.approve` | Approve payroll runs, or send them back |
| `document.read`, `.create`, `.delete` | See and add evidence; `delete` removes evidence someone else added |

**Two people for money.** Whoever made a bill or payroll run can't approve, reject or return it (`403 own_record`), super admins included.

**Field access.** Vendors' `bankAccountNumber` and bank accounts' `accountNumber` are protected fields: stored encrypted with `ENCRYPTION_KEY`, and left out of answers unless a grant's `fieldAccess` gives `read` or more. Other fields follow the actions.

**Posted money is never edited.** A payment or receipt is corrected by a linked reversal dated the day it's made (`reversesId` on the reversal, `reversalId` on the original, `inEffect` on both), so bank balances on past dates never change. Bills, which aren't money moving, are reversed by status instead.

**Currencies** are `BDT` and `USD`. A bank account's currency never changes, and every payment and receipt through it is in that currency.

**Amounts** of money (bills, payments, receipts, bank fees, allocations and payroll deductions) are to the cent: one with more than two decimal places is refused with `422`.

## Categories, vendors and bank accounts

These are made inactive (`status: inactive`) rather than deleted, because posted money names them. New money can't use an inactive one.

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/categories` | `category.read` | `page`, `pageSize`, `status`, `search` | By code |
| `POST /accounts/categories` | `category.create` | `name`, `code`, `parentId` | `201`. Codes are stored in capitals and unique (`409 code_taken`). |
| `GET`, `PATCH /accounts/categories/:id` | `category.read`, `.update` | Any of `name`, `code`, `parentId`, `status`, and `version` | A parent can't be the category itself or below it |
| `GET /accounts/categories/:id/history` | `category.read` | `page`, `pageSize` | |
| `GET /accounts/vendors` | `vendor.read` | `page`, `pageSize`, `status`, `search` | By name |
| `POST /accounts/vendors` | `vendor.create` | `name`, and optionally `contactName`, `contactEmail`, `contactPhone`, `address`, `bankName`, `bankAccountNumber`, `notes` | `201` |
| `GET`, `PATCH /accounts/vendors/:id` | `vendor.read`, `.update` | Any of those, `status`, and `version`. An empty `bankAccountNumber` removes it. | |
| `GET /accounts/vendors/:id/history` | `vendor.read` | `page`, `pageSize` | The bank number's history isn't kept |
| `GET /accounts/bank-accounts` | `bankAccount.read` | `page`, `pageSize`, `status` | Each with `currentBalance` |
| `POST /accounts/bank-accounts` | `bankAccount.create` | `name`, `currency`, and optionally `bankName`, `accountNumber`, `openingBalance`, `openingDate` (default today) | `201` |
| `GET`, `PATCH /accounts/bank-accounts/:id` | `bankAccount.read`, `.update` | Any of `name`, `bankName`, `accountNumber`, `openingBalance`, `openingDate`, `status`, and `version` | |
| `GET /accounts/bank-accounts/:id/statement` | `bankAccount.read` | `from`, `to` | `openingBalance`, `closingBalance` and `entries`, each with `kind` (`receipt`, `receipt_reversal`, `payment`, `payment_reversal`, `salary`), `amount` (negative for money out) and `balance` after it. At most 2000 entries (`422 period_too_long`). |
| `GET /accounts/bank-accounts/:id/history` | `bankAccount.read` | `page`, `pageSize` | |
| `GET /accounts/company-bank-details` | `companyBankDetails.read` | | |
| `PATCH /accounts/company-bank-details` | `companyBankDetails.update` | Any of `bankName`, `accountName`, `accountNumber`, `branchName`, `routingNumber`, `swiftCode`, `address`, and `version` | Saves only the fields sent; an empty one is cleared |

**Balances** are never typed in. `currentBalance` is the opening balance plus receipts (after the bank's fee), less payments and paid salaries, from the start of the opening day, with reversals counted back.

## Bills

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──pay──▶ partially_paid ──pay──▶ paid
  │                     └──reject──▶ rejected        └──reverse──▶ reversed
  └──delete (recycle bin)
```

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/bills` | `bill.read` | `page`, `pageSize`, `status`, `vendorId`, `projectId`, `categoryId`, `overdue=true` | Newest business date first. Each with `paidAmount` and `outstandingAmount`. |
| `POST /accounts/bills` | `bill.create` | `vendorId`, `businessDate`, `currency`, `amount`, and optionally `billNumber`, `categoryId`, `projectId` (a Tasks project), `department`, `dueDate`, `taxCode`, `notes` | `201`, as a draft. The vendor and category must be active. |
| `GET /accounts/bills/:id` | `bill.read` | | `404 unknown_bill` |
| `PATCH /accounts/bills/:id` | `bill.update` | Any of those fields, and `version` | Drafts only (`409 invalid_status`) |
| `DELETE /accounts/bills/:id` | `bill.delete` | | Drafts only, to the recycle bin. `204`. |
| `POST /accounts/bills/:id/submit` | `bill.update` | | From `draft` |
| `POST /accounts/bills/:id/approve` | `bill.approve` | | From `pending_approval`. Not your own (`403 own_record`). |
| `POST /accounts/bills/:id/reject` | `bill.approve` | `reason` | From `pending_approval`. Not your own. |
| `POST /accounts/bills/:id/reverse` | `bill.delete` | `reason` | From `approved`. Reverse its payments first (`409 bill_has_payments`). |
| `GET /accounts/bills/:id/history` | `bill.read` | `page`, `pageSize` | |

## Payments

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/payments` | `payment.read` | `page`, `pageSize`, `bankAccountId`, `billId`, `payeeVendorId`, `payeeUserId`, `from`, `to` | Newest first |
| `POST /accounts/payments` | `payment.create` | `bankAccountId`, `payeeType` (`vendor`, `employee` or `other`), `amount`, `paymentDate`, `method` (`bank_transfer`, `cash`, `mobile_banking`, `cheque` or `card`), and the payee: `payeeVendorId`, `payeeUserId` or `payeeName`; optionally `billId`, `categoryId`, `projectId`, `department`, `reference`, `notes` | `201`. In the account's currency. Against a bill: the bill must be `approved` or `partially_paid` (`409 bill_not_payable`), in the same currency, `payeeType` `vendor` and the payee its vendor (taken from the bill when left out), and not paid beyond what's owed, checked in the payment's transaction so two payments at once can't overpay it. The bill's status follows in the same transaction. |
| `GET /accounts/payments/:id` | `payment.read` | | `404 unknown_payment` |
| `POST /accounts/payments/:id/reverse` | `payment.delete` | `reason` | `201`, the reversal. Once only (`409 already_reversed`); a reversal can't be reversed (`409 is_reversal`). |

## Invoices and receipts

Invoices bill clients for work in Tasks, at an hourly rate in US dollars unless `currency` says otherwise. A task is billed at its **estimate**, as the old app did, whatever hours it took. Two ways to choose the work:

- `clientId`: every task finished in the period, in all of the client's projects (`basis: completed`).
- `projectIds`: every task created in the period, at any status except cancelled, in chosen projects of one client, plus `customLines` (`basis: logged`).

A generated invoice marks its tasks billed (`invoiceId` on the task), so they leave the unbilled total; deleting a draft releases them. The task data is read through `modules/tasks/billing/taskBilling.ts`, the only part of Tasks that Accounts touches. Projects' allocated hours aren't changed. Invoice numbers are `INVOICE_NUMBER_PREFIX`, the client's initials (from Master, or worked out from the name) and the date, such as `INV-AL-02-10-26`, with `-2`, `-3`... for more on the same day.

Each invoice has an editable Word document (`.docx`), laid out as the old app's, with the price columns left for whoever sends it to fill in. It's made again when lines or notes change (`documentVersion`).

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/invoices` | `invoice.read` | `page`, `pageSize`, `status`, `clientId` | Each with `paidAmount` and `outstandingAmount` from receipts |
| `POST /accounts/invoices` | `invoice.create` | `clientId` or `projectIds`, `from`, `to` (at most 366 days), and optionally `hourlyRate` (default `INVOICE_HOURLY_RATE_USD`, so required when `currency` isn't `USD`), `currency`, `customLines` (`projectId`, `description`, `hours`, `billable`), `additionalNotes` | `201`, as a draft with its lines. `422 nothing_to_invoice` when there is no work. |
| `GET /accounts/invoices/unbilled` | `invoice.read` | | `totalHours` and `projects`: billable estimated hours of finished tasks no invoice has billed |
| `GET /accounts/invoices/preview` | `invoice.read` | `clientId` or `projectIds` (comma-separated), `from`, `to`, `hourlyRate` | The lines it would bill, each with `status` and `alreadyInvoicedBy` |
| `GET /accounts/invoices/:id` | `invoice.read` | | With `lines` (`custom` marks a line that wasn't a task) |
| `PATCH /accounts/invoices/:id` | `invoice.update` | `status`, `additionalNotes`, `version` | Status moves draft → sent → paid, and paid → sent. Never back to draft. |
| `DELETE /accounts/invoices/:id` | `invoice.delete` | | Drafts only, with no receipt allocated (`409 invoice_allocated`). `204`. |
| `PATCH /accounts/invoices/:id/lines` | `invoice.update` | `hourlyRate`, `lines` (`id`, `description`, `hours`, `billable`), `version` | Drafts only. Totals follow, and always equal the sum of the lines. Tasks don't change. `409 invoice_allocated` if the new amount is below what receipts already count against it. |
| `GET /accounts/invoices/:id/document` | `invoice.read` | | A short-lived `url` to download the document |
| `POST /accounts/invoices/:id/send` | `invoice.update` | `to` (default the client's contact email), `subject`, `message` | Emails the document as an attachment through Resend and marks a draft `sent` |
| `GET /accounts/invoices/:id/history` | `invoice.read` | `page`, `pageSize` | |
| `GET /accounts/receipts` | `receipt.read` | `page`, `pageSize`, `bankAccountId`, `clientId`, `from`, `to` | Each with `allocations`, `allocatedAmount`, `unallocatedAmount` |
| `POST /accounts/receipts` | `receipt.create` | `bankAccountId`, `amount` (what the client paid), `receivedDate`, `method`, and optionally `clientId`, `bankFee`, `reference`, `notes` | `201`. `netAmount` is what reached the bank. |
| `GET /accounts/receipts/:id` | `receipt.read` | | `404 unknown_receipt` |
| `POST /accounts/receipts/:id/allocations` | `receipt.update` | `invoiceId`, `amount`, `version` | The invoice must be in the receipt's currency and, if the receipt names a client, theirs. Never beyond what's left on the receipt or owed on the invoice. |
| `DELETE /accounts/receipts/:id/allocations/:allocationId` | `receipt.update` | | |
| `POST /accounts/receipts/:id/reverse` | `receipt.delete` | `reason` | `201`. Remove its allocations first (`409 receipt_allocated`). |

## Payroll

A run pays a month. Each person's pay is copied when the run is made: their approved HR salary in effect on the month's last day, plus their **unpaid** monthly incentive for the month from Tasks when pay is in taka. Settling someone's pay as `paid` marks that incentive paid in Tasks too (`incentiveMarkedPaid` on the item), so it's never paid twice; if Tasks paid it after the run was made, settling as `paid` is refused with `409 incentive_already_paid`. The run's `bankAccountId` is given only to items in that account's currency, so pay is never taken from an account in another currency. One run a month; deleting a draft frees the month.

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──everyone settled──▶ completed
   ▲                     │
   └──────return─────────┘
```

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/payroll-runs` | `payrollRun.read` | `page`, `pageSize`, `year`, `status` | Each with `employeeCount`, `paidCount` and `totals` by currency |
| `POST /accounts/payroll-runs` | `payrollRun.create` | `month`, `year`, and optionally `userIds` (default everyone active with an approved salary), `bankAccountId`, `notes` | `201`. `409 run_exists`; `422` naming anyone without an approved salary. |
| `GET /accounts/payroll-runs/:id` | `payrollRun.read` | | With `items`: `salaryAmount`, `incentiveAmount`, `deductions`, `grossAmount`, `netAmount`, `settlementStatus` |
| `PATCH /accounts/payroll-runs/:id` | `payrollRun.update` | `notes`, `bankAccountId`, `deductions` (`itemId`, `amount`), `version` | Drafts only |
| `DELETE /accounts/payroll-runs/:id` | `payrollRun.delete` | | Drafts only. `204`. |
| `POST /accounts/payroll-runs/:id/submit` | `payrollRun.update` | | From `draft` |
| `POST /accounts/payroll-runs/:id/approve` | `payrollRun.approve` | | Not your own |
| `POST /accounts/payroll-runs/:id/return` | `payrollRun.approve` | `reason` | Back to draft. Not your own. |
| `PATCH /accounts/payroll-runs/:id/items/:itemId` | `payrollRun.update` | `settlementStatus` (`unpaid`, `paid`, `failed`, `returned`), `reference`, `notes`, `version` | Approved or completed runs only. Paid salaries leave the item's bank account. `409 incentive_already_paid`, see above. |
| `GET /accounts/payroll-runs/:id/history` | `payrollRun.read` | `page`, `pageSize` | |

## Evidence documents

Files on bills, payments, receipts and payroll items (`ownerType`: `bill`, `payment`, `receipt`, `payrollItem`), up to 100 MB each, uploaded straight to storage in parts as task files are. Every route also needs read on the owner's resource (`payrollRun` for a payroll item).

| Route | Needs | Body or query | Notes |
|---|---|---|---|
| `GET /accounts/documents` | `document.read` | `ownerType`, `ownerId` | |
| `POST /accounts/documents` | `document.create` | `ownerType`, `ownerId`, `fileName`, `mimeType`, `sizeBytes` | `201` with `document`, `partSize`, `partCount` |
| `POST /accounts/documents/:id/part-urls` | `document.create` | `partNumbers` | Only the uploader (`403 not_your_upload`) |
| `POST /accounts/documents/:id/complete` | `document.create` | `parts` (`partNumber`, `etag`) | Checks the size (`422 size_mismatch`) |
| `GET /accounts/documents/:id/url` | `document.read` | `mode` (`view` or `download`) | Types a browser could run always download |
| `DELETE /accounts/documents/:id` | `document.create` | | Your own; someone else's also needs `document.delete`. `204`. |

## Settings

| Setting | Default | Used for |
|---|---|---|
| `INVOICE_HOURLY_RATE_USD` | `0` | The rate when an invoice names none. With `0`, every invoice must send `hourlyRate`. |
| `INVOICE_NUMBER_PREFIX` | `INV` | The start of invoice numbers |
| `COMPANY_NAME`, `COMPANY_ADDRESS` | `TwinTrack`, none | Who to pay, printed on invoices |
