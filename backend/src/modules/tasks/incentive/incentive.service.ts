import { ApiError } from '../../../lib/errors.js';
import { currentMonth, type Month } from '../../../lib/period.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import type { IncentiveLedgerEntryDoc, IncentiveSettingDoc } from '../models/incentive.js';
import { assertCanReachProject, projectPeople, requireProject } from '../project/project.service.js';
import { assertPeopleExist, findPeopleNames, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  findIncentiveSetting,
  findIncentiveSettings,
  findLedgerEntries,
  findProjectIncentives,
  markLedgerEntryPaid,
  saveIncentiveSetting,
  saveProjectIncentive,
  sumLedHours,
  upsertUnpaidLedgerEntry,
  type IncentiveSettingChanges,
} from './incentive.repository.js';

const MONEY_DECIMALS = 100;
const roundMoney = (amount: number) => Math.round(amount * MONEY_DECIMALS) / MONEY_DECIMALS;

const outOfScope = () => new ApiError(403, 'out_of_scope', 'This person is outside what your access reaches.');

/** Money people decide for themselves would need nobody's approval, so these always go through someone else. */
function assertNotSelf(actor: Actor, userId: string): void {
  if (actor.user._id === userId) throw new ApiError(403, 'own_incentive', 'Someone else has to change or pay your own incentives.');
}

async function assertReachesPerson(actor: Actor, scope: Scope, userId: string): Promise<void> {
  const reached = await peopleInScope(actor.user._id, scope);
  if (reached && !reached.includes(userId)) throw outOfScope();
}

const incentiveAuditFields = (actor: Actor, targetId: string, targetName: string | undefined) => ({
  ...actorFields(actor),
  targetType: 'incentive',
  targetId,
  targetName,
  module: TASKS_MODULE_KEY,
});

/**
 * Monthly and project incentives. defaultHourlyRate applies to anyone whose setting names no rate of their own.
 * Every figure is worked out from finished tasks, never typed in, except project incentive amounts.
 */
export function createIncentiveService(defaultHourlyRate: number) {
  const rateOf = (setting: Pick<IncentiveSettingDoc, 'hourlyRate'> | null | undefined) => setting?.hourlyRate ?? defaultHourlyRate;

  const figuresFor = (hours: number, hourlyRate: number) => ({
    completedHours: roundMoney(hours),
    hourlyRate,
    totalPayout: roundMoney(hours * hourlyRate),
  });

  const toLedgerView = (entry: IncentiveLedgerEntryDoc) => ({
    id: entry._id,
    month: entry.month,
    year: entry.year,
    completedHours: entry.completedHours,
    hourlyRate: entry.hourlyRate,
    totalPayout: entry.totalPayout,
    disbursed: entry.disbursed,
    disbursedAt: entry.disbursedAt,
    disbursedBy: entry.disbursedBy,
  });

  /** Everyone in scope who earns the monthly incentive, with the month's figures as they stand and whether it's paid. */
  async function listMonth(actor: Actor, scope: Scope, month: Month = currentMonth()) {
    const settings = await findIncentiveSettings(await peopleInScope(actor.user._id, scope), true);
    const userIds = settings.map((setting) => setting._id);
    const [hours, ledger, names] = await Promise.all([sumLedHours(userIds, month), findLedgerEntries({ userIds, ...month }), findPeopleNames(userIds)]);
    const ledgerByUser = new Map(ledger.map((entry) => [entry.userId, entry]));

    const people = settings.map((setting) => {
      const paid = ledgerByUser.get(setting._id);
      // A paid month shows what was paid. An unpaid one shows today's figures.
      const figures = paid?.disbursed ? paid : figuresFor(hours.get(setting._id) ?? 0, rateOf(setting));
      return {
        userId: setting._id,
        name: names.get(setting._id),
        completedHours: figures.completedHours,
        hourlyRate: figures.hourlyRate,
        totalPayout: figures.totalPayout,
        ledgerId: paid?._id,
        disbursed: paid?.disbursed ?? false,
        disbursedAt: paid?.disbursedAt,
      };
    });
    people.sort((first, second) => (first.name ?? '').localeCompare(second.name ?? ''));
    return { ...month, scope, people, totalPayout: roundMoney(people.reduce((sum, person) => sum + person.totalPayout, 0)) };
  }

  /** Saves the month's figures for everyone in scope who earns, leaving paid entries alone. */
  async function generateMonth(actor: Actor, scope: Scope, month: Month) {
    const settings = await findIncentiveSettings(await peopleInScope(actor.user._id, scope), true);
    const hours = await sumLedHours(settings.map((setting) => setting._id), month);
    let generated = 0;
    for (const setting of settings) {
      const saved = await upsertUnpaidLedgerEntry(setting._id, month, figuresFor(hours.get(setting._id) ?? 0, rateOf(setting)));
      if (saved) generated += 1;
    }
    await recordAudit({ action: 'incentive.month_generated', ...actorFields(actor), targetType: 'incentive', targetName: `${month.year}-${String(month.month).padStart(2, '0')}`, module: TASKS_MODULE_KEY });
    return { ...month, generated, skippedAsPaid: settings.length - generated };
  }

  /** Pays one person's month, freezing the figures it paid. */
  async function disburse(actor: Actor, scope: Scope, userId: string, month: Month) {
    assertNotSelf(actor, userId);
    await assertReachesPerson(actor, scope, userId);
    const setting = await findIncentiveSetting(userId);
    if (!setting?.earnsMonthlyIncentive) throw new ApiError(409, 'not_an_earner', "This person doesn't earn a monthly incentive. Change their incentive setting first.");

    const hours = (await sumLedHours([userId], month)).get(userId) ?? 0;
    const paid = await markLedgerEntryPaid(userId, month, figuresFor(hours, rateOf(setting)), actor.user._id);
    if (!paid) throw new ApiError(409, 'already_paid', 'This month is already paid for this person.');
    const names = await findPeopleNames([userId]);
    await recordAudit({ action: 'incentive.disbursed', ...incentiveAuditFields(actor, userId, names.get(userId)), after: { month: month.month, year: month.year, totalPayout: paid.totalPayout } });
    return { userId, name: names.get(userId), ...toLedgerView(paid) };
  }

  /** Ledger entries within scope, newest first. */
  async function listLedger(actor: Actor, scope: Scope, filter: { userId?: string; month?: number; year?: number }) {
    if (filter.userId) await assertReachesPerson(actor, scope, filter.userId);
    const reached = await peopleInScope(actor.user._id, scope);
    const entries = await findLedgerEntries({ userIds: filter.userId ? [filter.userId] : reached, month: filter.month, year: filter.year });
    const names = await findPeopleNames(entries.map((entry) => entry.userId));
    return { entries: entries.map((entry) => ({ userId: entry.userId, name: names.get(entry.userId), ...toLedgerView(entry) })) };
  }

  const toSettingView = (setting: IncentiveSettingDoc, names: Map<string, string>) => ({
    userId: setting._id,
    name: names.get(setting._id),
    earnsMonthlyIncentive: setting.earnsMonthlyIncentive,
    hourlyRate: setting.hourlyRate,
    effectiveHourlyRate: rateOf(setting),
    eligibleForProjectIncentives: setting.eligibleForProjectIncentives,
    updatedAt: setting.updatedAt,
  });

  async function listSettings(actor: Actor, scope: Scope) {
    const settings = await findIncentiveSettings(await peopleInScope(actor.user._id, scope));
    const names = await findPeopleNames(settings.map((setting) => setting._id));
    return { defaultHourlyRate, settings: settings.map((setting) => toSettingView(setting, names)) };
  }

  async function updateSetting(actor: Actor, scope: Scope, userId: string, changes: IncentiveSettingChanges) {
    assertNotSelf(actor, userId);
    await assertPeopleExist({ userId });
    await assertReachesPerson(actor, scope, userId);
    const before = await findIncentiveSetting(userId);
    const saved = await saveIncentiveSetting(userId, changes, actor.user._id);
    if (!saved) throw new Error('Saving the incentive setting returned nothing.');
    const names = await findPeopleNames([userId]);
    await recordAudit({
      action: 'incentive.setting_changed',
      ...incentiveAuditFields(actor, userId, names.get(userId)),
      before: before ? { earnsMonthlyIncentive: before.earnsMonthlyIncentive, hourlyRate: before.hourlyRate ?? null, eligibleForProjectIncentives: before.eligibleForProjectIncentives } : null,
      after: changes,
    });
    return toSettingView(saved, names);
  }

  /**
   * A project's members within the caller's scope, whether each may get a project incentive, and what they've been
   * given. Reaching the project isn't enough to see everyone's money on it: an own scope sees only its own grant.
   */
  async function listProjectIncentives(actor: Actor, scope: Scope, projectId: string) {
    const project = await requireProject(projectId);
    await assertCanReachProject(actor, scope, project, 'read');
    const reached = await peopleInScope(actor.user._id, scope);
    const people = projectPeople(project).filter((userId) => !reached || reached.includes(userId));
    const [settings, grants] = await Promise.all([findIncentiveSettings(people), findProjectIncentives(projectId)]);
    const names = await findPeopleNames([...people, ...grants.map((grant) => grant.grantedBy)]);
    const eligible = new Set(settings.filter((setting) => setting.eligibleForProjectIncentives).map((setting) => setting._id));
    const grantByUser = new Map(grants.map((grant) => [grant.userId, grant]));
    return {
      members: people.map((userId) => {
        const grant = grantByUser.get(userId);
        return {
          userId,
          name: names.get(userId),
          eligible: eligible.has(userId),
          grant: grant && { enabled: grant.enabled, amount: grant.amount, notes: grant.notes, grantedBy: grant.grantedBy, grantedByName: names.get(grant.grantedBy), updatedAt: grant.updatedAt },
        };
      }),
    };
  }

  async function setProjectIncentive(actor: Actor, scope: Scope, projectId: string, userId: string, grant: { enabled: boolean; amount: number | null; notes: string | null }) {
    assertNotSelf(actor, userId);
    const project = await requireProject(projectId);
    await assertCanReachProject(actor, scope, project, 'edit');
    if (!projectPeople(project).includes(userId)) {
      throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', [{ path: 'userId', message: 'is not on this project' }]);
    }
    // Reaching the project through one member doesn't reach everyone on it, such as the caller's own manager.
    await assertReachesPerson(actor, scope, userId);
    const setting = await findIncentiveSetting(userId);
    if (!setting?.eligibleForProjectIncentives) {
      throw new ApiError(409, 'not_eligible', "This person isn't eligible for project incentives yet. Change their incentive setting first.");
    }
    const saved = await saveProjectIncentive(projectId, userId, grant, actor.user._id);
    if (!saved) throw new Error('Saving the project incentive returned nothing.');
    const names = await findPeopleNames([userId]);
    await recordAudit({ action: 'incentive.project_incentive_set', ...incentiveAuditFields(actor, userId, names.get(userId)), after: { projectId, ...grant } });
    return { userId, name: names.get(userId), enabled: saved.enabled, amount: saved.amount, notes: saved.notes, updatedAt: saved.updatedAt };
  }

  return { listMonth, generateMonth, disburse, listLedger, listSettings, updateSetting, listProjectIncentives, setProjectIncentive };
}

