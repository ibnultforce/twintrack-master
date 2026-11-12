/** A calendar month, numbered 1 to 12, in UTC, which is how monthly figures such as incentives are counted. */
export interface Month {
  month: number;
  year: number;
}

export function currentMonth(now = new Date()): Month {
  return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
}

/** The month's first moment, and the first moment of the next month, which isn't part of it. */
export function monthBounds({ month, year }: Month): { from: Date; before: Date } {
  return { from: new Date(Date.UTC(year, month - 1, 1)), before: new Date(Date.UTC(year, month, 1)) };
}
