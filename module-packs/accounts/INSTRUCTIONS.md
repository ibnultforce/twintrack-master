# Accounts frontend: instructions

These are the instructions for the **Accounts** frontend of TwinTrack. Unlike other packs, this module's frontend is already built: `twintrack-accounts/`, on `accounts.twintrack.localhost:3400`. Use this pack to change or extend it, or to rebuild it, and keep the existing app as the reference for layout, words and behaviour.

## Files in this pack

| File | What it holds |
|---|---|
| `api/accounts.md` | Every route: what it takes, what it returns, and its errors |
| `api/README.md` | Shared rules: tokens, the error format, paging, errors any route can return |
| `api/postman_collection.json` | The Accounts Postman folder, with secrets removed |
| `DATA_MODEL.md` | Every record the API returns, field by field |
| `design.css` | The app's stylesheet (Tailwind CSS v4 component classes and theme variables) |

When these disagree, `api/accounts.md` wins, then `DATA_MODEL.md`. Never invent a route, field, permission or value that isn't in them.

## 1. What it is

The company's bookkeeping: a ledger that every feature writes into, vouchers and approvals, invoices and bills, cash, bank and reconciliation, payroll and other people costs, assets and stock, tax, budget, reports and exports.

## 2. Rules the screens must keep

- **Money arrives as whole paisa or cents.** Show it as taka (`Tk 8,76,333.83`, the Bangladeshi grouping), and send it back as whole minor units. Never do money sums in the browser that the API doesn't return.
- **The API decides what someone may do.** Detail responses carry `allowedActions`: show a button only when its action is true. Show a screen or menu item only when `GET /me/permissions/accounts` holds its permission.
- **The maker never approves.** The API refuses with `403 own_record`; the screen shows "Waiting for someone other than its maker to approve it" instead of the buttons.
- **Protected fields may be missing.** A field the profile hides is left out of the response. Show what the API sends instead, such as "Salaries per person are hidden by your profile. The total is …". Never show a blank as zero.
- **Bank numbers are masked** (`•••• 7890`). The full number comes only from Reveal (`POST /accounts/ledger-accounts/:id/reveal-bank-number`), which is logged.
- **Recorded entries are never edited.** Corrections are update requests or reversals; screens offer those, never an edit form.
- **Dates are `YYYY-MM-DD` strings.** Show them as "26 Nov 2026" without converting time zones.

## 3. Screens

### Overview

| Path | Screen | Needs |
|---|---|---|
| `/` | Dashboard | `ledgerAccount.read` |
| `/cash-bank` | Cash and bank | `ledgerAccount.read` |
| `/bank-reconciliation` | Bank reconciliation | `bankReconciliation.read` |
| `/assistant` | Claude assistant | `ledgerAccount.read` |

### Review

| Path | Screen | Needs |
|---|---|---|
| `/update-requests` | Update requests | `updateRequest.read` |
| `/change-history` | Change history | `journalVoucher.read` |

### Books

| Path | Screen | Needs |
|---|---|---|
| `/chart-of-accounts` | Chart of accounts | `ledgerAccount.read` |
| `/journal-vouchers` | Vouchers | `journalVoucher.read` |
| `/general-ledger` | Ledger | `ledgerAccount.read` |

### Receivables

| Path | Screen | Needs |
|---|---|---|
| `/invoices` | Invoices | `invoice.read` |
| `/client-accounts` | Client accounts | `invoice.read` |
| `/clients` | Client billing | `clientAccount.read` |

### Payables

| Path | Screen | Needs |
|---|---|---|
| `/bills` | Vendors and bills | `bill.read` |
| `/vendors` | Vendors | `vendor.read` |
| `/office-expenses` | Office expenses | `ledgerAccount.read` |
| `/office-rent` | Office rent | `bill.read` |
| `/disbursements` | Disbursements | `journalVoucher.read` |

### People money

| Path | Screen | Needs |
|---|---|---|
| `/payroll` | Payroll | `payrollRun.read` |
| `/employee-payments` | Employee payments | `payrollRun.read (or another read permission)` |
| `/bonus-incentive` | Bonus and incentive | `staffPayout.read` |
| `/commission` | Commission | `commissionRule.read` |
| `/leave-cost` | Leave cost | `unpaidLeave.read` |
| `/loans` | Loans and advances | `employeeLoan.read` |
| `/provident-fund` | Provident fund | `providentFund.read` |
| `/regular-expenses` | Regular expenses | `regularExpense.read` |
| `/inventory` | Inventory | `inventoryItem.read` |

### Tax and assets

| Path | Screen | Needs |
|---|---|---|
| `/tax-vat` | Tax and VAT | `taxFiling.read` |
| `/fixed-assets` | Fixed assets | `fixedAsset.read` |
| `/budget` | Budget | `budget.read` |

### Control

| Path | Screen | Needs |
|---|---|---|
| `/approvals` | Approvals | `journalVoucher.read (or another read permission)` |
| `/audit-log` | Audit log | `auditLog.read` |
| `/export-center` | Export center | `ledgerAccount.read (or another read permission)` |
| `/reports` | Reports | `ledgerAccount.read` |
| `/settings` | Settings | `setting.read` |
| `/status` | Status | `setting.read` |

Detail screens (`/journal-vouchers/[id]`, `/bills/[id]`, `/invoices/[id]`, `/payroll/[id]`, `/bank-reconciliation/[id]` and the rest) open from their lists and need the same permission.

## 4. Permissions

| Permission | Resource |
|---|---|
| `setting.read` | Accounts settings |
| `setting.update` | Accounts settings |
| `ledgerAccount.read` | Chart of accounts |
| `ledgerAccount.create` | Chart of accounts |
| `ledgerAccount.update` | Chart of accounts |
| `journalVoucher.read` | Vouchers (journal, payment, receipt) |
| `journalVoucher.create` | Vouchers (journal, payment, receipt) |
| `journalVoucher.update` | Vouchers (journal, payment, receipt) |
| `journalVoucher.approve` | Vouchers (journal, payment, receipt) |
| `updateRequest.read` | Update requests |
| `updateRequest.create` | Update requests |
| `updateRequest.approve` | Update requests |
| `auditLog.read` | Accounts activity log |
| `clientAccount.read` | Client billing |
| `clientAccount.update` | Client billing |
| `invoice.read` | Invoices |
| `invoice.create` | Invoices |
| `invoice.update` | Invoices |
| `invoice.approve` | Invoices |
| `vendor.read` | Vendors |
| `vendor.create` | Vendors |
| `vendor.update` | Vendors |
| `bill.read` | Bills |
| `bill.create` | Bills |
| `bill.update` | Bills |
| `bill.approve` | Bills |
| `payrollRun.read` | Payroll runs |
| `payrollRun.create` | Payroll runs |
| `payrollRun.update` | Payroll runs |
| `payrollRun.approve` | Payroll runs |
| `fixedAsset.read` | Fixed assets |
| `fixedAsset.create` | Fixed assets |
| `fixedAsset.update` | Fixed assets |
| `inventoryItem.read` | Inventory |
| `inventoryItem.create` | Inventory |
| `inventoryItem.update` | Inventory |
| `bankReconciliation.read` | Bank reconciliation |
| `bankReconciliation.create` | Bank reconciliation |
| `bankReconciliation.update` | Bank reconciliation |
| `staffPayout.read` | Bonus, incentive and commission |
| `staffPayout.create` | Bonus, incentive and commission |
| `staffPayout.update` | Bonus, incentive and commission |
| `staffPayout.approve` | Bonus, incentive and commission |
| `commissionRule.read` | Commission rules |
| `commissionRule.create` | Commission rules |
| `commissionRule.update` | Commission rules |
| `employeeLoan.read` | Loans and advances |
| `employeeLoan.create` | Loans and advances |
| `employeeLoan.update` | Loans and advances |
| `employeeLoan.approve` | Loans and advances |
| `unpaidLeave.read` | Unpaid leave |
| `unpaidLeave.update` | Unpaid leave |
| `providentFund.read` | Provident fund and gratuity |
| `regularExpense.read` | Regular expenses |
| `regularExpense.create` | Regular expenses |
| `regularExpense.update` | Regular expenses |
| `taxFiling.read` | Tax and VAT |
| `budget.read` | Budget against actual |
| `budget.update` | Budget against actual |

No Accounts resource is scoped: each is one list for the whole organisation.

**Protected fields:**

| Resource | Fields |
|---|---|
| Chart of accounts | `bankAccountNumber` |
| Payroll runs | `lines` (Salary per person) |

## 5. Routes

| Route | Needs |
|---|---|
| `GET /accounts/status` | `setting.read` |
| `GET /accounts/ledger-accounts` | `ledgerAccount.read` |
| `POST /accounts/ledger-accounts` | `ledgerAccount.create` |
| `GET /accounts/ledger-accounts/:id` | `ledgerAccount.read` |
| `PATCH /accounts/ledger-accounts/:id` | `ledgerAccount.update` |
| `GET /accounts/settings` | `setting.read` |
| `PATCH /accounts/settings` | `setting.update` |
| `GET /accounts/settings/approver-candidates` | `setting.update` |
| `GET /accounts/ledger-accounts/:id/history` | `ledgerAccount.read` |
| `POST /accounts/ledger-accounts/:id/reveal-bank-number` | `ledgerAccount.read` |
| `GET /accounts/journal-vouchers` | `journalVoucher.read` |
| `POST /accounts/journal-vouchers` | `journalVoucher.create` |
| `GET /accounts/journal-vouchers/:id` | `journalVoucher.read` |
| `PATCH /accounts/journal-vouchers/:id` | `journalVoucher.update` |
| `POST /accounts/payment-vouchers` | `journalVoucher.create` |
| `PATCH /accounts/payment-vouchers/:id` | `journalVoucher.update` |
| `POST /accounts/receipt-vouchers` | `journalVoucher.create` |
| `PATCH /accounts/receipt-vouchers/:id` | `journalVoucher.update` |
| `POST /accounts/journal-vouchers/:id/submit` | `journalVoucher.update` |
| `POST /accounts/journal-vouchers/:id/approve` | `journalVoucher.read` |
| `POST /accounts/journal-vouchers/:id/return` | `journalVoucher.read` |
| `POST /accounts/journal-vouchers/:id/reverse` | `journalVoucher.read` |
| `GET /accounts/journal-vouchers/:id/history` | `journalVoucher.read` |
| `GET /accounts/cash-bank` | `ledgerAccount.read` |
| `GET /accounts/update-requests` | `updateRequest.read` |
| `POST /accounts/update-requests` | `updateRequest.create` |
| `GET /accounts/update-requests/:id` | `updateRequest.read` |
| `POST /accounts/update-requests/:id/approve` | `updateRequest.read` |
| `POST /accounts/update-requests/:id/reject` | `updateRequest.read` |
| `GET /accounts/change-history` | `journalVoucher.read` or `updateRequest.read` |
| `GET /accounts/approvals` | `journalVoucher.read` or `invoice.read` or `bill.read` or `payrollRun.read` or `staffPayout.read` or `employeeLoan.read` or `updateRequest.read` |
| `GET /accounts/audit-log` | `auditLog.read` |
| `GET /accounts/clients` | `clientAccount.read` |
| `PATCH /accounts/clients/:id` | `clientAccount.update` |
| `GET /accounts/invoices` | `invoice.read` |
| `POST /accounts/invoices` | `invoice.create` |
| `GET /accounts/invoices/billable-tasks` | `invoice.create` |
| `GET /accounts/invoices/:id` | `invoice.read` |
| `PATCH /accounts/invoices/:id` | `invoice.update` |
| `POST /accounts/invoices/:id/submit` | `invoice.update` |
| `POST /accounts/invoices/:id/approve` | `invoice.read` |
| `POST /accounts/invoices/:id/return` | `invoice.read` |
| `POST /accounts/invoices/:id/cancel` | `invoice.read` |
| `POST /accounts/invoices/:id/receive-payment` | `journalVoucher.create` |
| `GET /accounts/invoices/:id/history` | `invoice.read` |
| `GET /accounts/vendors` | `vendor.read` |
| `POST /accounts/vendors` | `vendor.create` |
| `GET /accounts/vendors/:id` | `vendor.read` |
| `PATCH /accounts/vendors/:id` | `vendor.update` |
| `GET /accounts/vendors/:id/history` | `vendor.read` |
| `GET /accounts/bills` | `bill.read` |
| `POST /accounts/bills` | `bill.create` |
| `GET /accounts/bills/:id` | `bill.read` |
| `PATCH /accounts/bills/:id` | `bill.update` |
| `POST /accounts/bills/:id/submit` | `bill.update` |
| `POST /accounts/bills/:id/approve` | `bill.read` |
| `POST /accounts/bills/:id/return` | `bill.read` |
| `POST /accounts/bills/:id/cancel` | `bill.read` |
| `POST /accounts/bills/:id/pay` | `journalVoucher.create` |
| `GET /accounts/bills/:id/history` | `bill.read` |
| `GET /accounts/payroll-runs` | `payrollRun.read` |
| `POST /accounts/payroll-runs` | `payrollRun.create` |
| `GET /accounts/payroll-runs/:id` | `payrollRun.read` |
| `PATCH /accounts/payroll-runs/:id` | `payrollRun.update` |
| `POST /accounts/payroll-runs/:id/submit` | `payrollRun.update` |
| `POST /accounts/payroll-runs/:id/approve` | `payrollRun.read` |
| `POST /accounts/payroll-runs/:id/return` | `payrollRun.read` |
| `POST /accounts/payroll-runs/:id/cancel` | `payrollRun.read` |
| `POST /accounts/payroll-runs/:id/pay` | `journalVoucher.create` |
| `GET /accounts/payroll-runs/:id/history` | `payrollRun.read` |
| `GET /accounts/fixed-assets` | `fixedAsset.read` |
| `POST /accounts/fixed-assets` | `fixedAsset.create` |
| `GET /accounts/fixed-assets/depreciation` | `fixedAsset.read` |
| `POST /accounts/fixed-assets/depreciation` | `fixedAsset.update` |
| `GET /accounts/fixed-assets/:id` | `fixedAsset.read` |
| `PATCH /accounts/fixed-assets/:id` | `fixedAsset.update` |
| `GET /accounts/fixed-assets/:id/history` | `fixedAsset.read` |
| `GET /accounts/inventory-items` | `inventoryItem.read` |
| `POST /accounts/inventory-items` | `inventoryItem.create` |
| `GET /accounts/inventory-items/:id` | `inventoryItem.read` |
| `PATCH /accounts/inventory-items/:id` | `inventoryItem.update` |
| `POST /accounts/inventory-items/:id/movements` | `inventoryItem.update` |
| `GET /accounts/general-ledger` | `ledgerAccount.read` |
| `GET /accounts/trial-balance` | `ledgerAccount.read` |
| `GET /accounts/reports/profit-and-loss` | `ledgerAccount.read` |
| `GET /accounts/reports/balance-sheet` | `ledgerAccount.read` |
| `GET /accounts/reports/cash-flow` | `ledgerAccount.read` |
| `GET /accounts/dashboard` | `ledgerAccount.read` |
| `GET /accounts/exports` | `ledgerAccount.read` or `journalVoucher.read` or `invoice.read` or `vendor.read` or `bill.read` or `regularExpense.read` or `payrollRun.read` or `staffPayout.read` or `employeeLoan.read` or `taxFiling.read` or `budget.read` or `fixedAsset.read` or `inventoryItem.read` |
| `GET /accounts/exports/:dataset` | `ledgerAccount.read` or `journalVoucher.read` or `invoice.read` or `vendor.read` or `bill.read` or `regularExpense.read` or `payrollRun.read` or `staffPayout.read` or `employeeLoan.read` or `taxFiling.read` or `budget.read` or `fixedAsset.read` or `inventoryItem.read` |
| `GET /accounts/client-accounts` | `invoice.read` |
| `GET /accounts/client-accounts/:id` | `invoice.read` |
| `GET /accounts/office-expenses` | `ledgerAccount.read` |
| `GET /accounts/bank-reconciliations` | `bankReconciliation.read` |
| `POST /accounts/bank-reconciliations` | `bankReconciliation.create` |
| `GET /accounts/bank-reconciliations/:id` | `bankReconciliation.read` |
| `POST /accounts/bank-reconciliations/:id/lines/:lineId/match` | `bankReconciliation.update` |
| `POST /accounts/bank-reconciliations/:id/lines/:lineId/unmatch` | `bankReconciliation.update` |
| `POST /accounts/bank-reconciliations/:id/rematch` | `bankReconciliation.update` |
| `POST /accounts/bank-reconciliations/:id/complete` | `bankReconciliation.update` |
| `GET /accounts/staff-payouts` | `staffPayout.read` |
| `POST /accounts/staff-payouts` | `staffPayout.create` |
| `GET /accounts/staff-payouts/:id` | `staffPayout.read` |
| `POST /accounts/staff-payouts/:id/submit` | `staffPayout.update` |
| `POST /accounts/staff-payouts/:id/approve` | `staffPayout.read` |
| `POST /accounts/staff-payouts/:id/return` | `staffPayout.read` |
| `POST /accounts/staff-payouts/:id/cancel` | `staffPayout.read` |
| `POST /accounts/staff-payouts/:id/pay` | `journalVoucher.create` |
| `GET /accounts/staff-payouts/:id/history` | `staffPayout.read` |
| `GET /accounts/commission-rules` | `commissionRule.read` |
| `POST /accounts/commission-rules` | `commissionRule.create` |
| `PATCH /accounts/commission-rules/:id` | `commissionRule.update` |
| `GET /accounts/employee-payments` | `payrollRun.read` or `staffPayout.read` |
| `GET /accounts/employee-loans` | `employeeLoan.read` |
| `POST /accounts/employee-loans` | `employeeLoan.create` |
| `GET /accounts/employee-loans/:id` | `employeeLoan.read` |
| `POST /accounts/employee-loans/:id/submit` | `employeeLoan.update` |
| `POST /accounts/employee-loans/:id/approve` | `employeeLoan.read` |
| `POST /accounts/employee-loans/:id/return` | `employeeLoan.read` |
| `POST /accounts/employee-loans/:id/cancel` | `employeeLoan.read` |
| `POST /accounts/employee-loans/:id/pay` | `journalVoucher.create` |
| `GET /accounts/employee-loans/:id/history` | `employeeLoan.read` |
| `GET /accounts/unpaid-leave` | `unpaidLeave.read` |
| `PUT /accounts/unpaid-leave/:employeeId/:month` | `unpaidLeave.update` |
| `GET /accounts/provident-fund` | `providentFund.read` |
| `POST /accounts/provident-fund/:month/deposit` | `journalVoucher.create` |
| `GET /accounts/regular-expenses` | `regularExpense.read` |
| `POST /accounts/regular-expenses` | `regularExpense.create` |
| `POST /accounts/regular-expenses/bills` | `bill.create` |
| `PATCH /accounts/regular-expenses/:id` | `regularExpense.update` |
| `GET /accounts/regular-expenses/:id/history` | `regularExpense.read` |
| `GET /accounts/office-rent` | `bill.read` |
| `GET /accounts/tax-filings` | `taxFiling.read` |
| `POST /accounts/tax-filings/:month/pay` | `journalVoucher.create` |
| `GET /accounts/budgets/:year` | `budget.read` |
| `PUT /accounts/budgets/:year` | `budget.update` |

Routes for approving, returning or reversing need only read access at the route; the API then checks the approve permission or the stand-in approver, and refuses the maker.

## 6. Look and feel

Tailwind CSS v4, with the component classes and theme variables in `design.css`. Use utilities for layout, the theme names for colours (no hex), no `dark:` variants and no inline styles. Each sidebar section has its own colour. Check light and dark mode and phone width.

## 7. Done means

- `npm run typecheck` and `npm run build` pass.
- Every screen works for the four example roles (accountant, approver, auditor, employee), the same way `backend/tests/accounts-roles.test.ts` checks the API.
- Nothing hidden by a profile shows, in light or dark mode, on a phone or a desktop.
