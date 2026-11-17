import { AccessProfile } from './accessProfile.js';
import { ApiToken } from './apiToken.js';
import { AuditLog } from './auditLog.js';
import { Client } from './client.js';
import { Counter } from './counter.js';
import { HandoffCode } from './handoffCode.js';
import { CustomRecord } from './customRecord.js';
import { Module } from './module.js';
import { OAuthAuthorizationRequest, OAuthClient, OAuthGrant } from './oauth.js';
import { OrgRole } from './orgRole.js';
import { PasswordLink } from './passwordLink.js';
import { RateLimitCounter } from './rateLimitCounter.js';
import { RecordHistory } from './recordHistory.js';
import { RecordShare } from './recordShare.js';
import { Session } from './session.js';
import { User } from './user.js';
import { UserPhoto } from './userPhoto.js';

export const masterModels = [User, Session, Module, AuditLog, RateLimitCounter, OrgRole, AccessProfile, RecordHistory, RecordShare, CustomRecord, PasswordLink, HandoffCode, Counter, UserPhoto, Client, ApiToken, OAuthClient, OAuthAuthorizationRequest, OAuthGrant];
