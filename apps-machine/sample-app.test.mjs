// The sample app is outside this home, in `sample-app/`: it is an app, not one of root's commands.
// Its tests are here because it exists to rehearse a deploy, and the kit's own project config is
// what deploys it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { parseDeployConfig } from '../plugin/devkit-config.mjs';
import { exitOnSigterm, listen } from '../sample-app/app.mjs';
import { migrate } from '../sample-app/migrate.mjs';

const KIT = path.resolve(import.meta.dirname, '..');
const deploy = parseDeployConfig(fs.readFileSync(path.join(KIT, 'devkit.json'), 'utf8'));

/** A stand-in for the app's database: a visits table, or none before the migration has run. */
function database({ migrated = true } = {}) {
  const db = { visits: migrated ? 0 : null, asked: [] };
  db.query = async (sql) => {
    db.asked.push(sql);
    if (db.visits === null) throw new Error('relation "visits" does not exist');
    if (/^INSERT INTO visits/.test(sql)) db.visits += 1;
    return String(db.visits);
  };
  return db;
}

/** The app, listening on a port of the system's choosing, and `get(path)` asked of it. */
async function app(t, { db = database(), env = {}, commit = 'a'.repeat(40) } = {}) {
  const server = await listen({ query: db.query, env, commit, port: 0 });
  t.after(() => server.close());
  const { address, port } = server.address();
  const get = async (url) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { redirect: 'manual' });
    return { status: response.status, text: await response.text() };
  };
  return { address, get, db, server };
}

/** A stand-in for the app's own process: it can be sent a signal, and `exited` resolves with the status it exits with. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.exited = new Promise((resolve) => {
    proc.exit = (status) => {
      proc.status = status;
      resolve(status);
    };
  });
  return proc;
}

test('the kit\'s project config deploys the sample app: every command runs a file the app has', () => {
  assert.ok(deploy, 'devkit.json has no deploy section');
  for (const step of ['setup', 'build', 'migrate', 'start']) {
    const [, file] = /^(?:exec )?node (sample-app\/[\w.-]+\.mjs)$/.exec(deploy[step]) ?? [];
    assert.ok(file && fs.existsSync(path.join(KIT, file)), `${step} is ${deploy[step]}`);
  }
});

test('its start command puts the app in the shell\'s place, so the status the app exits with is the one its service ends with', () => {
  assert.match(deploy.start, /^exec /);
});

test('the sample app listens on loopback alone', async (t) => {
  const { address } = await app(t);
  assert.equal(address, '127.0.0.1');
});

test('its health path answers with success once its table is there', async (t) => {
  const { get } = await app(t);
  assert.deepEqual(await get(deploy.healthPath), { status: 200, text: 'ok\n' });
});

test('its health path fails before its migration has run', async (t) => {
  const { get } = await app(t, { db: database({ migrated: false }) });
  assert.equal((await get(deploy.healthPath)).status, 503);
});

test('with SAMPLE_HEALTH=fail in its settings, its health path fails on purpose and the app still answers', async (t) => {
  const { get } = await app(t, { env: { SAMPLE_HEALTH: 'fail' }, commit: 'b'.repeat(40) });
  assert.deepEqual(await get(deploy.healthPath), { status: 503, text: 'failing on purpose: SAMPLE_HEALTH=fail is in the settings\n' });
  assert.deepEqual(await get('/'), { status: 200, text: `The sample app at commit ${'b'.repeat(40)}. Visits: 1.\n` });
});

test('every visit to the app is counted in its database, and the answer names the commit that is running', async (t) => {
  const { get, db } = await app(t);
  await get('/');
  assert.deepEqual(await get('/'), { status: 200, text: `The sample app at commit ${'a'.repeat(40)}. Visits: 2.\n` });
  assert.equal(db.visits, 2);
  assert.equal((await get('/anything-else')).status, 404);
});

test('on SIGTERM the sample app answers what it was already asked, takes nothing new and exits 143', async (t) => {
  const db = database();
  let reached;
  let answer;
  const asked = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (answer = resolve));
  const query = async (sql) => {
    reached();
    await held;
    return db.query(sql);
  };
  const { get, server } = await app(t, { db: { query } });
  const proc = fakeProcess();
  exitOnSigterm(server, proc);
  const visit = get('/');
  await asked;
  proc.emit('SIGTERM');
  await assert.rejects(get('/'));
  assert.equal(proc.status, undefined);
  answer();
  assert.deepEqual(await visit, { status: 200, text: `The sample app at commit ${'a'.repeat(40)}. Visits: 1.\n` });
  assert.equal(await proc.exited, 143);
});

test('migrating applies each migration the database has not had, once, in order', async () => {
  const applied = [];
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    const insert = /INSERT INTO migrations \(name\) VALUES \('([^']+)'\)/.exec(sql);
    if (insert) applied.push(insert[1]);
    return /^SELECT name FROM migrations/.test(sql) ? applied.join('\n') : '';
  };
  const all = fs.readdirSync(path.join(KIT, 'sample-app/migrations')).sort();
  assert.ok(all.length > 0);
  assert.deepEqual(await migrate(query), all);
  assert.deepEqual(applied, all);
  assert.match(statements.join('\n'), /CREATE TABLE visits/);
  assert.deepEqual(await migrate(query), []);
  assert.deepEqual(applied, all);
});
