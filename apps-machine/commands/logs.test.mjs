import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { run as realRun } from '../run.mjs';
import { appsMachine, fakeRun, machine, registered, tempDir } from '../test-helpers.mjs';

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

/** The sudo rule as the setup script writes it for `account`: the script's own `COMMAND` and `logs_rule`, run by bash. */
function sudoRuleFor(account) {
  const setup = fs.readFileSync(path.join(import.meta.dirname, '../../vm/apps-machine-setup.sh'), 'utf8');
  const lines = [/^COMMAND=\S+$/m, /^logs_rule\(\) \{ .* \}$/m].map((line) => line.exec(setup)?.[0]);
  assert.ok(lines.every(Boolean), 'the setup script has no COMMAND or no logs_rule');
  return realRun('bash', ['-c', `${lines.join('\n')}\nlogs_rule "$1"`, 'bash', account]).stdout;
}

test('the setup script\'s sudo rule lets one account run the logs command as root without a password, and names nothing else', () => {
  assert.equal(sudoRuleFor('owner'), 'owner ALL=(root) NOPASSWD: /usr/local/sbin/apps-machine logs *\n');
});

test('the setup script writes the rule only for a name sudo reads as one account, and never for root', () => {
  const setup = fs.readFileSync(path.join(import.meta.dirname, '../../vm/apps-machine-setup.sh'), 'utf8');
  const [, isAnAccount] = /^if (\[\[ "\$LOGS_ACCOUNT" =~ \S+ \]\] && \[ "\$LOGS_ACCOUNT" != root \]); then$/m.exec(setup);
  const getsTheRule = { owner: true, second_admin: true, 'admin-2': true, _admin: true, '': false, root: false, ALL: false, Owner: false, '%sudo': false, '#0': false, '+admins': false, '!owner': false, 'owner,ALL': false, 'owner ALL': false, 'owner\nALL': false };
  for (const [account, expected] of Object.entries(getsTheRule)) {
    assert.equal(realRun('bash', ['-c', `LOGS_ACCOUNT=$1; ${isAnAccount}`, 'bash', account]).code === 0, expected, JSON.stringify(account));
  }
});

test('visudo accepts the rule as the setup script writes it', (t) => {
  const visudo = ['/usr/sbin/visudo', '/usr/bin/visudo'].find((program) => fs.existsSync(program));
  if (!visudo) return t.skip('this machine has no visudo');
  const file = path.join(tempDir(), 'apps-machine-logs');
  fs.writeFileSync(file, sudoRuleFor('owner'));
  assert.equal(realRun(visudo, ['-cf', file]).code, 0);
  fs.writeFileSync(file, sudoRuleFor('owner').replace(')', ''));
  assert.notEqual(realRun(visudo, ['-cf', file]).code, 0);
});

test('the sudo rule reaches no other command: sudo lets through only arguments that begin with logs, and a command is run by its exact name', async () => {
  const paths = machine();
  registered(paths, { name: 'sample' });
  for (const argv of [['logs deploy', 'sample'], ['logs ', 'deploy', 'sample'], ['logs\tdeploy', 'sample'], ['logs sample'], ['logs *']]) {
    const { run, calls } = fakeRun();
    const result = await appsMachine(argv, { paths, run });
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.match(result.err, /^usage: apps-machine <command>\n/);
    assert.deepEqual(calls, []);
  }
});
