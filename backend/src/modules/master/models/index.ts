import { AccessProfile } from './accessProfile.js';
import { AuditLog } from './auditLog.js';
import { CustomRecord } from './customRecord.js';
import { Module } from './module.js';
import { OrgRole } from './orgRole.js';
import { RateLimitCounter } from './rateLimitCounter.js';
import { RecordHistory } from './recordHistory.js';
import { RecordShare } from './recordShare.js';
import { Session } from './session.js';
import { User } from './user.js';

export const masterModels = [User, Session, Module, AuditLog, RateLimitCounter, OrgRole, AccessProfile, RecordHistory, RecordShare, CustomRecord];
