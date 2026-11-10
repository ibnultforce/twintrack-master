import { ApiError } from '../../lib/errors.js';
import { User } from '../master/models/user.js';

export const TASKS_MODULE_KEY = 'tasks';

/** Refuses ids that name nobody, reporting each one against the request field it came from. */
export async function assertPeopleExist(peopleByField: Record<string, string | undefined>): Promise<void> {
  const ids = [...new Set(Object.values(peopleByField).filter((id): id is string => Boolean(id)))];
  const found = new Set<string>(await User.find({ _id: { $in: ids } }).distinct('_id'));
  const fields = Object.entries(peopleByField)
    .filter(([, id]) => id && !found.has(id))
    .map(([path]) => ({ path, message: 'no such person' }));
  if (fields.length > 0) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', fields);
}

export async function findPeopleNames(peopleIds: string[]): Promise<Map<string, string>> {
  const people = await User.find({ _id: { $in: [...new Set(peopleIds)] } }).select('name').lean();
  return new Map(people.map((person) => [person._id, person.name]));
}
