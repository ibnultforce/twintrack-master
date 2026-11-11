import { isDuplicateKeyError } from '../../../db.js';
import { Counter } from '../models/counter.js';
import { User } from '../models/user.js';

const EMPLOYEE_NUMBER_SERIES = 'employeeNumber';

async function findHighestEmployeeNumber(): Promise<number> {
  const highest = await User.findOne({ employeeNumber: { $exists: true } }).sort({ employeeNumber: -1 }).select('employeeNumber').lean();
  return highest?.employeeNumber ?? 0;
}

/** Moves the series past numbers given by hand or by the seed, so it never hands out one already in use. */
async function catchUpWithNumbersInUse(): Promise<void> {
  const highest = await findHighestEmployeeNumber();
  try {
    await Counter.updateOne({ _id: EMPLOYEE_NUMBER_SERIES }, { $max: { lastNumber: highest } }, { upsert: true });
  } catch (error) {
    // Two first-ever numbers at once: the other request created the counter, which is all this needed.
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/**
 * Hands out the next employee number. Taken outside the person's transaction, so a number is never handed out twice,
 * though one can be skipped if adding the person then fails.
 */
export async function takeNextEmployeeNumber(): Promise<number> {
  await catchUpWithNumbersInUse();
  const counter = await Counter.findOneAndUpdate({ _id: EMPLOYEE_NUMBER_SERIES }, { $inc: { lastNumber: 1 } }, { returnDocument: 'after' }).lean();
  if (!counter) throw new Error('The employee number counter is missing.');
  return counter.lastNumber;
}

/** The number the next person added will most likely get. Another admin adding someone first takes it. */
export async function previewNextEmployeeNumber(): Promise<number> {
  const [counter, highest] = await Promise.all([Counter.findById(EMPLOYEE_NUMBER_SERIES).lean(), findHighestEmployeeNumber()]);
  return Math.max(counter?.lastNumber ?? 0, highest) + 1;
}
