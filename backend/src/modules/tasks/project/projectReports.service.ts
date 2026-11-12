import { currentMonth, monthBounds } from '../../../lib/period.js';
import type { Actor } from '../../master/access/caller.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { findIncentiveSettings } from '../incentive/incentive.repository.js';
import { CLOSED_TASK_STATUSES } from '../models/task.js';
import { sumPointsOf } from '../points/points.repository.js';
import { findRosterTasks, sumDoneHoursByLead, sumHoursByProject } from '../task/task.repository.js';
import { findPeopleNames } from '../tasksModule.js';
import { projectsInReach } from './project.service.js';

const HOUR_DECIMALS = 100;
const roundHours = (hours: number) => Math.round(hours * HOUR_DECIMALS) / HOUR_DECIMALS;

/**
 * How each project in reach is doing: hours used against hours allocated, open tasks, who led this month's finished
 * work, and what that costs in monthly incentives for leads who earn them. defaultHourlyRate applies to leads whose
 * setting names no rate.
 */
export async function getProjectsHealth(actor: Actor, scope: Scope, defaultHourlyRate: number, leadId?: string) {
  const projects = await projectsInReach(actor, scope, leadId);
  const projectIds = projects.map((project) => project._id);
  const { from, before } = monthBounds(currentMonth());
  const [hours, leadHours] = await Promise.all([sumHoursByProject(projectIds), sumDoneHoursByLead(projectIds, from, before)]);
  const leadIds = [...new Set(leadHours.map((entry) => entry.tlId))];
  const [names, earners] = await Promise.all([
    findPeopleNames([...projects.map((project) => project.leadId), ...leadIds]),
    findIncentiveSettings(leadIds, true),
  ]);
  const rateByLead = new Map(earners.map((setting) => [setting._id, setting.hourlyRate ?? defaultHourlyRate]));
  const hoursByProject = new Map(hours.map((entry) => [entry.projectId, entry]));

  return {
    projects: projects.map((project) => {
      const projectHours = hoursByProject.get(project._id);
      const completedHours = roundHours(projectHours?.completedHours ?? 0);
      const monthLeads = leadHours.filter((entry) => entry.projectId === project._id);
      return {
        id: project._id,
        name: project.name,
        status: project.status,
        leadId: project.leadId,
        leadName: names.get(project.leadId),
        totalAllocatedHours: project.totalAllocatedHours,
        completedHours,
        // Missing when no hours were allocated, because a share of nothing means nothing.
        usedShare: project.totalAllocatedHours ? roundHours(completedHours / project.totalAllocatedHours) : undefined,
        openTaskCount: projectHours?.openTaskCount ?? 0,
        thisMonth: monthLeads.map((entry) => ({ tlId: entry.tlId, tlName: names.get(entry.tlId), hours: roundHours(entry.hours) })),
        // Each lead's hours at their own rate. Leads who don't earn the monthly incentive add nothing.
        thisMonthIncentive: roundHours(monthLeads.reduce((sum, entry) => sum + entry.hours * (rateByLead.get(entry.tlId) ?? 0), 0)),
      };
    }),
  };
}

interface LeadStats {
  projectIds: Set<string>;
  completedThisMonth: number;
  varianceSum: number;
  varianceCount: number;
}

/**
 * Who works on the projects in reach: each task lead with how their tasks went, and each assignee with their open
 * work and career points.
 */
export async function getRoster(actor: Actor, scope: Scope, leadId?: string) {
  const projects = await projectsInReach(actor, scope, leadId);
  const tasks = await findRosterTasks(projects.map((project) => project._id));
  const { from, before } = monthBounds(currentMonth());

  const leads = new Map<string, LeadStats>();
  const developers = new Map<string, { openTasks: number; completedTasks: number }>();
  for (const task of tasks) {
    const lead = leads.get(task.tlId) ?? { projectIds: new Set(), completedThisMonth: 0, varianceSum: 0, varianceCount: 0 };
    lead.projectIds.add(task.projectId);
    if (task.status === 'done') {
      if (task.completedAt && task.completedAt >= from && task.completedAt < before) lead.completedThisMonth += 1;
      if (task.actualHours !== undefined) {
        lead.varianceSum += task.actualHours - task.estimatedHours;
        lead.varianceCount += 1;
      }
    }
    leads.set(task.tlId, lead);

    const developer = developers.get(task.assignedDevId) ?? { openTasks: 0, completedTasks: 0 };
    if (task.status === 'done') developer.completedTasks += 1;
    else if (!CLOSED_TASK_STATUSES.includes(task.status)) developer.openTasks += 1;
    developers.set(task.assignedDevId, developer);
  }

  const [names, points] = await Promise.all([findPeopleNames([...leads.keys(), ...developers.keys()]), sumPointsOf([...developers.keys()])]);
  const byName = <Row extends { name?: string }>(first: Row, second: Row) => (first.name ?? '').localeCompare(second.name ?? '');
  return {
    teamLeads: [...leads].map(([id, stats]) => ({
      id,
      name: names.get(id),
      projectCount: stats.projectIds.size,
      tasksCompletedThisMonth: stats.completedThisMonth,
      // Average hours over or under the estimate on finished tasks. Missing until one finishes.
      averageVarianceHours: stats.varianceCount > 0 ? roundHours(stats.varianceSum / stats.varianceCount) : undefined,
    })).sort(byName),
    developers: [...developers].map(([id, stats]) => ({ id, name: names.get(id), ...stats, totalPoints: points.get(id) ?? 0 })).sort(byName),
  };
}
