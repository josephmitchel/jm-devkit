import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appsMachine, fakeRun, machine, registered } from '../test-helpers.mjs';

const journal = (unit, since) => ({ program: 'journalctl', args: ['--quiet', '--no-pager', `--unit=${unit}`, `--since=${since}`], live: true });

test('logs sends the last day of the app\'s service\'s journal straight to standard output, and writes nothing of its own', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  const { run, calls } = fakeRun();
  assert.deepEqual(await appsMachine(['logs', 'sample'], { paths, run }), { code: 0, out: '', err: '' });
  assert.deepEqual(calls, [journal('app-sample.service', '-1d')]);
});

test('a period given after the name is read in place of the last day', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const period of ['30min', '6h', '3d', '2w']) {
    const { run, calls } = fakeRun();
    assert.deepEqual(await appsMachine(['logs', 'sample', period], { paths, run }), { code: 0, out: '', err: '' });
    assert.deepEqual(calls, [journal('app-sample.service', `-${period}`)]);
  }
});

test('a period that is not a whole number and a unit is refused, and the journal is not read', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const period of ['yesterday', '-r', '--reverse', '1d --reverse', '1d\n--reverse', '-1d', '0h', '2x', '1.5h', '']) {
    const { run, calls } = fakeRun();
    assert.deepEqual(await appsMachine(['logs', 'sample', period], { paths, run }), {
      code: 2,
      out: '',
      err: 'error: a period is a whole number and min, h, d or w, as in 30min, 6h, 3d or 2w\nusage: apps-machine logs <name> [<period>]\n',
    }, JSON.stringify(period));
    assert.deepEqual(calls, []);
  }
});

test('an app that is not registered is refused on standard error, and no journal is read', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const name of ['example_app', 'sample.service', '*', '--system', '']) {
    const { run, calls } = fakeRun();
    assert.deepEqual(await appsMachine(['logs', name], { paths, run }), {
      code: 1,
      out: '',
      err: `error: no app named ${name} is registered on this machine\n`,
    });
    assert.deepEqual(calls, []);
  }
});

test('with several apps registered, only the named app\'s service is read', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  registered(paths, { name: 'example_app' });
  const { run, calls } = fakeRun();
  await appsMachine(['logs', 'example_app', '2w'], { paths, run });
  assert.deepEqual(calls, [journal('app-example_app.service', '-2w')]);
});

test('when the journal cannot be read, logs fails and says so on standard error', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  const { run } = fakeRun(() => ({ code: 1 }));
  assert.deepEqual(await appsMachine(['logs', 'sample'], { paths, run }), {
    code: 1,
    out: '',
    err: 'error: journalctl could not read the journal of app-sample.service\n',
  });
});

test('logs takes a name and at most a period', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const args of [[], ['sample', '1d', '--reverse']]) {
    const { run, calls } = fakeRun();
    assert.deepEqual(await appsMachine(['logs', ...args], { paths, run }), { code: 2, out: '', err: 'usage: apps-machine logs <name> [<period>]\n' });
    assert.deepEqual(calls, []);
  }
});
