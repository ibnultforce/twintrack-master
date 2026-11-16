# Accounts frontend: instructions

These are the instructions for building the **Accounts** frontend of TwinTrack. Put this whole folder in the new project as `docs/` and point Claude Code at this file first. Other people are building other TwinTrack modules from instructions just like these, so **follow them exactly, and when they don't cover something, choose the simplest option that matches what's already here.**

## Files in this pack

| File | What it is |
|---|---|
| `INSTRUCTIONS.md` | This file: what to build and how |
| `DATA_MODEL.md` | Every record, field, allowed value and rule, explained |
| `schema.json` | The same data model as JSON Schema. Generate the TypeScript types from it |
| `design.css` | The shared TwinTrack stylesheet. Use it unchanged |
| `api/accounts.md` | Every route: what it takes, what it returns, and its errors |
| `api/README.md` | Signing in, tokens, the error format and errors any route returns |
| `api/manifest.json` | Routes, permissions and field rules, as the backend loads them |
| `api/postman_collection.json` | Working requests for every route |

When these disagree, `api/accounts.md` wins, then `DATA_MODEL.md`. Never invent a route, field, permission or value that isn't in them; if something you need is missing, stop and say so.

## 1. What you're building

A web app for the company's money: bills from vendors and their approval, payments and receipts through bank accounts, invoices to clients for Project management work, monthly payroll and its approval, evidence files on each, and the lists behind them (categories, vendors, bank accounts and the company's own bank details).

It has **no backend of its own**. Everything comes from the TwinTrack API (the Master backend), which also decides who may see and do what. People sign in at the Master frontend; this app reuses that session.

## 2. Stack and project setup

- **Next.js (App Router), React and TypeScript** with `strict: true` and `noUncheckedIndexedAccess: true`. Node 22 or later.
- **No other dependencies.** No UI kits, CSS frameworks, icon packs, state, form, date, data-fetching or upload libraries. Write small pieces by hand.
- Scripts: `dev` (port 3400), `build`, `typecheck`.
- Settings, in `.env.local` (with a matching `.env.example`):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | The API address, given with this pack |
| `NEXT_PUBLIC_MASTER_URL` | The Master frontend, where people sign in |
| `NEXT_PUBLIC_APP_URL` | Where this app is opened. The API only accepts calls from addresses it knows, so use the one you're given |

### Folders

```
src/
  app/
    layout.tsx                 root layout: imports globals.css, wraps everything in SessionProvider
    globals.css                design.css, unchanged, then a "Module additions" section at the end
    (app)/layout.tsx           the signed-in shell (sidebar + gates)
    (app)/page.tsx             sends people to the first screen their access includes
    (app)/<screen>/page.tsx    one folder per screen; details in [id]/page.tsx
  components/                  ui.tsx (shared building blocks), Dialog.tsx, AppShell.tsx, then one file per area
  lib/
    api/http.ts                the only place that calls fetch
    api/<area>.ts              one small function per route
    api/types.ts               types generated from schema.json
    format.ts                  every displayed date, time, number, money and label
    useLoad.ts, useSubmit.ts   loading and saving state
  session/SessionProvider.tsx  the session, permissions and field access
```

Screens never call `fetch` or `http.ts` directly; they call functions from `lib/api/<area>.ts`.

## 3. Signing in and the API client

Follow `api/README.md`. In short:

- **Start-up:** call `POST /auth/refresh` with `credentials: 'include'`. A `200` gives an `accessToken`; anything else means signed out. Then load `GET /auth/me` and `GET /me/permissions/accounts`.
- Keep the access token **in memory only**, never in storage. Send it as `Authorization: Bearer <token>` on every call, always with `credentials: 'include'`.
- On `401` with code `no_token`, `invalid_token` or `token_expired`, refresh **once** (one refresh shared by every call waiting on it) and retry. If the refresh fails, the session has ended: show the signed-out gate.
- A `5xx` or `429` from refresh is an outage, not a sign-out: show "TwinTrack can't be reached".
- **Sign out:** `POST /auth/logout`, then clear the token and show the signed-out gate.
- A `204` has no body.
- Errors arrive as `{ error: { code, message, fields } }` (`ApiError` in the schema). Show `message`, plus each field problem. A failed `fetch` (no answer at all) shows "The API can't be reached. Check that it is running, then try again."

The session exposes `status` (`loading`, `signed-out`, `no-access`, `signed-in`, `unavailable`), `profile`, `profileName`, `can(permission)` and `mayWriteField(field, 'create' | 'update')`.

## 4. Access: the API decides, the screen follows

From `GET /me/permissions/accounts` (`ModuleAccess` in the schema):

- `hasAccess: false`, or a `403`/`404` from that call, shows the **no-access gate**: "No access to Accounts. Your profile doesn't include Accounts. Ask whoever gives profiles in your organisation." with a "Back to TwinTrack" link to `<MASTER_URL>/modules`.
- `can('<resource>.<action>')` is true when `permissions['<resource>.<action>']` exists. Show a screen, button or menu item **only** when the person holds its permission.
- `mayWriteField('<resource>.<field>', 'update')` is true for a super admin, or when `fieldAccess` gives `edit` (or `create` when creating). Show an editable input only when it's true; otherwise show the value read-only, or leave it out of the form.
- **Fields can be missing** because field security hides them. Every optional field in `schema.json` may be absent: show `·` (a middle dot) for it, never `undefined`, `0` or an empty cell.
- Scope (`own`, `team`, `all`) is applied by the API. Never filter or hide records in the browser to imitate it.
- Never check profile names, titles or departments in code.

- Accounts permissions are **not scoped**: a permission reaches every record.
- **Two people for money:** whoever made a bill or payroll run never sees Approve, Reject or Return on it (compare `createdBy` with `profile.id`), super admins included.
- **Posted money is never edited.** Payments and receipts have no Edit; "Reverse" (with a reason) makes a linked reversal. Show reversed ones with a "Reversed" pill, and a reversal with "Reversal".
- Protected fields: a vendor's `bankAccountNumber` and a bank account's `accountNumber`. Show `·` when missing, and an input only when `mayWriteField` allows. A statement answers `403 field_hidden` when balances are hidden: show its message.
- Buttons follow each record's status, using the flows in `DATA_MODEL.md`: never show an action the status doesn't allow.

Permissions in this module:

| Permission | Resource | Scope |
|---|---|---|
| `category.read` | Categories | yes or no |
| `category.create` | Categories | yes or no |
| `category.update` | Categories | yes or no |
| `vendor.read` | Vendors | yes or no |
| `vendor.create` | Vendors | yes or no |
| `vendor.update` | Vendors | yes or no |
| `bankAccount.read` | Bank accounts | yes or no |
| `bankAccount.create` | Bank accounts | yes or no |
| `bankAccount.update` | Bank accounts | yes or no |
| `companyBankDetails.read` | Company bank details | yes or no |
| `companyBankDetails.update` | Company bank details | yes or no |
| `bill.read` | Bills | yes or no |
| `bill.create` | Bills | yes or no |
| `bill.update` | Bills | yes or no |
| `bill.delete` | Bills | yes or no |
| `bill.approve` | Bills | yes or no |
| `payment.read` | Payments | yes or no |
| `payment.create` | Payments | yes or no |
| `payment.delete` | Payments | yes or no |
| `receipt.read` | Receipts | yes or no |
| `receipt.create` | Receipts | yes or no |
| `receipt.update` | Receipts | yes or no |
| `receipt.delete` | Receipts | yes or no |
| `invoice.read` | Invoices | yes or no |
| `invoice.create` | Invoices | yes or no |
| `invoice.update` | Invoices | yes or no |
| `invoice.delete` | Invoices | yes or no |
| `payrollRun.read` | Payroll runs | yes or no |
| `payrollRun.create` | Payroll runs | yes or no |
| `payrollRun.update` | Payroll runs | yes or no |
| `payrollRun.delete` | Payroll runs | yes or no |
| `payrollRun.approve` | Payroll runs | yes or no |
| `document.read` | Evidence documents | yes or no |
| `document.create` | Evidence documents | yes or no |
| `document.delete` | Evidence documents | yes or no |

## 5. Screens

Sidebar, in this order, under the headings "Money" (bills to payroll) and "Setup" (the rest). Each entry shows only with its permission. The sidebar ends with a "TwinTrack" group holding "All modules" (link to `<MASTER_URL>/modules`), and a footer with the profile name (or "Super admin"), the person's name and "Sign out".

| Path | Sidebar label | Needs |
|---|---|---|
| `/bills` | Bills | `bill.read` |
| `/payments` | Payments | `payment.read` |
| `/invoices` | Invoices | `invoice.read` |
| `/receipts` | Receipts | `receipt.read` |
| `/payroll` | Payroll | `payrollRun.read` |
| `/bank-accounts` | Bank accounts | `bankAccount.read` |
| `/vendors` | Vendors | `vendor.read` |
| `/categories` | Categories | `category.read` |
| `/company-bank-details` | Company bank details | `companyBankDetails.read` |

Every record page has a **History card** (newest first, "actor changed field from → to", paged) and, for bills, payments, receipts and payroll items, an **Evidence card**: files with size, uploader and date; open or download through the short-lived URL; upload in parts following "Evidence documents" in `api/accounts.md` with a progress bar (up to 100 MB, `document.create`); delete your own, or anyone's with `document.delete`.

### Bills (`/bills`, `/bills/[id]`)
- Head: "Bills", subtitle "What the company owes vendors, and its approval." Action "New bill" with `bill.create`.
- Filters: status chips, vendor, category, overdue. Table: business date, bill number, vendor, amount, paid, outstanding, due date plus "Overdue", status pill.
- Bill page actions by status: Edit and Submit (`bill.update`, draft), Delete (`bill.delete`, draft, confirm), Approve and Reject with a reason (`bill.approve`, pending approval, not your own), Pay (`payment.create`, approved or partially paid: opens the payment dialog with the bill filled in), Reverse with a reason (`bill.delete`, approved). Cards: details, its payments, evidence, history.

### Payments (`/payments`, `/payments/[id]`)
- Head: "Payments", subtitle "Money paid out of the company's bank accounts." Action "New payment" with `payment.create`.
- Filters: bank account, from and to dates. Table: date, payee, bank account, method, amount, bill, a "Reversed" or "Reversal" pill.
- **Payment dialog:** bank account (its currency sets the payment's), payee type then the vendor, person (Master `GET /users`, needs `user.read`) or a name, amount, date, method, and optionally bill, category, reference, notes.
- Payment page: details, a link to its reversal or original, "Reverse" (`payment.delete`, while in effect), evidence.

### Invoices (`/invoices`, `/invoices/[id]`)
- Head: "Invoices", subtitle "Bills to clients for project work." Action "New invoice" with `invoice.create`. Above the list, a card with the **unbilled** hours by project (`GET /accounts/invoices/unbilled`).
- Filters: status chips, client. Table: number, client, period, billable hours, amount, paid, outstanding, status pill.
- **New invoice dialog:** a client (all its finished work) or chosen projects of one client (with custom lines), the period (at most 366 days), hourly rate, currency, notes. "Preview" shows the lines from `GET /accounts/invoices/preview`, marking any already invoiced, before "Create invoice".
- Invoice page: details; the lines table (task number or "Custom", description, date, hours, billable, amount) with "Edit lines" for drafts (`invoice.update`); "Download document"; "Send by email" (`invoice.update`); status changes draft → sent → paid (and paid → sent); "Delete" (`invoice.delete`, drafts without receipts); its receipts; history.

### Receipts (`/receipts`, `/receipts/[id]`)
- Head: "Receipts", subtitle "Money clients paid in." Action "New receipt" with `receipt.create`.
- Filters: bank account, client, dates. Table: date, client, bank account, amount, bank fee, net, allocated, unallocated, "Reversed" or "Reversal" pill.
- Receipt page: details, the allocations table (invoice, amount, "Remove" with `receipt.update`), "Allocate to an invoice" (`receipt.update`, the client's open invoices in the same currency, never above what's left), "Reverse" (`receipt.delete`, once allocations are removed), evidence.

### Payroll (`/payroll`, `/payroll/[id]`)
- Head: "Payroll", subtitle "Monthly pay, from approved salaries and project incentives." Action "New payroll run" with `payrollRun.create` (month, year, bank account, notes).
- Filters: year, status chips. Table: month, status pill, people, paid count, totals per currency.
- Run page: details and actions by status: Edit notes, bank account and deductions, and Submit (`payrollRun.update`, draft), Delete (`payrollRun.delete`, draft), Approve and Return with a reason (`payrollRun.approve`, pending approval, not your own). Items table: person, salary, incentive, deductions, gross, net, currency, settlement pill; once approved, "Settle" per item (`payrollRun.update`: paid, failed or returned, with reference and notes). Each item has its evidence.

### Bank accounts (`/bank-accounts`, `/bank-accounts/[id]`)
- Head: "Bank accounts", subtitle "Where the company's money is, and what moved through it." Action "New bank account" with `bankAccount.create`.
- Table: name, bank, currency, current balance, status pill.
- Account page: details with "Edit" (`bankAccount.update`, including making it inactive) and a **Statement card** with from and to dates: opening balance, each movement (date, kind in words, amount with money out in red, balance after) and closing balance.

### Vendors and Categories (`/vendors`, `/categories`)
- Lists with status chips and search, "New vendor" or "New category" with `.create`, and a page with details, "Edit" (`.update`, including inactive) and history. Categories show their parent and code.

### Company bank details (`/company-bank-details`)
- One card of the details printed on invoices, with "Edit" (`companyBankDetails.update`).

`/` sends people to the first of these they may open, or says "Your Accounts profile doesn't include any screens yet."

Routes this module can call:

| Route | Needs |
|---|---|
| `GET /accounts/categories` | `category.read` |
| `POST /accounts/categories` | `category.create` |
| `GET /accounts/categories/:id` | `category.read` |
| `PATCH /accounts/categories/:id` | `category.update` |
| `GET /accounts/categories/:id/history` | `category.read` |
| `GET /accounts/vendors` | `vendor.read` |
| `POST /accounts/vendors` | `vendor.create` |
| `GET /accounts/vendors/:id` | `vendor.read` |
| `PATCH /accounts/vendors/:id` | `vendor.update` |
| `GET /accounts/vendors/:id/history` | `vendor.read` |
| `GET /accounts/bank-accounts` | `bankAccount.read` |
| `POST /accounts/bank-accounts` | `bankAccount.create` |
| `GET /accounts/bank-accounts/:id` | `bankAccount.read` |
| `PATCH /accounts/bank-accounts/:id` | `bankAccount.update` |
| `GET /accounts/bank-accounts/:id/statement` | `bankAccount.read` |
| `GET /accounts/bank-accounts/:id/history` | `bankAccount.read` |
| `GET /accounts/company-bank-details` | `companyBankDetails.read` |
| `PATCH /accounts/company-bank-details` | `companyBankDetails.update` |
| `GET /accounts/bills` | `bill.read` |
| `POST /accounts/bills` | `bill.create` |
| `GET /accounts/bills/:id` | `bill.read` |
| `PATCH /accounts/bills/:id` | `bill.update` |
| `DELETE /accounts/bills/:id` | `bill.delete` |
| `POST /accounts/bills/:id/submit` | `bill.update` |
| `POST /accounts/bills/:id/approve` | `bill.approve` |
| `POST /accounts/bills/:id/reject` | `bill.approve` |
| `POST /accounts/bills/:id/reverse` | `bill.delete` |
| `GET /accounts/bills/:id/history` | `bill.read` |
| `GET /accounts/payments` | `payment.read` |
| `POST /accounts/payments` | `payment.create` |
| `GET /accounts/payments/:id` | `payment.read` |
| `POST /accounts/payments/:id/reverse` | `payment.delete` |
| `GET /accounts/receipts` | `receipt.read` |
| `POST /accounts/receipts` | `receipt.create` |
| `GET /accounts/receipts/:id` | `receipt.read` |
| `POST /accounts/receipts/:id/allocations` | `receipt.update` |
| `DELETE /accounts/receipts/:id/allocations/:allocationId` | `receipt.update` |
| `POST /accounts/receipts/:id/reverse` | `receipt.delete` |
| `GET /accounts/invoices` | `invoice.read` |
| `POST /accounts/invoices` | `invoice.create` |
| `GET /accounts/invoices/unbilled` | `invoice.read` |
| `GET /accounts/invoices/preview` | `invoice.read` |
| `GET /accounts/invoices/:id` | `invoice.read` |
| `PATCH /accounts/invoices/:id` | `invoice.update` |
| `DELETE /accounts/invoices/:id` | `invoice.delete` |
| `PATCH /accounts/invoices/:id/lines` | `invoice.update` |
| `GET /accounts/invoices/:id/document` | `invoice.read` |
| `POST /accounts/invoices/:id/send` | `invoice.update` |
| `GET /accounts/invoices/:id/history` | `invoice.read` |
| `GET /accounts/payroll-runs` | `payrollRun.read` |
| `POST /accounts/payroll-runs` | `payrollRun.create` |
| `GET /accounts/payroll-runs/:id` | `payrollRun.read` |
| `PATCH /accounts/payroll-runs/:id` | `payrollRun.update` |
| `DELETE /accounts/payroll-runs/:id` | `payrollRun.delete` |
| `POST /accounts/payroll-runs/:id/submit` | `payrollRun.update` |
| `POST /accounts/payroll-runs/:id/approve` | `payrollRun.approve` |
| `POST /accounts/payroll-runs/:id/return` | `payrollRun.approve` |
| `PATCH /accounts/payroll-runs/:id/items/:itemId` | `payrollRun.update` |
| `GET /accounts/payroll-runs/:id/history` | `payrollRun.read` |
| `GET /accounts/documents` | `document.read` |
| `POST /accounts/documents` | `document.create` |
| `POST /accounts/documents/:id/part-urls` | `document.create` |
| `POST /accounts/documents/:id/complete` | `document.create` |
| `GET /accounts/documents/:id/url` | `document.read` |
| `DELETE /accounts/documents/:id` | `document.create` |

## 6. Look and feel

- Use `design.css` **unchanged** as the start of `globals.css`. It holds the colours (light and dark), fonts, spacing and every component class. Add module-only styles in a "Module additions" section at the end, using its colour variables (`var(--accent)` and so on). No inline styles, no new colours, no new fonts, no icons.
- Layout: a 216px sidebar and the page beside it (`.shell`, `.sidebar`), collapsing at phone width as `design.css` does.
- Build every screen from these pieces (in `components/ui.tsx`), using the class names from `design.css`:

| Piece | Markup and behaviour |
|---|---|
| `PageHead` | `.page-head`: `h1` title, one-line subtitle `p`, actions on the right in `.page-actions` |
| `Card` | `section.card`, optional `.card-head` with an `h2` title and something on the right |
| `Row` | `.row`: a label and its value, for read-only details |
| `Pill` | `.pill.pill-<tone>`: `accent`, `good`, `warning`, `danger`, `neutral` |
| `Notice` | `p.notice.notice-<good|danger|warning>`, `role="alert"` for danger |
| `Chips` | `.chips` of `button.chip` with `aria-pressed`, for one-of filters |
| `Pagination` | `nav.pagination`: "1 to 25 of 80" and Previous/Next |
| `Loaded` | Shows "Loading…", or the error with "Try again" (not for 403/404), or the content |
| `TextField`, `TextAreaField`, `SelectField` | `.field` with a `label`, an `.input`, and an optional `.hint` |
| `Dialog`, `FormDialog`, `ConfirmDialog` | A modal with a title, content and buttons; Escape and the close button close it; the form's error shows inside it |
| Tables | `.table-box` around a `table` with `th scope="col"`; links in cells use `.link` |
| Empty state | `p.empty`, such as "Nothing matches." |
| Buttons | `.btn`, `.btn-primary` for the main action, `.btn-danger` for destructive ones |

- Status colours and labels are in `DATA_MODEL.md`.
- Every list: page size 25, filters in a card above, a card holding the table, an empty state and pagination.
- Every change goes through a dialog; destructive or irreversible ones ask first with `ConfirmDialog`. While saving, the button is disabled and says what it's doing ("Saving…"). After saving, close the dialog and reload what changed.

## 7. Words

- Plain, short, sentence case ("New record", not "New Record").
- Buttons say what happens: "Approve", "Save changes", "Delete". Not "OK" or "Submit".
- Dates: `13 Nov 2026`. Calendar days are shown in UTC so they never slip a day. Times: `13 Nov, 14:05`. Hours: `6 h`. Numbers: `1,250`. Money: `৳12,500`. Missing: `·`.
- API keys shown to people go through one function that turns `on_hold` into "On hold".
- Error messages come from the API. Don't write your own for API failures.
- The four gates: loading ("Loading…"), signed out ("Sign in to TwinTrack. Accounts uses your TwinTrack sign-in. Sign in there, then open Accounts again." with "Go to sign in" to `<MASTER_URL>/sign-in`), no access (section 4), and unavailable ("TwinTrack can't be reached. The API isn't answering. Check that it is running, then reload this page.").
- A screen the person can't open shows "Your access doesn't include this screen."

## 8. Code

- Readable names, small focused components, no `any`. Types come from `schema.json`.
- `useLoad(loader, dependencies)` for reading: keeps earlier data on screen while reloading, ignores late answers, and doesn't offer a retry for 403 or 404.
- `useSubmit()` for writing: busy flag, error message, returns whether it worked.
- Send `version` with every edit that takes it. On `409 version_conflict`, show the message and reload the record.
- Only `http:` and `https:` addresses become links.
- Comments only where the reason isn't obvious.

## 9. Done means

A screen is done when:

1. `npm run typecheck` and `npm run build` pass.
2. You used it in a browser against the API, signed in as the test accounts you were given: one with full access, one with little, and one with none. Each sees only what their access allows, and the buttons match the rules in section 4.
3. Loading, empty, error, no-access and phone-width layouts all look right.
4. Your summary says what you built, what you couldn't check, and anything in the API or these instructions that seemed wrong or missing. Never say something works if you didn't see it work.
