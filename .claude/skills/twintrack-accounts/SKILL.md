---
name: twintrack-accounts
description: "Domain rules and map for the TwinTrack Accounts module. Use whenever work touches backend/src/modules/accounts/, manifests/accounts.*, docs/api/accounts.md, module-packs/accounts/ or the twintrack-accounts frontend, or mentions the ledger, journal entries, chart of accounts, vouchers, bills, invoices, payroll, bank reconciliation, trial balance or other bookkeeping in TwinTrack. It covers money handling, the ledger-only write rule, maker-checker approvals and the tests Accounts work must add. Use it together with twintrack-sync, which still handles manifests, Postman, docs and packs."
---

# TwinTrack Accounts

Accounts is bookkeeping for the company's real money, so a bug here is a wrong balance, not a broken screen. This skill holds only what is specific to Accounts. The general rules (access, profiles, records, field security, the route checklist) are in `twintrack-master/CLAUDE.md` and `docs/adding-an-api.md`; follow them first. After any backend change, run **twintrack-sync**.

## Where things are

| Part | Path (from `twintrack-master/`) |
|---|---|
| Routes and services | `backend/src/modules/accounts/<feature>/`, one folder per feature |
| Route list | `backend/src/modules/accounts/accounts.routes.ts`, module key in `accountsModule.ts` |
| Ledger core | `backend/src/modules/accounts/ledger/` (`postEntry`, `reverseEntry`, `getTrialBalance`) |
| Models | `backend/src/modules/accounts/models/`, registered in `backend/src/modules/models.ts` |
| Contract | `manifests/accounts.manifest.json`, `manifests/accounts.schema.json` |
| API doc | `docs/api/accounts.md` |
| Tests | `backend/tests/accounts-*.test.ts` |
| Frontend | `../twintrack-accounts/` on `accounts.twintrack.localhost:3400` |
| Build plan | `../account module/accounts-plan.md` (local workspace only; the day list and gates) |

Read the plan's current day before starting a feature, and build in its order: everything depends on the ledger.

## Reference artifacts

| Artifact | Link | Use it for |
|---|---|---|
| Specification | https://claude.ai/artifact/VQ4YnLX9zT8XCzRxEnLuZa | The 40 pages and 38 record types: fields, states and workflows of each feature |
| UI | https://claude.ai/artifact/JGXDRVqjsDkny6r2u5Z73N | Screen layouts for the `twintrack-accounts` frontend |

Read them with the Artifact tool (`action: "read"`), never with WebFetch; they are private and need the owner's sign-in. Read only the section for the feature you are building. They describe what to build, not how: where they disagree with the rules below or the agreed decisions, the rules and decisions win, so say so rather than follow the artifact. The links are also kept in `../account module/artifacts`.

## The rules that matter

1. **Money is an integer.** Store and compute whole paisa or cents (`number`, always `Number.isInteger`). Never floats, never decimal strings in the database. Convert only at the edge (API input in minor units, display in the frontend). Rounding, such as a USD rate conversion, happens once, in one named function, and the rounding rule is tested.
2. **Only the ledger core writes ledger entries.** Every feature (voucher, bill, invoice, payroll, asset) calls `postEntry` or `reverseEntry`. No other code inserts into or updates the ledger entries collection. Don't add a repository function that edits an entry.
3. **Debits equal credits, always.** `postEntry` refuses an unbalanced entry (`422 unbalanced_entry`) and needs at least two lines, each with exactly one side above zero. Don't weaken this to make a feature work: fix the feature's lines.
4. **Posted entries are never edited or deleted.** A mistake is corrected by `reverseEntry` (mirrored lines, `reversalOf` / `reversedBy`) and, if needed, a new entry. A recorded voucher changes only through an approved update request (plan Day 2).
5. **One transaction per money change.** The source record, its history (`writeRecordHistory`) and its ledger lines save in the same `ClientSession`, or none do. Pass the session into `postEntry`; never post outside the feature's transaction.
6. **Every entry names its source** (`source: { type, id }`), so the ledger can be traced back to the voucher or bill that made it.
7. **Balances are computed, never typed.** Bank, cash, receivable and payable balances come from opening balance plus ledger lines. No stored balance field that code updates by hand.
8. **Maker can't approve.** Whoever created a voucher, bill, payroll run or update request can't approve, reject or return it, super admins included (`403 own_record`). The stand-in approver from Settings approves when the CEO is away. This is a safety rule in code, like the super admin rules; everything else comes from profiles.
9. **Accounts are deactivated, never deleted.** Ledger lines name them. Refuse posting to an inactive account, and refuse changing an account's `type` once it has lines.
10. **Dates are `YYYY-MM-DD` strings** for accounting dates (`entryDate`, issue date), so they never shift with time zones. Validate them as real dates.
11. **Sensitive numbers are protected fields.** Bank account numbers and salaries go in the resource's `protectedFields`, hidden unless a grant names them. Redact responses and history with `redactRecord` / `redactHistory`.
12. **Accounts reads other modules only through their published helpers** (Project management billing in `modules/projects/billing/`). Never import another module's models.

## Decisions already made (don't ask again)

- Payroll uses dummy employee data until HR is built.
- Several currencies: the books are in taka, and Settings keeps a rate per currency by date. A document in another currency uses that currency's rate on its date (an invoice: its issue date).
- One stand-in approver, set in Settings.
- Regular expenses create draft bills that a person approves.
- Inventory has an asset tag text field and no return-to-vendor flow.
- Tax rates are set in Settings, with no challan format.
- Files go in the existing storage, with no retention rule.
- Bank statements are CSV only.

## Tests every Accounts change adds

Next to the usual route tests (success, `401`, `403`, `400`), add the ones that fit:

- The feature's ledger lines balance, and the trial balance `difference` stays `0` after it.
- Reversing the feature's entry nets every touched account back to its previous balance.
- A failure halfway (bad line, unknown account) leaves no record, no history and no ledger lines: the transaction rolled back.
- The maker approving their own record gets `403 own_record`, including as super admin.
- A recorded or approved record refuses edits (`409`), and only the allowed state changes work.
- A profile without the protected-field grant sees the bank or salary number hidden, in the record and in its history.
- Amounts with odd minor units (for example 1 paisa, or a rate conversion that rounds) give the expected integer.

## Before finishing

1. Check the diff against the rules above, especially 2, 4 and 5.
2. Run twintrack-sync (manifest, `seed:modules`, Postman, `/try`, `docs/api/accounts.md`, the pack).
3. Run `npm run typecheck`, `npm run lint` and the Accounts tests (`npx vitest run tests/accounts-` from `backend/`), then `npm test`.
4. Say which plan day and gate the work moves forward, and what is still missing for that gate.
