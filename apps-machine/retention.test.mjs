import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expiredOnMachine, expiredOnStorage } from './retention.mjs';

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

const named = (app, ...dates) => dates.map((date) => ({ app, date }));

test('the storage keeps the bundles of the thirty days ending today, and gives up the older ones but the first of a month', () => {
  const bundles = dated('2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-11-01', '2026-11-20', '2026-11-21');
  assert.deepEqual(dates(expiredOnStorage(bundles, '2026-11-21')), ['2026-10-21', '2026-10-22']);
});

test('the first bundle of a month is the earliest the month has, whether or not it is dated the first', () => {
  const bundles = dated('2026-07-01', '2026-07-02', '2026-07-31', '2026-08-03', '2026-08-04', '2026-09-30', '2026-10-01', '2026-10-02', '2026-11-21');
  assert.deepEqual(dates(expiredOnStorage(bundles, '2026-11-21')), ['2026-07-02', '2026-07-31', '2026-08-04', '2026-10-02']);
});

test('the first bundle of a month is kept for the twelve months ending with this one', () => {
  const firsts = dated('2025-10-01', '2025-11-01', '2025-11-30', '2025-12-01', '2026-01-01', '2026-06-01', '2026-11-01');
  assert.deepEqual(dates(expiredOnStorage(firsts, '2026-11-21')), ['2025-10-01', '2025-11-01', '2025-11-30']);
  assert.deepEqual(dates(expiredOnStorage(firsts, '2026-12-01')), ['2025-10-01', '2025-11-01', '2025-11-30', '2025-12-01']);
  assert.deepEqual(dates(expiredOnStorage(dated('2025-01-31', '2025-02-01', '2025-02-02'), '2026-01-15')), ['2025-01-31', '2025-02-02']);
});

test('nights that were missed do not stretch the thirty days, and a bundle dated after today is kept', () => {
  const bundles = dated('2026-09-01', '2026-09-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-11-22', '2027-01-01', '2027-01-02');
  assert.deepEqual(dates(expiredOnStorage(bundles, '2026-11-21')), ['2026-09-20', '2026-10-22']);
});

test('each app has its own first bundle of a month, and the storage rule gives back the bundles it was given', () => {
  const bundles = [...named('sample', '2026-09-01', '2026-09-05', '2026-09-06'), ...named('example_app', '2026-09-05', '2026-09-06')];
  assert.deepEqual(expiredOnStorage(bundles, '2026-11-21'), [bundles[1], bundles[2], bundles[4]]);
  assert.deepEqual(expiredOnStorage([], '2026-11-21'), []);
});
