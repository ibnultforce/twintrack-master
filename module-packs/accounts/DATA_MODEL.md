# Accounts: data model

What the Accounts API stores and returns, made from `manifests/accounts.schema.json` (the same model as JSON Schema). Amounts are whole paisa or cents; dates are `YYYY-MM-DD`. A field a profile hides (see INSTRUCTIONS.md, Protected fields) is left out of the response. Records not listed here are described with their routes in `api/accounts.md`.

## Status

| Field | Type | Always | Meaning |
|---|---|---|---|
| `module` | object | yes |  |
| `status` | object | yes |  |
| `time` | string, date-time | yes |  |

## LedgerAccount

One account in the chart of accounts. Never deleted: deactivated instead.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `code` | string | yes | Unique across the chart |
| `name` | string | yes |  |
| `type` | `asset`, `liability`, `equity`, `income`, `expense` | yes |  |
| `normalBalance` | `debit`, `credit` | yes | Worked out from type: debit for assets and expenses |
| `parentId` | string |  | An active account of the same type |
| `description` | string |  |  |
| `isActive` | boolean | yes |  |
| `version` | integer | yes |  |
| `createdBy` | string |  |  |
| `createdAt` | string, date-time | yes |  |
| `updatedBy` | string |  |  |
| `updatedAt` | string, date-time | yes |  |
| `bankAccountNumber` | string |  | Protected field: left out unless the grant names it; masked as "•••• 7712" when it does, in the account, lists and history. The full number comes only from POST /accounts/ledger-accounts/:id/reveal-bank-number, which writes the activity log |
| `cashOrBank` | `cash`, `bank` |  | Set on an asset account that holds money; the Cash and bank screen lists these. Only asset accounts, never one that groups others |
| `bankName` | string |  | The bank, for a bank account, such as City Bank |
| `balance` | integer |  | Paisa, from ledger lines only, on the account's normal side: debits minus credits for assets and expenses, credits minus debits for the rest |

## AccountsSettings

One settings record for the whole module. Each part is a field a profile can hide; a hidden part is left out.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `standInApprover` | object |  | May approve without the approve permission, never their own records |
| `standInUntil` | string |  | Last day the stand-in may approve; none means no end |
| `isStandInActive` | boolean |  |  |
| `homeCurrency` | object |  | The currency the books are kept in; every ledger amount is in it |
| `currencies` | list of object |  | Foreign currencies the company deals in, by code. Exchange rates name only these |
| `defaultCurrency` | string |  | The currency new documents such as invoices and bills start in: BDT or one of the currencies. People can pick another per document. BDT when never set |
| `exchangeRates` | list of object |  | Rates for currencies other than taka, by currency then newest first |
| `taxRates` | list of object |  |  |
| `version` | integer | yes |  |
| `updatedBy` | string |  |  |
| `updatedAt` | string, date-time |  |  |
| `providentFundBasisPoints` | integer |  | Provident fund, basis points of gross pay taken from pay; the company adds the same. 0 is none |
| `gratuityBasisPoints` | integer |  | Gratuity set aside each month, basis points of gross pay. 0 is none |

## JournalVoucher

A voucher a second person approves before it reaches the ledger: a journal voucher (any balanced lines), a payment out of one cash or bank account, or a receipt into one.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `voucherType` | `journal`, `payment`, `receipt` | yes | Vouchers saved before payment and receipt vouchers existed are journal |
| `number` | string | yes | One series per type: JV, PV, RV |
| `voucherDate` | string | yes |  |
| `memo` | string | yes |  |
| `party` | string |  | Who was paid, or who paid. Required on payment and receipt vouchers |
| `reference` | string |  | The outside document, such as a cheque or bill number |
| `moneyAccountId` | string |  | Payment and receipt vouchers only: the cash or bank account the money moved through |
| `lines` | list of object | yes | The full balanced lines, including the cash or bank line that the API adds to a payment or receipt |
| `total` | integer | yes | Whole paisa or cents |
| `status` | `draft`, `submitted`, `recorded`, `reversed` | yes |  |
| `returnNote` | string |  | Why an approver sent it back; cleared on the next submit |
| `createdBy` | object |  |  |
| `submittedBy` | object |  |  |
| `approvedBy` | object |  |  |
| `reversedBy` | object |  |  |
| `createdAt` | string, date-time |  |  |
| `submittedAt` | string, date-time |  |  |
| `approvedAt` | string, date-time |  |  |
| `reversedAt` | string, date-time |  |  |
| `ledgerEntryId` | string |  |  |
| `reversalEntryId` | string |  |  |
| `allowedActions` | object |  | Only on GET /journal-vouchers/:id: which actions will work for the caller |
| `version` | integer | yes |  |
| `updatedAt` | string, date-time |  |  |
| `waitingUpdateRequest` | object |  | On a single recorded voucher: the update request waiting to correct it |
| `linkedDocument` | object |  | The invoice or bill a receipt or payment settles. Such a voucher is never edited or corrected by an update request. |

## AuditEntry

One line of the Accounts activity log.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `at` | string, date-time | yes |  |
| `actorId` | string |  |  |
| `actorName` | string |  |  |
| `action` | string | yes | Such as journalVoucher.approved or ledgerEntry.posted |
| `targetType` | string |  |  |
| `targetId` | string |  |  |
| `targetName` | string |  |  |
| `module` | object | yes |  |

## UpdateRequest

A request to correct a recorded journal voucher. Applying it reverses the voucher's ledger entry and records the corrected one; someone other than the requester approves it.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes | UR-0001 and so on |
| `recordType` | `journalVoucher` | yes |  |
| `recordId` | string | yes |  |
| `recordNumber` | string | yes | The voucher number, such as JV-0004 |
| `reason` | string | yes |  |
| `before` | object | yes | The voucher when the request was made |
| `after` | object | yes | The voucher once the request is applied |
| `status` | `waiting`, `applied`, `rejected` | yes |  |
| `createdBy` | object |  |  |
| `createdAt` | string, date-time |  |  |
| `decidedBy` | object |  |  |
| `decidedAt` | string, date-time |  |  |
| `rejectionNote` | string |  |  |
| `reversalEntryId` | string |  |  |
| `correctedEntryId` | string |  |  |
| `version` | integer | yes |  |

## ClientAccount

How Accounts bills one Master client. Defaults until set: Net 30, the Settings default currency, no rate.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `clientId` | string | yes |  |
| `clientName` | string | yes |  |
| `termsDays` | integer | yes |  |
| `currency` | string | yes |  |
| `hourlyRate` | integer |  | Minor units of the currency per hour of task estimate |
| `version` | integer | yes |  |

## Invoice

Money a client owes, in its own currency. Issued invoices are recorded in taka at the rate on the issue date.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes |  |
| `clientId` | string | yes |  |
| `clientName` | string | yes |  |
| `currency` | string | yes |  |
| `issueDate` | string | yes |  |
| `dueDate` | string | yes |  |
| `lines` | list of object | yes |  |
| `total` | integer | yes | Minor units of the invoice currency |
| `exchangeRate` | integer |  | Paisa per unit on the issue date; set when issued |
| `totalInTaka` | integer |  | Paisa; set when issued |
| `status` | `draft`, `submitted`, `issued`, `cancelled` | yes |  |
| `paid` | integer |  | Settled by recorded vouchers linked to it, in its currency |
| `outstanding` | integer |  | Still owed |
| `pending` | integer |  | Settled by linked vouchers still in draft or waiting for approval |
| `paymentStatus` | `unpaid`, `part_paid`, `paid`, `overdue` |  | Only on an issued invoice or recorded bill |
| `daysOverdue` | integer |  |  |
| `returnNote` | string |  |  |
| `createdBy` | object |  |  |
| `submittedBy` | object |  |  |
| `approvedBy` | object |  |  |
| `cancelledBy` | object |  |  |
| `createdAt` | string, date-time |  |  |
| `submittedAt` | string, date-time |  |  |
| `approvedAt` | string, date-time |  |  |
| `cancelledAt` | string, date-time |  |  |
| `ledgerEntryId` | string |  |  |
| `reversalEntryId` | string |  |  |
| `version` | integer | yes |  |

## Vendor

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `category` | `rent`, `cloud`, `utilities`, `equipment`, `food_and_events`, `other` | yes |  |
| `tdsBasisPoints` | integer | yes | 500 is 5% |
| `contactEmail` | string |  |  |
| `contactPhone` | string |  |  |
| `isActive` | boolean | yes |  |
| `version` | integer | yes |  |

## Bill

Money owed to a vendor, in taka. TDS is the vendor rate on the total; the vendor is owed the rest.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes |  |
| `vendorId` | string | yes |  |
| `vendorName` | string | yes |  |
| `vendorReference` | string |  |  |
| `billDate` | string | yes |  |
| `dueDate` | string | yes |  |
| `lines` | list of object | yes |  |
| `amount` | integer | yes | Paisa |
| `tdsBasisPoints` | integer | yes |  |
| `tds` | integer | yes | Paisa |
| `netPayable` | integer | yes | Paisa |
| `status` | `draft`, `submitted`, `recorded`, `cancelled` | yes |  |
| `paid` | integer |  | Settled by recorded vouchers linked to it, in its currency |
| `outstanding` | integer |  | Still owed |
| `pending` | integer |  | Settled by linked vouchers still in draft or waiting for approval |
| `paymentStatus` | `unpaid`, `part_paid`, `paid`, `overdue` |  | Only on an issued invoice or recorded bill |
| `daysOverdue` | integer |  |  |
| `returnNote` | string |  |  |
| `createdBy` | object |  |  |
| `submittedBy` | object |  |  |
| `approvedBy` | object |  |  |
| `cancelledBy` | object |  |  |
| `createdAt` | string, date-time |  |  |
| `submittedAt` | string, date-time |  |  |
| `approvedAt` | string, date-time |  |  |
| `cancelledAt` | string, date-time |  |  |
| `ledgerEntryId` | string |  |  |
| `reversalEntryId` | string |  |  |
| `version` | integer | yes |  |
| `vatCode` | string |  | A Settings tax rate code charged as VAT |
| `vatBasisPoints` | integer |  |  |
| `vat` | integer |  | Paisa: VAT on the amount before tax, claimed back (1700) |
| `regularExpense` | object |  | The regular expense and period this bill was made for |

## PayrollRun

One month's salaries. lines is protected.

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes |  |
| `month` | string | yes |  |
| `monthLabel` | string | yes |  |
| `payDate` | string | yes |  |
| `lines` | list of object |  |  |
| `total` | integer | yes | Paisa |
| `headcount` | integer | yes |  |
| `status` | `draft`, `submitted`, `recorded`, `cancelled` | yes |  |
| `paid` | integer |  |  |
| `outstanding` | integer |  |  |
| `pending` | integer |  |  |
| `paymentStatus` | `unpaid`, `part_paid`, `paid`, `overdue` |  |  |
| `version` | integer | yes |  |
| `netTotal` | integer |  | Paisa paid from the bank: gross less loan repayments |
| `providentFundBasisPoints` | integer |  |  |
| `gratuityBasisPoints` | integer |  |  |

## FixedAsset

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes |  |
| `name` | string | yes |  |
| `assetTag` | string |  |  |
| `category` | `computers`, `furniture`, `office_equipment`, `vehicles`, `software`, `other` | yes |  |
| `purchaseDate` | string | yes |  |
| `cost` | integer | yes | Paisa |
| `salvageValue` | integer | yes | Paisa |
| `usefulLifeMonths` | integer | yes |  |
| `monthlyDepreciation` | integer | yes | Paisa, straight-line |
| `accumulatedDepreciation` | integer | yes | Paisa, from recorded depreciation runs |
| `bookValue` | integer | yes | Paisa: cost less accumulated depreciation |
| `billId` | string |  |  |
| `isActive` | boolean | yes |  |
| `version` | integer | yes |  |
| `schedule` | list of object |  | Only on one asset |

## InventoryItem

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `assetTag` | string |  |  |
| `category` | string | yes |  |
| `unit` | string | yes |  |
| `reorderLevel` | number |  |  |
| `onHand` | number | yes | From the movements |
| `isLow` | boolean | yes |  |
| `isActive` | boolean | yes |  |
| `version` | integer | yes |  |
| `movements` | list of object |  | Only on one item, newest first |

## EmployeeLoan

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `number` | string | yes |  |
| `employeeId` | string | yes |  |
| `employeeName` | string | yes |  |
| `kind` | `loan`, `advance` | yes |  |
| `purpose` | string | yes |  |
| `issueDate` | string | yes |  |
| `amount` | integer | yes |  |
| `monthlyInstallment` | integer | yes |  |
| `firstRepaymentMonth` | string | yes |  |
| `lastRepaymentMonth` | string |  |  |
| `status` | `draft`, `submitted`, `recorded`, `cancelled` | yes |  |
| `repaid` | integer |  |  |
| `repaymentPending` | integer |  |  |
| `outstanding` | integer | yes | Paisa still owed: amount less repayments in recorded payroll runs |
| `version` | integer | yes |  |

## RegularExpense

| Field | Type | Always | Meaning |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `category` | `rent`, `cloud_software`, `utilities`, `office_services`, `food_events`, `travel`, `insurance`, `government_fees` | yes |  |
| `vendorId` | string | yes |  |
| `vendorName` | string |  |  |
| `accountId` | string | yes | The expense account each bill is charged to |
| `frequency` | `monthly`, `yearly` | yes |  |
| `amount` | integer | yes | Paisa per period, before VAT |
| `vatCode` | string |  |  |
| `dayOfMonth` | integer | yes |  |
| `startMonth` | string | yes |  |
| `endMonth` | string |  |  |
| `isActive` | boolean | yes |  |
| `nextDue` | object |  |  |
| `version` | integer | yes |  |

## Budget

| Field | Type | Always | Meaning |
|---|---|---|---|
| `year` | integer | yes | Calendar year the July-June financial year starts in |
| `lines` | list of object | yes |  |
