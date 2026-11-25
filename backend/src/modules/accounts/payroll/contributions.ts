/** Provident fund and gratuity rates, in basis points of gross pay (1000 is 10%). 0 means none. */
export interface ContributionRates {
  providentFundBasisPoints: number;
  gratuityBasisPoints: number;
}

const BASIS_POINTS_PER_WHOLE = 10_000;

/** A share of gross pay in basis points, rounded once to the paisa: 10% of Tk 1,000.05 is Tk 100.01. */
export const shareOfGross = (gross: number, basisPoints: number) => Math.round((gross * basisPoints) / BASIS_POINTS_PER_WHOLE);
