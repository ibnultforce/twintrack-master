# Accounts: data model

What the Accounts API stores and returns. Module key: `accounts`. Every route starts with `/accounts`.

This describes records **as the API returns them**. The same model is in `schema.json` as JSON Schema. Routes, bodies and error codes are in `api/accounts.md`.

## Reading this document

- **Type** uses JSON types. `date-time` is an ISO 8601 string. `date` is a calendar day sent as `YYYY-MM-DD` and returned as midnight UTC. `money` is a number to the cent.
- **Always** means the field is in every response. Anything else can be missing, because it isn't set or because field security hides it.
- **Field access**: `controlled` fields follow the person's field access; `protected` fields are hidden unless their profile grants them.
- Records belong to the company, not to people, so permissions aren't scoped.

## Shared values

| Name | Values (label, pill) |
|---|---|
| Currency | `BDT` (৳), `USD` ($). A bank account's currency never changes |
| ActiveStatus | `active` "Active" good, `inactive` "Inactive" neutral |
| Method | `bank_transfer` "Bank transfer", `cash` "Cash", `mobile_banking` "Mobile banking", `cheque` "Cheque", `card` "Card" |

## Category

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `name` | string |  | controlled |  |
| `code` | string |  | controlled | Unique, in capitals |
| `parentId` | string |  | controlled | Never itself or below it |
| `status` | ActiveStatus |  | controlled |  |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

## Vendor

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `name` | string |  | controlled |  |
| `contactName`, `contactEmail`, `contactPhone`, `address` | string |  | controlled |  |
| `bankName` | string |  | controlled |  |
| `bankAccountNumber` | string |  | protected | Its history isn't kept |
| `notes` | string |  | controlled |  |
| `status` | ActiveStatus |  | controlled |  |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

## BankAccount

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `name` | string |  | controlled |  |
| `bankName` | string |  | controlled |  |
| `accountNumber` | string |  | protected |  |
| `currency` | Currency |  | controlled | Never changes |
| `openingBalance` | money |  | controlled |  |
| `openingDate` | date |  | controlled |  |
| `currentBalance` | money |  | controlled | Worked out, never typed in |
| `status` | ActiveStatus |  | controlled |  |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

**Statement** (`GET /accounts/bank-accounts/:id/statement`): `openingBalance`, `closingBalance`, `entries`, each with `kind` (`receipt` "Receipt", `receipt_reversal` "Receipt reversed", `payment` "Payment", `payment_reversal` "Payment reversed", `salary` "Salary"), `amount` (negative for money out) and `balance` after it.

## CompanyBankDetails

`bankName`, `accountName`, `accountNumber`, `branchName`, `routingNumber`, `swiftCode`, `address` (all controlled, all optional), and the record fields.

## Bill

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `billNumber` | string |  | controlled | The vendor's number |
| `vendorId` | string |  | controlled |  |
| `vendorName` | string |  |  |  |
| `categoryId`, `projectId`, `department` | string |  | controlled | `projectId` is a Project management project |
| `businessDate` | date |  | controlled |  |
| `dueDate` | date |  | controlled | Overdue when past and still owed |
| `currency` | Currency |  | controlled |  |
| `amount` | money |  | controlled |  |
| `paidAmount`, `outstandingAmount` | money | yes |  | From payments in effect |
| `taxCode`, `notes` | string |  | controlled |  |
| `status` | BillStatus |  | controlled |  |
| `decidedBy`, `decidedAt`, `rejectionReason` |  |  |  | Approval or rejection |
| `reversedBy`, `reversedAt`, `reversalReason` |  |  |  |  |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

### BillStatus and flow

| Value | Label | Pill |
|---|---|---|
| `draft` | Draft | neutral |
| `pending_approval` | Waiting for approval | warning |
| `approved` | Approved | accent |
| `partially_paid` | Partly paid | accent |
| `paid` | Paid | good |
| `rejected` | Rejected | danger |
| `reversed` | Reversed | neutral |

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──pay──▶ partially_paid ──pay──▶ paid
  │                     └──reject──▶ rejected        └──reverse──▶ reversed
  └──delete (recycle bin)
```

## Payment

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `bankAccountId` | string |  | controlled |  |
| `billId`, `categoryId`, `projectId`, `department` | string |  | controlled |  |
| `payeeType` | `vendor`, `employee`, `other` |  | controlled |  |
| `payeeVendorId`, `payeeUserId` | string |  | controlled |  |
| `payeeName` | string |  | controlled | The payee's name, whatever the type |
| `amount` | money |  | controlled |  |
| `currency` | Currency |  |  | The bank account's |
| `paymentDate` | date |  | controlled |  |
| `method` | Method |  | controlled |  |
| `reference`, `notes` | string |  | controlled |  |
| `reversesId` | string |  |  | Set on a reversal |
| `reversalId` | string |  |  | Set on a reversed payment |
| `inEffect` | boolean | yes |  | False for a reversal and for what it reversed |
| `version`, `createdBy`, `createdAt` |  | yes |  | Never edited |

## Receipt

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `bankAccountId`, `clientId` | string |  | controlled | `clientId` is a Master client |
| `amount` | money |  | controlled | What the client paid |
| `bankFee` | money |  | controlled |  |
| `netAmount` | money |  |  | What reached the bank |
| `currency` | Currency |  |  |  |
| `receivedDate` | date |  | controlled |  |
| `method` | Method |  | controlled |  |
| `reference`, `notes` | string |  | controlled |  |
| `allocations` | Allocation[] |  |  | Each `id`, `invoiceId`, `invoiceNumber`, `amount`, `createdBy`, `createdAt` |
| `allocatedAmount`, `unallocatedAmount` | money |  |  |  |
| `reversesId`, `reversalId`, `inEffect` |  |  |  | As on payments |

## Invoice

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `invoiceNumber` | string |  |  | Such as `INV-AL-02-10-26` |
| `clientId`, `clientName` | string |  |  |  |
| `periodStart`, `periodEnd` | date |  |  |  |
| `basis` | `completed`, `logged` |  |  | Finished work of a client, or chosen projects |
| `currency` | Currency |  |  |  |
| `hourlyRate` | money |  | controlled |  |
| `totalHours`, `billableHours` | number |  |  |  |
| `amount` | money |  | controlled | Always the sum of the lines |
| `paidAmount`, `outstandingAmount` | money |  |  | From allocated receipts |
| `status` | InvoiceStatus |  | controlled |  |
| `projects` | array |  |  | Each `projectId`, `projectName`, `totalHours`, `billableHours`, `amount` |
| `lines` | InvoiceLine[] |  |  | Only on one invoice |
| `additionalNotes` | string |  | controlled |  |
| `hasDocument`, `documentVersion` |  |  |  | The Word document |
| `emailedAt`, `emailedTo` |  |  |  |  |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

**InvoiceLine:** `id`, `projectId`, `taskId` and `taskNumber` (missing on custom lines), `custom`, `description`, `date`, `hours`, `billable`, `amount`.

### InvoiceStatus

`draft` "Draft" neutral, `sent` "Sent" accent, `paid` "Paid" good. Moves draft → sent → paid, and paid → sent; never back to draft.

## PayrollRun

| Field | Type | Always | Field access | Meaning |
|---|---|---|---|---|
| `id` | string | yes |  |  |
| `month`, `year` | number |  |  | One run a month |
| `status` | PayrollRunStatus |  | controlled |  |
| `bankAccountId` | string |  | controlled |  |
| `notes` | string |  | controlled |  |
| `decidedBy`, `decidedAt`, `returnReason` |  |  |  |  |
| `employeeCount`, `paidCount` | number |  |  |  |
| `totals` | object |  |  | By currency |
| `items` | PayrollItem[] |  |  | Only on one run |
| `version`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |  | yes |  | Record fields; send `version` back with an edit |

**PayrollItem:** `id`, `userId`, `name`, `salaryId`, `currency`, `salaryAmount`, `incentiveAmount`, `incentiveMarkedPaid`, `deductions`, `grossAmount`, `netAmount`, `bankAccountId`, `settlementStatus`, `settledAt`, `reference`, `notes`.

### PayrollRunStatus and settlement

Runs: `draft` "Draft" neutral, `pending_approval` "Waiting for approval" warning, `approved` "Approved" accent, `completed` "Completed" good.

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──everyone settled──▶ completed
   ▲                     │
   └──────return─────────┘
```

Items: `unpaid` "Unpaid" warning, `paid` "Paid" good, `failed` "Failed" danger, `returned` "Returned" neutral.

## Document (evidence)

`id`, `ownerType` (`bill`, `payment`, `receipt`, `payrollItem`), `ownerId`, `fileName`, `mimeType`, `sizeBytes`, `status` (`uploading`, `ready`), `uploadedBy`, `createdAt`.

## HistoryEntry

`id`, `at`, `action` (`created`, `updated`, `deleted`, `restored`), `changes` (each `field`, `from`, `to`; hidden fields left out), `actorName`.

## Shared types

**List pages:** `page` (from 1) and `pageSize` (up to 100) in the query; the answer has `total` and the list (`bills`, `payments`, `receipts`, `invoices`, `payrollRuns`, `bankAccounts`, `vendors`, `categories`).

**Errors:** every error is `{ "error": { "code", "message", "fields"? } }`. Show `message`. Common codes: `403 forbidden`, `403 own_record`, `403 field_not_editable`, `403 field_hidden`, `404 unknown_*`, `409 version_conflict`, `409 invalid_status`, `409 already_reversed`, `422 validation_failed` (with `fields`).
