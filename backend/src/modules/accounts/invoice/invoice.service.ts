import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AccountsSettings } from '../../../config.js';
import { isDuplicateKeyError, runInTransaction } from '../../../db.js';
import type { EmailSender } from '../../../lib/email/emailSender.js';
import { ApiError } from '../../../lib/errors.js';
import { escapeRegex, type PageRequest } from '../../../lib/query.js';
import { changeRecord, moveToRecycleBin } from '../../../lib/records/recordWrites.js';
import { WITH_DELETED } from '../../../lib/records/recordFields.js';
import type { FileStorage } from '../../../lib/storage/fileStorage.js';
import type { Actor } from '../../master/access/caller.js';
import { findClientById } from '../../master/clients/clients.repository.js';
import { assertMayWriteFields, redactRecord, type FieldRules } from '../../master/records/fieldSecurity.service.js';
import {
  findBillableProjects,
  findClientProjects,
  findCompletedTasks,
  findCreatedTasks,
  markTasksInvoiced,
  releaseInvoicedTasks,
  sumUnbilledHours,
  type BillableProject,
  type BillableTask,
} from '../../tasks/billing/taskBilling.js';
import { fieldRulesFor, invalidField, MONEY_TOLERANCE, readRecordHistory, roundMoney, writeAccountsRecord, writeAccountsRecordIn, type Currency } from '../accountsModule.js';
import { endOfDay, findRecordPage, requireRecord } from '../accountsFields.js';
import { readCompanyBankDetails } from '../bankAccount/bankAccount.service.js';
import { Invoice, type InvoiceBasis, type InvoiceDoc, type InvoiceLine, type InvoiceProjectTotal, type InvoiceStatus } from '../models/invoice.js';
import { sumInvoiceAllocations } from '../receipt/receipt.service.js';
import { INVOICE_DOCUMENT_TYPE, renderInvoiceDocument } from './invoiceDocument.js';
import { deriveClientInitials, invoiceNumberFor } from './invoiceNumber.js';

const RESOURCE = 'invoice';
/** Tries for a free invoice number this many times, for two invoices to one client made at the same moment. */
const NUMBER_ATTEMPTS = 5;
const PERIOD_DAYS_LIMIT = 366;
const DAY_MS = 86_400_000;
/** INVOICE_HOURLY_RATE_USD is in this currency, so it's only a default for invoices in it. */
const DEFAULT_RATE_CURRENCY: Currency = 'USD';

export const invoiceNotFound = () => new ApiError(404, 'unknown_invoice', 'No such invoice.');

/**
 * Which work to bill: everything finished in the period for one client's projects, or everything logged in the period
 * for chosen projects of one client, at any status, with custom lines too.
 */
export type InvoiceSelection =
  | { clientId: string; projectIds?: undefined; from: Date; to: Date }
  | { clientId?: undefined; projectIds: string[]; from: Date; to: Date };

export interface CustomLine {
  projectId: string;
  description: string;
  hours: number;
  billable?: boolean;
}

export type InvoiceRequest = InvoiceSelection & { hourlyRate?: number; currency?: Currency; customLines?: CustomLine[]; additionalNotes?: string };

/** Moving between these is allowed. Once sent, an invoice never goes back to draft, because the client has it. */
const STATUS_MOVES: Record<InvoiceStatus, readonly InvoiceStatus[]> = { draft: ['sent'], sent: ['paid'], paid: ['sent'] };

interface Selected {
  clientId: string;
  basis: InvoiceBasis;
  projects: BillableProject[];
  tasks: BillableTask[];
}

/** The projects and tasks a selection names, checked to be one client's. */
async function select(selection: InvoiceSelection): Promise<Selected> {
  if (selection.to < selection.from) throw invalidField('to', 'must be on or after from');
  if ((selection.to.getTime() - selection.from.getTime()) / DAY_MS > PERIOD_DAYS_LIMIT) throw invalidField('to', `the period can't be longer than ${PERIOD_DAYS_LIMIT} days`);
  const before = endOfDay(selection.to);

  if (selection.clientId) {
    if (!(await findClientById(selection.clientId))) throw invalidField('clientId', 'no such client');
    const projects = await findClientProjects(selection.clientId);
    const tasks = await findCompletedTasks(projects.map((project) => project.id), selection.from, before);
    return { clientId: selection.clientId, basis: 'completed', projects, tasks };
  }

  const projectIds = [...new Set(selection.projectIds)];
  const projects = await findBillableProjects(projectIds);
  if (projects.length !== projectIds.length) throw invalidField('projectIds', 'names a project that does not exist');
  const clientIds = new Set(projects.map((project) => project.clientId));
  if (clientIds.has(undefined)) throw invalidField('projectIds', 'names a project with no client');
  if (clientIds.size > 1) throw invalidField('projectIds', 'must all be for the same client');
  const tasks = await findCreatedTasks(projectIds, selection.from, before);
  return { clientId: projects[0]!.clientId!, basis: 'logged', projects, tasks };
}

/** Lines priced at the rate. Non-billable lines show their hours but charge nothing. */
function priceLines(tasks: BillableTask[], customLines: CustomLine[], rate: number): InvoiceLine[] {
  const today = new Date();
  return [
    ...tasks.map((task) => ({ _id: `il_${randomUUID()}`, projectId: task.projectId, taskId: task.id, taskNumber: task.number, description: task.title, date: task.date, hours: task.hours, billable: task.billable, amount: 0 })),
    ...customLines.map((line) => ({ _id: `il_${randomUUID()}`, projectId: line.projectId, description: line.description, date: today, hours: line.hours, billable: line.billable ?? true, amount: 0 })),
  ].map((line) => ({ ...line, amount: line.billable ? roundMoney(line.hours * rate) : 0 }));
}

/**
 * Per-project and overall totals of these lines. Amounts add up the lines' own rounded amounts, so the total always
 * equals the sum of the lines printed above it.
 */
function totalLines(lines: InvoiceLine[], projects: BillableProject[]) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const byProject = new Map<string, InvoiceProjectTotal>();
  for (const line of lines) {
    const total = byProject.get(line.projectId) ?? { projectId: line.projectId, projectName: names.get(line.projectId) ?? line.projectId, totalHours: 0, billableHours: 0, amount: 0 };
    total.totalHours = roundMoney(total.totalHours + line.hours);
    if (line.billable) total.billableHours = roundMoney(total.billableHours + line.hours);
    total.amount = roundMoney(total.amount + line.amount);
    byProject.set(line.projectId, total);
  }
  const projectTotals = [...byProject.values()];
  const sum = (field: 'totalHours' | 'billableHours' | 'amount') => roundMoney(projectTotals.reduce((running, total) => running + total[field], 0));
  return { projects: projectTotals, totalHours: sum('totalHours'), billableHours: sum('billableHours'), amount: sum('amount') };
}

/** Refuses a change that would leave an invoice owing less than receipts already count against it. */
async function assertCoversAllocations(invoiceId: string, amount: number, session: ClientSession): Promise<void> {
  const allocated = (await sumInvoiceAllocations([invoiceId], session)).get(invoiceId) ?? 0;
  if (amount < allocated - MONEY_TOLERANCE) {
    throw new ApiError(409, 'invoice_allocated', `Receipts already count ${allocated.toFixed(2)} against this invoice. Remove allocations before lowering it to ${amount.toFixed(2)}.`);
  }
}

/** Invoices: billing a client's work from Tasks, as a Word document that can be emailed. */
export function createInvoiceService(settings: AccountsSettings, storage: FileStorage, emailSender: EmailSender) {
  const label = (invoice: InvoiceDoc) => invoice.invoiceNumber;

  async function toViews(actor: Actor, invoices: InvoiceDoc[], withLines = false) {
    const [rules, paid] = await Promise.all([fieldRulesFor(actor, RESOURCE), sumInvoiceAllocations(invoices.map((invoice) => invoice._id))]);
    return invoices.map((invoice) => toView(invoice, rules, paid.get(invoice._id) ?? 0, withLines));
  }

  function toView(invoice: InvoiceDoc, rules: FieldRules, paid: number, withLines: boolean) {
    return redactRecord(
      {
        id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        clientId: invoice.clientId,
        clientName: invoice.clientName,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        basis: invoice.basis,
        currency: invoice.currency,
        hourlyRate: invoice.hourlyRate,
        totalHours: invoice.totalHours,
        billableHours: invoice.billableHours,
        amount: invoice.amount,
        // From receipts allocated to it, never typed in.
        paidAmount: paid,
        outstandingAmount: roundMoney(invoice.amount - paid),
        status: invoice.status,
        projects: invoice.projects,
        ...(withLines && {
          lines: invoice.lines.map(({ _id, ...line }) => ({ id: _id, ...line, custom: !line.taskId })),
        }),
        additionalNotes: invoice.additionalNotes,
        hasDocument: Boolean(invoice.documentKey),
        documentVersion: invoice.documentVersion,
        emailedAt: invoice.emailedAt,
        emailedTo: invoice.emailedTo,
        version: invoice.version,
        createdBy: invoice.createdBy,
        createdAt: invoice.createdAt,
        updatedBy: invoice.updatedBy,
        updatedAt: invoice.updatedAt,
      },
      rules,
    );
  }

  /** Makes the Word document from the invoice as saved, replacing the last one, and returns the invoice with it. */
  async function renderDocument(actor: Actor, invoice: InvoiceDoc): Promise<InvoiceDoc> {
    const [client, bankDetails] = await Promise.all([findClientById(invoice.clientId), readCompanyBankDetails()]);
    const document = await renderInvoiceDocument({ invoice, clientAddress: client?.address, company: { name: settings.companyName, address: settings.companyAddress }, bankDetails });
    const documentKey = `invoices/${invoice._id}.docx`;
    await storage.putObject(documentKey, document, INVOICE_DOCUMENT_TYPE);
    return runInTransaction((session) =>
      changeRecord(Invoice, invoice._id, { $set: { documentKey }, $inc: { documentVersion: 1 } }, { actorId: actor.user._id, session }, invoiceNotFound),
    );
  }

  /** The next free number for this client today. The unique index settles a race between two at once. */
  async function nextInvoiceNumber(initials: string, today: Date, attempt: number): Promise<string> {
    const first = invoiceNumberFor(settings.invoiceNumberPrefix, initials, today, 1);
    const sameDay = await Invoice.countDocuments({ invoiceNumber: { $regex: `^${escapeRegex(first)}(-\\d+)?$` } }).setOptions(WITH_DELETED);
    return invoiceNumberFor(settings.invoiceNumberPrefix, initials, today, sameDay + 1 + attempt);
  }

  async function listInvoices(actor: Actor, query: PageRequest & { status?: InvoiceStatus; clientId?: string }) {
    const { status, clientId, ...page } = query;
    const { records, total } = await findRecordPage(Invoice, { ...(status && { status }), ...(clientId && { clientId }) }, page);
    return { total, invoices: await toViews(actor, records) };
  }

  async function getInvoice(actor: Actor, invoiceId: string) {
    const [view] = await toViews(actor, [await requireRecord(Invoice, invoiceId, invoiceNotFound)], true);
    return view!;
  }

  /** Finished work no invoice has billed yet, by project, with the client each is for. */
  async function getUnbilledHours() {
    const projects = await sumUnbilledHours();
    const clients = await Promise.all([...new Set(projects.map((project) => project.clientId).filter((id): id is string => Boolean(id)))].map((id) => findClientById(id)));
    const clientNames = new Map(clients.filter((client) => client !== null).map((client) => [client._id, client.name]));
    return {
      totalHours: roundMoney(projects.reduce((sum, project) => sum + project.hours, 0)),
      projects: projects.map((project) => ({ ...project, clientName: project.clientId ? clientNames.get(project.clientId) : undefined })),
    };
  }

  /** What an invoice for this selection would bill, without saving anything. */
  async function previewInvoice(selection: InvoiceSelection & { hourlyRate?: number }) {
    const selected = await select(selection);
    const rate = selection.hourlyRate ?? settings.defaultInvoiceHourlyRate;
    const lines = priceLines(selected.tasks, [], rate);
    return {
      clientId: selected.clientId,
      basis: selected.basis,
      hourlyRate: rate,
      ...totalLines(lines, selected.projects),
      lines: lines.map(({ _id, ...line }) => {
        const task = selected.tasks.find((candidate) => candidate.id === line.taskId);
        return { ...line, status: task?.status, alreadyInvoicedBy: task?.invoiceId };
      }),
    };
  }

  /** Bills the selected work: saves the invoice, marks its tasks billed in the same transaction, then makes the document. */
  async function createInvoice(actor: Actor, request: InvoiceRequest) {
    assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), ['hourlyRate', 'additionalNotes'].filter((field) => field in request), 'create');
    const { hourlyRate, currency = DEFAULT_RATE_CURRENCY, customLines = [], additionalNotes, ...selection } = request;
    if (hourlyRate === undefined && currency !== DEFAULT_RATE_CURRENCY) {
      throw invalidField('hourlyRate', `is required for an invoice in ${currency}, because INVOICE_HOURLY_RATE_USD is in ${DEFAULT_RATE_CURRENCY}`);
    }
    const rate = hourlyRate ?? settings.defaultInvoiceHourlyRate;
    if (rate <= 0) throw invalidField('hourlyRate', 'is required, because INVOICE_HOURLY_RATE_USD sets no default');
    if (customLines.length > 0 && !selection.projectIds) throw invalidField('customLines', 'can only be added when choosing projects');

    const selected = await select(selection as InvoiceSelection);
    const projectIds = new Set(selected.projects.map((project) => project.id));
    customLines.forEach((line, index) => {
      if (!projectIds.has(line.projectId)) throw invalidField(`customLines.${index}.projectId`, 'must be one of projectIds');
    });
    const lines = priceLines(selected.tasks, customLines, rate);
    if (lines.length === 0) throw new ApiError(422, 'nothing_to_invoice', 'There is no work to bill for this client in this period.');

    const client = await findClientById(selected.clientId);
    if (!client) throw invalidField('clientId', 'no such client');
    const totals = totalLines(lines, selected.projects);
    const today = new Date();
    const initials = client.initials?.trim() || deriveClientInitials(client.name);

    for (let attempt = 0; ; attempt += 1) {
      const invoiceNumber = await nextInvoiceNumber(initials, today, attempt);
      try {
        const invoice = await runInTransaction(async (session) => {
          const created = await writeAccountsRecordIn(
            actor,
            {
              resource: RESOURCE,
              auditAction: 'invoice.created',
              write: async (writeSession) => {
                const [saved] = await Invoice.create(
                  [{
                    _id: `inv_${randomUUID()}`,
                    invoiceNumber,
                    clientId: client._id,
                    clientName: client.name,
                    periodStart: selection.from,
                    periodEnd: selection.to,
                    basis: selected.basis,
                    currency,
                    hourlyRate: rate,
                    ...totals,
                    lines,
                    additionalNotes,
                    createdBy: actor.user._id,
                    updatedBy: actor.user._id,
                  }],
                  { session: writeSession },
                );
                return saved!.toObject();
              },
              label,
            },
            session,
          );
          await markTasksInvoiced(lines.flatMap((line) => (line.taskId ? [line.taskId] : [])), created._id, session);
          return created;
        });
        await renderDocument(actor, invoice);
        return getInvoice(actor, invoice._id);
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt + 1 >= NUMBER_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Changes an invoice's status or notes. Notes go into the document, which is made again. Status moves draft to
   * sent to paid, and paid back to sent if a payment was recorded by mistake.
   */
  async function updateInvoice(actor: Actor, invoiceId: string, changes: { status?: InvoiceStatus; additionalNotes?: string; version?: number }) {
    const { version, ...fields } = changes;
    assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), Object.keys(fields), 'update');
    const existing = await requireRecord(Invoice, invoiceId, invoiceNotFound);
    if (fields.status && fields.status !== existing.status && !STATUS_MOVES[existing.status].includes(fields.status)) {
      throw new ApiError(409, 'invalid_status', `An invoice can't go from ${existing.status} to ${fields.status}.`);
    }
    const saved = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: fields.status && fields.status !== existing.status ? `invoice.${fields.status}` : 'invoice.updated',
      before: existing,
      write: (session) => changeRecord(Invoice, invoiceId, { $set: fields }, { actorId: actor.user._id, expectedVersion: version, session }, invoiceNotFound),
      label,
    });
    if (fields.additionalNotes !== undefined) await renderDocument(actor, saved);
    return getInvoice(actor, invoiceId);
  }

  /**
   * Corrects lines and the rate on a draft, such as a description the client shouldn't see. Totals and the document
   * follow. Tasks themselves don't change. Once sent, the client has the figures, so they stay.
   */
  async function updateInvoiceLines(actor: Actor, invoiceId: string, request: { hourlyRate?: number; lines?: { id: string; description?: string; hours?: number; billable?: boolean }[]; version?: number }) {
    assertMayWriteFields(await fieldRulesFor(actor, RESOURCE), ['lines', ...(request.hourlyRate !== undefined ? ['hourlyRate'] : [])], 'update');
    const existing = await requireRecord(Invoice, invoiceId, invoiceNotFound);
    if (existing.status !== 'draft') throw new ApiError(409, 'invalid_status', "Only a draft invoice's lines can change.");
    const edits = new Map((request.lines ?? []).map((line) => [line.id, line]));
    for (const id of edits.keys()) if (!existing.lines.some((line) => line._id === id)) throw invalidField('lines', `${id} is not a line of this invoice`);

    const rate = request.hourlyRate ?? existing.hourlyRate;
    const lines = existing.lines.map((line) => {
      const edit = edits.get(line._id);
      const merged = { ...line, description: edit?.description ?? line.description, hours: edit?.hours ?? line.hours, billable: edit?.billable ?? line.billable };
      return { ...merged, amount: merged.billable ? roundMoney(merged.hours * rate) : 0 };
    });
    const projects = existing.projects.map((project) => ({ id: project.projectId, name: project.projectName }));
    const totals = totalLines(lines, projects);
    const saved = await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'invoice.lines_changed',
      before: existing,
      // Checked in the transaction that writes the invoice, so an allocation made at the same moment conflicts with it.
      write: async (session) => {
        await assertCoversAllocations(invoiceId, totals.amount, session);
        return changeRecord(Invoice, invoiceId, { $set: { hourlyRate: rate, lines, ...totals } }, { actorId: actor.user._id, expectedVersion: request.version, session }, invoiceNotFound);
      },
      label,
    });
    await renderDocument(actor, saved);
    return getInvoice(actor, invoiceId);
  }

  /** A short-lived address for the document, made first if it's missing, such as after a failed generation. */
  async function getDocumentUrl(actor: Actor, invoiceId: string) {
    let invoice = await requireRecord(Invoice, invoiceId, invoiceNotFound);
    if (!invoice.documentKey) invoice = await renderDocument(actor, invoice);
    return { url: await storage.downloadUrl(invoice.documentKey!, { fileName: `${invoice.invoiceNumber}.docx`, contentType: INVOICE_DOCUMENT_TYPE, disposition: 'attachment' }) };
  }

  /** Emails the document to the client, or anyone named, and marks a draft sent. */
  async function sendInvoice(actor: Actor, invoiceId: string, request: { to?: string; subject?: string; message?: string }) {
    let invoice = await requireRecord(Invoice, invoiceId, invoiceNotFound);
    const client = await findClientById(invoice.clientId);
    const to = request.to ?? client?.contactEmail;
    if (!to) throw invalidField('to', "is required, because the client has no contact email");
    if (!invoice.documentKey) invoice = await renderDocument(actor, invoice);

    const subject = request.subject ?? `Invoice ${invoice.invoiceNumber} from ${settings.companyName}`;
    const message = request.message ?? `Please find attached invoice ${invoice.invoiceNumber}.`;
    const paragraphs = message.split(/\r?\n/).filter((line) => line.trim());
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await emailSender.send({
      to,
      subject,
      text: message,
      html: paragraphs.map((line) => `<p>${escape(line)}</p>`).join(''),
      attachments: [{ fileName: `${invoice.invoiceNumber}.docx`, content: await storage.readObject(invoice.documentKey!) }],
    });

    await writeAccountsRecord(actor, {
      resource: RESOURCE,
      auditAction: 'invoice.emailed',
      before: invoice,
      write: (session) =>
        changeRecord(Invoice, invoiceId, { $set: { emailedAt: new Date(), emailedTo: to, ...(invoice.status === 'draft' && { status: 'sent' }) } }, { actorId: actor.user._id, session }, invoiceNotFound),
      label,
    });
    return getInvoice(actor, invoiceId);
  }

  /**
   * A draft was never sent, so deleting it undoes it: its tasks count as unbilled again and its document goes. It stays
   * in the recycle bin for the record. A sent invoice is a real document the client has, so it can't be deleted.
   */
  async function deleteInvoice(actor: Actor, invoiceId: string): Promise<void> {
    const existing = await requireRecord(Invoice, invoiceId, invoiceNotFound);
    if (existing.status !== 'draft') throw new ApiError(409, 'invalid_status', 'Only a draft invoice can be deleted.');
    await runInTransaction(async (session) => {
      // Read in the transaction that deletes it, so an allocation made at the same moment conflicts instead of being lost.
      if ((await sumInvoiceAllocations([invoiceId], session)).get(invoiceId)) throw new ApiError(409, 'invoice_allocated', 'Remove the receipt allocations to this invoice first.');
      await writeAccountsRecordIn(
        actor,
        {
          resource: RESOURCE,
          auditAction: 'invoice.deleted',
          before: existing,
          historyAction: 'deleted',
          write: (writeSession) => moveToRecycleBin(Invoice, invoiceId, { actorId: actor.user._id, expectedVersion: existing.version, session: writeSession }, invoiceNotFound),
          label,
        },
        session,
      );
      await releaseInvoicedTasks(invoiceId, session);
    });
    if (existing.documentKey) await storage.deleteObject(existing.documentKey);
  }

  async function getInvoiceHistory(actor: Actor, invoiceId: string, page: PageRequest) {
    await requireRecord(Invoice, invoiceId, invoiceNotFound);
    return readRecordHistory(actor, RESOURCE, invoiceId, page);
  }

  return { listInvoices, getInvoice, getUnbilledHours, previewInvoice, createInvoice, updateInvoice, updateInvoiceLines, getDocumentUrl, sendInvoice, deleteInvoice, getInvoiceHistory };
}
