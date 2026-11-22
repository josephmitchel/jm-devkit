import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expiredOnMachine } from './retention.mjs';

const dated = (...dates) => dates.map((date) => ({ app: 'sample', date }));
const dates = (bundles) => bundles.map((bundle) => bundle.date);

test('the machine keeps the bundles of the seven days ending today and gives up the older ones', () => {
  const bundles = dated('2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21');
  assert.deepEqual(dates(expiredOnMachine(bundles, '2026-11-21')), ['2026-11-12', '2026-11-13', '2026-11-14']);
});

test('the seven days run back over the end of a month and of a year', () => {
  const bundles = dated('2025-12-26', '2025-12-27', '2025-12-28', '2025-12-31', '2026-01-01', '2026-01-02');
  assert.deepEqual(dates(expiredOnMachine(bundles, '2026-01-02')), ['2025-12-26']);
  assert.deepEqual(dates(expiredOnMachine(dated('2024-02-23', '2024-02-24', '2024-02-29'), '2024-03-01')), ['2024-02-23']);
});

test('nights that were missed do not stretch the seven days', () => {
  assert.deepEqual(dates(expiredOnMachine(dated('2026-10-01', '2026-10-20', '2026-11-21'), '2026-11-21')), ['2026-10-01', '2026-10-20']);
});

test('a bundle dated after today is kept', () => {
  assert.deepEqual(expiredOnMachine(dated('2026-11-22', '2027-01-01'), '2026-11-21'), []);
});

test('the rule is the same for every app, and gives back the bundles it was given', () => {
  const bundles = [
    { app: 'sample', date: '2026-11-14', name: 'sample-2026-11-14.tar.age' },
    { app: 'example_app', date: '2026-11-14', name: 'example_app-2026-11-14.tar.age' },
    { app: 'example_app', date: '2026-11-15', name: 'example_app-2026-11-15.tar.age' },
  ];
  assert.deepEqual(expiredOnMachine(bundles, '2026-11-21'), [bundles[0], bundles[1]]);
  assert.deepEqual(expiredOnMachine([], '2026-11-21'), []);
});
