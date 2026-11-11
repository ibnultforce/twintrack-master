import type { PageRequest } from '../../../lib/query.js';
import type { UserDoc } from '../models/user.js';
import { findOnlineStatus, type Viewer } from './presence.service.js';
import { findDirectoryPage } from './users.repository.js';

/** What anyone signed in may see about a colleague. Access details stay with admins. */
export interface DirectoryEntry {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  team?: string;
  employeeNumber?: number;
  photoUpdatedAt?: Date;
  /** Left out when the viewer may not see this person's online status. */
  online?: boolean;
}

const toDirectoryEntry = (person: UserDoc, online: boolean | undefined): DirectoryEntry => ({
  id: person._id,
  name: person.name,
  email: person.email,
  title: person.title,
  department: person.department,
  team: person.team,
  employeeNumber: person.employeeNumber,
  photoUpdatedAt: person.photoUpdatedAt,
  ...(online !== undefined && { online }),
});

export async function listDirectory(viewer: Viewer, query: PageRequest & { search?: string }) {
  const { users, total } = await findDirectoryPage(query);
  const online = await findOnlineStatus(viewer, users);
  return { people: users.map((person) => toDirectoryEntry(person, online.get(person._id))), total };
}
