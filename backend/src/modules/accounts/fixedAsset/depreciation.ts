import type { FixedAssetDoc } from '../models/fixedAsset.js';

/*
 * Straight-line depreciation, month by month. An asset loses (cost − salvage value) ÷ useful life each month, in whole
 * paisa, from its purchase month. The last month takes what rounding left over, so the months always add up to
 * exactly cost − salvage value.
 */

export type DepreciableAsset = Pick<FixedAssetDoc, 'purchaseDate' | 'cost' | 'salvageValue' | 'usefulLifeMonths'>;

/** Months from the first month to the second, 0 when they are the same: "2026-11" to "2027-01" is 2. */
export function monthsBetween(fromMonth: string, toMonth: string): number {
  const [fromYear = 0, fromNumber = 0] = fromMonth.split('-').map(Number);
  const [toYear = 0, toNumber = 0] = toMonth.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toNumber - fromNumber);
}

/** The month a number of months after another, as YYYY-MM. */
export function addMonths(month: string, count: number): string {
  const [year = 0, number = 0] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The asset's depreciation in one month, in paisa: 0 before its purchase month and after its life ends. */
export function depreciationForMonth(asset: DepreciableAsset, month: string): number {
  const index = monthsBetween(asset.purchaseDate.slice(0, 7), month);
  if (index < 0 || index >= asset.usefulLifeMonths) return 0;
  const depreciable = asset.cost - asset.salvageValue;
  const monthly = Math.floor(depreciable / asset.usefulLifeMonths);
  return index === asset.usefulLifeMonths - 1 ? depreciable - monthly * (asset.usefulLifeMonths - 1) : monthly;
}

/** Every month of the asset's life with its depreciation, first month first. */
export function depreciationSchedule(asset: DepreciableAsset): { month: string; amount: number }[] {
  const firstMonth = asset.purchaseDate.slice(0, 7);
  return Array.from({ length: asset.usefulLifeMonths }, (_unused, index) => {
    const month = addMonths(firstMonth, index);
    return { month, amount: depreciationForMonth(asset, month) };
  });
}
