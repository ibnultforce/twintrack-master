import { AuditLog } from './auditLog.js';
import { Module } from './module.js';
import { Session } from './session.js';
import { User } from './user.js';

export const masterModels = [User, Session, Module, AuditLog];
