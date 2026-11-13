import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import type { SecretCipher } from '../../../lib/encryption.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import {
  activeStatusField,
  changesSomething,
  changesSomethingMessage,
  currencyField,
  dateField,
  isPeriodInOrder,
  nameField,
  periodFields,
  periodOrderMessage,
  shortTextField,
  textField,
  versionField,
} from '../accountsFields.js';
import { createBankAccountService } from './bankAccount.service.js';

// An opening balance can be below zero, for an overdrawn account.
const balanceField = z.number().min(-1_000_000_000_000).max(1_000_000_000_000);

const listQuerySchema = z.object({ ...paginationQueryFields, status: activeStatusField.optional() });
const pageQuerySchema = z.object(paginationQueryFields);
const statementQuerySchema = z.object(periodFields).refine(isPeriodInOrder, periodOrderMessage);
const createBodySchema = z.strictObject({
  name: nameField,
  bankName: shortTextField.optional(),
  accountNumber: shortTextField.optional(),
  currency: currencyField,
  openingBalance: balanceField.optional(),
  openingDate: dateField.optional(),
});
const updateBodySchema = z
  .strictObject({
    name: nameField.optional(),
    bankName: shortTextField.optional(),
    accountNumber: shortTextField.optional(),
    openingBalance: balanceField.optional(),
    openingDate: dateField.optional(),
    status: activeStatusField.optional(),
    version: versionField.optional(),
  })
  .refine(changesSomething, changesSomethingMessage);
const companyDetailsBodySchema = z.strictObject({
  bankName: shortTextField.optional(),
  accountName: shortTextField.optional(),
  accountNumber: shortTextField.optional(),
  branchName: shortTextField.optional(),
  routingNumber: shortTextField.optional(),
  swiftCode: shortTextField.optional(),
  address: textField.optional(),
  version: versionField.optional(),
});

/** The company's bank accounts, their statements, and the payment details printed on invoices. */
export function createBankAccountRoutes(cipher: SecretCipher): ApiRoute[] {
  const service = createBankAccountService(cipher);
  const id = (params: Record<string, unknown>) => String(params.id);

  const handleList: RequestHandler = async (req, res) => {
    res.json(await service.listBankAccounts(getActor(req), parseRequestQuery(listQuerySchema, req.query)));
  };
  const handleGet: RequestHandler = async (req, res) => {
    res.json(await service.getBankAccount(getActor(req), id(req.params)));
  };
  const handleCreate: RequestHandler = async (req, res) => {
    res.status(201).json(await service.createBankAccount(getActor(req), parseRequestBody(createBodySchema, req.body)));
  };
  const handleUpdate: RequestHandler = async (req, res) => {
    res.json(await service.updateBankAccount(getActor(req), id(req.params), parseRequestBody(updateBodySchema, req.body)));
  };
  const handleStatement: RequestHandler = async (req, res) => {
    res.json(await service.getStatement(id(req.params), parseRequestQuery(statementQuerySchema, req.query)));
  };
  const handleHistory: RequestHandler = async (req, res) => {
    res.json(await service.getBankAccountHistory(getActor(req), id(req.params), parseRequestQuery(pageQuerySchema, req.query)));
  };
  const handleGetDetails: RequestHandler = async (req, res) => {
    res.json(await service.getCompanyBankDetails(getActor(req)));
  };
  const handleSaveDetails: RequestHandler = async (req, res) => {
    res.json(await service.saveCompanyBankDetails(getActor(req), parseRequestBody(companyDetailsBodySchema, req.body)));
  };

  return [
    { method: 'GET', path: '/accounts/bank-accounts', access: 'private', permission: 'bankAccount.read', handler: handleList },
    { method: 'POST', path: '/accounts/bank-accounts', access: 'private', permission: 'bankAccount.create', handler: handleCreate },
    { method: 'GET', path: '/accounts/bank-accounts/:id', access: 'private', permission: 'bankAccount.read', handler: handleGet },
    { method: 'PATCH', path: '/accounts/bank-accounts/:id', access: 'private', permission: 'bankAccount.update', handler: handleUpdate },
    { method: 'GET', path: '/accounts/bank-accounts/:id/statement', access: 'private', permission: 'bankAccount.read', handler: handleStatement },
    { method: 'GET', path: '/accounts/bank-accounts/:id/history', access: 'private', permission: 'bankAccount.read', handler: handleHistory },
    { method: 'GET', path: '/accounts/company-bank-details', access: 'private', permission: 'companyBankDetails.read', handler: handleGetDetails },
    { method: 'PATCH', path: '/accounts/company-bank-details', access: 'private', permission: 'companyBankDetails.update', handler: handleSaveDetails },
  ];
}
