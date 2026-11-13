import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AccountsSettings } from '../../../config.js';
import type { EmailSender } from '../../../lib/email/emailSender.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import type { FileStorage } from '../../../lib/storage/fileStorage.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import {
  amountField,
  currencyField,
  dateField,
  emailField,
  idField,
  nameField,
  positiveAmountField,
  requiredTextField,
  textField,
  versionField,
} from '../accountsFields.js';
import { INVOICE_STATUSES } from '../models/invoice.js';
import { createInvoiceService, type InvoiceRequest } from './invoice.service.js';

const MAX_PROJECTS = 50;
const MAX_CUSTOM_LINES = 200;
const MAX_LINE_EDITS = 2000;

// Exactly one of clientId (all its work finished in the period) or projectIds (all work logged in the period).
const oneSelection = ({ clientId, projectIds }: { clientId?: string; projectIds?: string[] }) => Boolean(clientId) !== Boolean(projectIds?.length);
const oneSelectionMessage = { message: 'send either clientId or projectIds', path: ['clientId'] };

const listQuerySchema = z.object({ ...paginationQueryFields, status: z.enum(INVOICE_STATUSES).optional(), clientId: idField.optional() });
const pageQuerySchema = z.object(paginationQueryFields);
// Query strings carry lists as a comma-separated value.
const previewQuerySchema = z
  .object({
    clientId: idField.optional(),
    projectIds: z.string().trim().max(2000).transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)).optional(),
    from: dateField,
    to: dateField,
    hourlyRate: z.coerce.number().positive().optional(),
  })
  .refine(oneSelection, oneSelectionMessage);
const createBodySchema = z
  .strictObject({
    clientId: idField.optional(),
    projectIds: z.array(idField).min(1).max(MAX_PROJECTS).optional(),
    from: dateField,
    to: dateField,
    hourlyRate: positiveAmountField.optional(),
    currency: currencyField.optional(),
    customLines: z
      .array(z.strictObject({ projectId: idField, description: nameField, hours: positiveAmountField, billable: z.boolean().optional() }))
      .max(MAX_CUSTOM_LINES)
      .optional(),
    additionalNotes: textField.optional(),
  })
  .refine(oneSelection, oneSelectionMessage);
const updateBodySchema = z
  .strictObject({ status: z.enum(INVOICE_STATUSES).optional(), additionalNotes: textField.optional(), version: versionField.optional() })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });
const linesBodySchema = z
  .strictObject({
    hourlyRate: positiveAmountField.optional(),
    lines: z.array(z.strictObject({ id: idField, description: nameField.optional(), hours: amountField.optional(), billable: z.boolean().optional() })).max(MAX_LINE_EDITS).optional(),
    version: versionField.optional(),
  })
  .refine(({ hourlyRate, lines }) => hourlyRate !== undefined || Boolean(lines?.length), { message: 'send hourlyRate or lines to change' });
const sendBodySchema = z.strictObject({ to: emailField.optional(), subject: nameField.optional(), message: requiredTextField.optional() });

/** Invoices bill clients for work in Tasks. settings name the company and the default rate. */
export function createInvoiceRoutes(settings: AccountsSettings, storage: FileStorage, emailSender: EmailSender): ApiRoute[] {
  const service = createInvoiceService(settings, storage, emailSender);
  const id = (params: Record<string, unknown>) => String(params.id);

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listInvoices(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
  };
  const handleUnbilled: RequestHandler = async (_req, res) => {
    res.json(await service.getUnbilledHours());
  };
  const handlePreview: RequestHandler = async (req, res) => {
    res.json(await service.previewInvoice(parseRequestQuery(previewQuerySchema, req.query) as InvoiceRequest));
  };
  const handleGet: RequestHandler = async (req, res) => {
    res.json(await service.getInvoice(getActor(req), id(req.params)));
  };
  const handleCreate: RequestHandler = async (req, res) => {
    res.status(201).json(await service.createInvoice(getActor(req), parseRequestBody(createBodySchema, req.body) as InvoiceRequest));
  };
  const handleUpdate: RequestHandler = async (req, res) => {
    res.json(await service.updateInvoice(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
  };
  const handleLines: RequestHandler = async (req, res) => {
    res.json(await service.updateInvoiceLines(getActor(req), id(req.params), parseRequestBody(linesBodySchema, req.body)));
  };
  const handleDocument: RequestHandler = async (req, res) => {
    res.json(await service.getDocumentUrl(getActor(req), id(req.params)));
  };
  const handleSend: RequestHandler = async (req, res) => {
    res.json(await service.sendInvoice(getActor(req), id(req.params), parseRequestBody(sendBodySchema, req.body ?? {})));
  };
  const handleDelete: RequestHandler = async (req, res) => {
    await service.deleteInvoice(getActor(req), id(req.params));
    res.status(204).end();
  };
  const handleHistory: RequestHandler = async (req, res) => {
    res.json(await service.getInvoiceHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
  };

  return [
    { method: 'GET', path: '/accounts/invoices', access: 'private', permission: 'invoice.read', handler: handleList },
    { method: 'POST', path: '/accounts/invoices', access: 'private', permission: 'invoice.create', handler: handleCreate },
    // Registered before /accounts/invoices/:id, which would otherwise read these names as invoice ids.
    { method: 'GET', path: '/accounts/invoices/unbilled', access: 'private', permission: 'invoice.read', handler: handleUnbilled },
    { method: 'GET', path: '/accounts/invoices/preview', access: 'private', permission: 'invoice.read', handler: handlePreview },
    { method: 'GET', path: '/accounts/invoices/:id', access: 'private', permission: 'invoice.read', handler: handleGet },
    { method: 'PATCH', path: '/accounts/invoices/:id', access: 'private', permission: 'invoice.update', handler: handleUpdate },
    { method: 'DELETE', path: '/accounts/invoices/:id', access: 'private', permission: 'invoice.delete', handler: handleDelete },
    { method: 'PATCH', path: '/accounts/invoices/:id/lines', access: 'private', permission: 'invoice.update', handler: handleLines },
    { method: 'GET', path: '/accounts/invoices/:id/document', access: 'private', permission: 'invoice.read', handler: handleDocument },
    { method: 'POST', path: '/accounts/invoices/:id/send', access: 'private', permission: 'invoice.update', handler: handleSend },
    { method: 'GET', path: '/accounts/invoices/:id/history', access: 'private', permission: 'invoice.read', handler: handleHistory },
  ];
}
