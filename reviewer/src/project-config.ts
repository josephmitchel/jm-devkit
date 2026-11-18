import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestCommand } from './db/schema.js';
import type { RepoRow } from './stages/context.js';

/**
 * How to set up and test a project, as one run of the code reviewer sees it. Read from the
 * project's `devkit.json` when its checkout has one, and from the project's database row when it
 * does not, so a project that has not been given a `devkit.json` yet runs exactly as before.
 */
export interface ProjectSetup {
  source: 'devkit.json' | 'database';
  setupCommand: string | null;
  testCommands: TestCommand[];
  /** Auditors per quality characteristic in a full round. */
  redundancy: number;
  /** The notes themselves, not a path: what the testing auditor is shown. */
  harnessNotes: string | null;
  extraContext: string | null;
  /**
   * Environment for the project's setup and test commands. Empty from the database row, whose
   * project gets its environment from the action's `repo-env` input alone.
   */
  env: Record<string, string>;
}

/** The part of a project's database row that `devkit.json` replaces. */
export type ProjectRow = Pick<RepoRow, 'setupCommand' | 'testCommands' | 'redundancy' | 'harnessNotes' | 'extraContext'>;

export const CONFIG_FILE = 'devkit.json';

/** A `devkit.json` the code reviewer cannot use. The message names the field at fault. */
export class DevkitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevkitConfigError';
  }
}

/**
 * The one place a run learns how to set up and test the project in `checkoutDir`.
 *
 * With a `devkit.json` at the root, its `reviewer` section is the whole answer: the row is not
 * consulted, so a field the file leaves out means none (or, for redundancy, 1), never the row's
 * value. A file the schema rejects, or harness notes it points at that are not there, throws a
 * {@link DevkitConfigError}, which fails the run, rather than falling back to the row: a project
 * that wrote the file meant it.
 */
export function readProjectSetup(checkoutDir: string, row: ProjectRow): ProjectSetup {
  const file = path.join(checkoutDir, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return {
      source: 'database',
      setupCommand: row.setupCommand,
      testCommands: row.testCommands,
      redundancy: row.redundancy,
      harnessNotes: row.harnessNotes,
      extraContext: row.extraContext,
      env: {},
    };
  }

  const config = parseDevkitConfig(fs.readFileSync(file, 'utf8'));
  const reviewer = config.reviewer;
  return {
    source: 'devkit.json',
    setupCommand: reviewer.setup ?? null,
    testCommands: reviewer.tests.map(({ name, command }) => ({ name, command })),
    redundancy: reviewer.redundancy ?? 1,
    harnessNotes: reviewer.harnessNotes === undefined ? null : readHarnessNotes(checkoutDir, reviewer.harnessNotes),
    extraContext: reviewer.extraContext ?? null,
    env: { ...reviewer.env },
  };
}

/** The process-module part of `devkit.json`, as `plugin/devkit.schema.json` defines it. */
export interface DevkitConfig {
  $schema?: string;
  modules: Array<'process' | 'web' | 'canvas'>;
  kit?: string;
  sweep: { hour: number };
  reviewer: {
    setup?: string;
    tests: TestCommand[];
    env?: Record<string, string>;
    /** For the generator; the code reviewer ignores it. */
    services?: Record<string, unknown>;
    harnessNotes?: string;
    redundancy?: number;
    extraContext?: string;
  };
}

/** Parse and validate a `devkit.json`'s text against the kit's schema. */
export function parseDevkitConfig(text: string): DevkitConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new DevkitConfigError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const errors = validate(devkitSchema(), value, '');
  if (errors.length > 0) {
    throw new DevkitConfigError(`${CONFIG_FILE} is malformed: ${errors.join('; ')}`);
  }
  return value as DevkitConfig;
}

function readHarnessNotes(checkoutDir: string, relative: string): string {
  const field = 'reviewer.harnessNotes';
  const root = fs.realpathSync(checkoutDir);
  const target = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !isInside(root, target)) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} must be a path inside the project, not ${relative}`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} points at ${relative}, which is not a file in the project`);
  }
  // Checked again once resolved: a symlink in the checkout must not lead the notes, and so the
  // auditors' prompts, to a file on the runner outside it.
  if (!isInside(root, fs.realpathSync(target))) {
    throw new DevkitConfigError(`${CONFIG_FILE}: ${field} must be a path inside the project, not ${relative}`);
  }
  return fs.readFileSync(target, 'utf8');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The kit's schema, read from the kit checkout this code runs from. A project that uses the
 * action has the whole kit checked out, so the plugin's copy is always beside the reviewer's.
 */
export const SCHEMA_PATH = fileURLToPath(new URL('../../plugin/devkit.schema.json', import.meta.url));

let cachedSchema: JsonSchema | null = null;

function devkitSchema(): JsonSchema {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchema;
  return cachedSchema;
}

/**
 * A JSON Schema, of the keywords `plugin/devkit.schema.json` uses. The validator below is a small
 * interpreter for those rather than a dependency: the schema is the one definition of the format,
 * and its messages can name the field in the terms a project's owner wrote it in.
 */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  uniqueItems?: boolean;
  contains?: JsonSchema;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  [annotation: string]: unknown;
}

type JsonType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default']);
const ASSERTIONS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minItems',
  'uniqueItems',
  'contains',
  'const',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'pattern',
]);

/**
 * Every way `value` breaks `schema`, each naming the field at `at` (`reviewer.tests[0].command`).
 * A keyword this does not know throws instead of passing silently, so the schema cannot grow a
 * rule the code reviewer would not enforce.
 */
export function validate(schema: JsonSchema, value: unknown, at: string): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.has(keyword) && !ASSERTIONS.has(keyword)) {
      throw new Error(`devkit.schema.json uses "${keyword}", which the code reviewer's validator does not understand`);
    }
  }
  const field = at === '' ? CONFIG_FILE : at;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(value, t))) return [`${field} must be ${types.map(article).join(' or ')}`];
  }
  if ('const' in schema && !sameJson(value, schema.const)) {
    return [`${field} must be ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum && !schema.enum.some((option) => sameJson(value, option))) {
    return [`${field} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`];
  }

  const errors: string[] = [];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(schema.minLength === 1 ? `${field} must not be empty` : `${field} must be at least ${schema.minLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${field} must match ${schema.pattern}, not ${JSON.stringify(value)}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${field} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${field} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${field} must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push(`${field} lists ${key} more than once`);
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${field}[${i}]`)));
    if (schema.contains && !value.some((item) => validate(schema.contains!, item, '').length === 0)) {
      const wanted = 'const' in schema.contains ? JSON.stringify(schema.contains.const) : 'an item it accepts';
      errors.push(`${field} must include ${wanted}`);
    }
  }
  if (isObject(value)) {
    const child = (key: string) => (at === '' ? key : `${at}.${key}`);
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${child(key)} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) {
        const bad = validate(schema.propertyNames, key, '');
        if (bad.length > 0) errors.push(`${field} has a key ${JSON.stringify(key)} that is not allowed there`);
      }
      const declared = schema.properties?.[key];
      if (declared) {
        errors.push(...validate(declared, item, child(key)));
      } else if (schema.additionalProperties === false) {
        errors.push(`${child(key)} is not a known field`);
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, item, child(key)));
      }
    }
  }
  return errors;
}

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return typeof value === type;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function article(type: JsonType): string {
  return type === 'object' || type === 'array' || type === 'integer' ? `an ${type}` : `a ${type}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
