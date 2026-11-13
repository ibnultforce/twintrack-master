import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { activeStatusField, changesSomething, changesSomethingMessage, emailField, nameField, shortTextField, textField, versionField } from '../accountsFields.js';
import { createVendorService } from './vendor.service.js';

const detailFields = {
  contactName: shortTextField.optional(),
  contactEmail: emailField.optional(),
  contactPhone: shortTextField.optional(),
  address: textField.optional(),
  bankName: shortTextField.optional(),
  // Empty removes it.
  bankAccountNumber: shortTextField.optional(),
  notes: textField.optional(),
};

const listQuerySchema = z.object({ ...paginationQueryFields, status: activeStatusField.optional(), search: z.string().trim().max(100).optional() });
const pageQuerySchema = z.object(paginationQueryFields);
const createBodySchema = z.strictObject({ name: nameField, ...detailFields });
const updateBodySchema = z
  .strictObject({ name: nameField.optional(), ...detailFields, status: activeStatusField.optional(), version: versionField.optional() })
  .refine(changesSomething, changesSomethingMessage);

/** Vendors are made inactive rather than deleted, because bills and payments name them. */
export function createVendorRoutes(cipher: SecretCipher): ApiRoute[] {
  const service = createVendorService(cipher);
  const id = (params: Record<string, unknown>) => String(params.id);

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listVendors(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
  };
  const handleGet: RequestHandler = async (req, res) => {
    res.json(await service.getVendor(getActor(req), id(req.params)));
  };
  const handleCreate: RequestHandler = async (req, res) => {
    res.status(201).json(await service.createVendor(getActor(req), parseRequestBody(createBodySchema, req.body)));
  };
  const handleUpdate: RequestHandler = async (req, res) => {
    res.json(await service.updateVendor(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
  };
  const handleHistory: RequestHandler = async (req, res) => {
    res.json(await service.getVendorHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
  };

  return [
    { method: 'GET', path: '/accounts/vendors', access: 'private', permission: 'vendor.read', handler: handleList },
    { method: 'POST', path: '/accounts/vendors', access: 'private', permission: 'vendor.create', handler: handleCreate },
    { method: 'GET', path: '/accounts/vendors/:id', access: 'private', permission: 'vendor.read', handler: handleGet },
    { method: 'PATCH', path: '/accounts/vendors/:id', access: 'private', permission: 'vendor.update', handler: handleUpdate },
    { method: 'GET', path: '/accounts/vendors/:id/history', access: 'private', permission: 'vendor.read', handler: handleHistory },
  ];
}
