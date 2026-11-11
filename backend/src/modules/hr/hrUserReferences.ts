import { WITH_DELETED } from '../../lib/records/recordFields.js';
import type { UserReferenceCheck } from '../../lib/userReferences.js';
import { Salary } from './models/salary.js';

/** HR records that keep a person from being deleted. Records in the recycle bin count, because they can be restored. */
export const hrUserReferenceChecks: UserReferenceCheck[] = [
  {
    description: 'salary records',
    isReferenced: async (userId) => Boolean(await Salary.exists({ employeeId: userId }).setOptions(WITH_DELETED)),
  },
];
