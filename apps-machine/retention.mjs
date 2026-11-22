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

export const DAYS_KEPT_ON_STORAGE = 30;
export const MONTHS_KEPT_ON_STORAGE = 12;

const monthOf = (day) => day.slice(0, 7);

const monthsBefore = (day, months) => {
  const [year, month] = day.split('-').map(Number);
  return monthOf(new Date(Date.UTC(year, month - 1 - months, 1)).toISOString());
};

/**
 * The bundles the storage gives up, for bundles that also have an `app`: those dated before the
 * thirty days that end with `today`, but for each app's first bundle of each of the twelve months
 * that end with this one. A month's first bundle is the earliest it has, whatever its day.
 */
export function expiredOnStorage(bundles, today) {
  const oldestNightly = daysBefore(today, DAYS_KEPT_ON_STORAGE - 1);
  const oldestMonth = monthsBefore(today, MONTHS_KEPT_ON_STORAGE - 1);
  const firstOfMonth = new Map();
  const monthOfApp = ({ app, date }) => `${app} ${monthOf(date)}`;
  for (const bundle of bundles) {
    const first = firstOfMonth.get(monthOfApp(bundle));
    if (first === undefined || bundle.date < first) firstOfMonth.set(monthOfApp(bundle), bundle.date);
  }
  const isMonthly = (bundle) => monthOf(bundle.date) >= oldestMonth && firstOfMonth.get(monthOfApp(bundle)) === bundle.date;
  return bundles.filter((bundle) => bundle.date < oldestNightly && !isMonthly(bundle));
}
