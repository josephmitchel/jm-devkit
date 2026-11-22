// Which backup bundles are given up, as rules over a list of dated bundles: a bundle is anything
// with a `date` of the form YYYY-MM-DD, and each rule returns the ones to remove.

export const DAYS_KEPT_ON_MACHINE = 7;

const daysBefore = (day, days) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - days)).toISOString().slice(0, 10);
};

/** The bundles the machine removes: those dated before the seven days that end with `today`. */
export function expiredOnMachine(bundles, today) {
  const oldestKept = daysBefore(today, DAYS_KEPT_ON_MACHINE - 1);
  return bundles.filter((bundle) => bundle.date < oldestKept);
}
