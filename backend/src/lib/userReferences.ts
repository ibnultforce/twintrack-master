/**
 * Asks one module whether any of its records still point at a person, so Master never deletes someone another module
 * depends on. Each module lists its own checks, and the app hands them all to Master, which knows no module's data.
 */
export interface UserReferenceCheck {
  /** What still points at the person, as shown to the admin, such as "salary records". */
  description: string;
  isReferenced(userId: string): Promise<boolean>;
}

/** The descriptions of everything that still points at the person. */
export async function findUserReferences(checks: UserReferenceCheck[], userId: string): Promise<string[]> {
  const results = await Promise.all(checks.map(async (check) => ((await check.isReferenced(userId)) ? check.description : null)));
  return results.filter((description): description is string => description !== null);
}
