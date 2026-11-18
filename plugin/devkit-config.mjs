// The one validator for devkit.json, shared by the generator and the code reviewer. It interprets
// the keywords devkit.schema.json uses, read at runtime, so the schema stays the one definition.
// Types are in devkit-config.d.mts.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'devkit.json';

/** The kit's schema for devkit.json, beside this file. */
export const SCHEMA_PATH = fileURLToPath(new URL('./devkit.schema.json', import.meta.url));

/** A devkit.json the kit cannot use. `errors` lists each field at fault, when there are any. */
export class DevkitConfigError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'DevkitConfigError';
    this.errors = errors;
  }
}

let cachedSchema = null;

/** The parsed schema, read once. */
export function devkitSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

/** Parse and validate a devkit.json's text against the kit's schema. */
export function parseDevkitConfig(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new DevkitConfigError(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
  return checkDevkitConfig(value);
}

/** Validate an already-parsed devkit.json, returning it unchanged or throwing with every error. */
export function checkDevkitConfig(value) {
  const errors = validate(devkitSchema(), value, '');
  if (errors.length > 0) {
    throw new DevkitConfigError(`${CONFIG_FILE} is malformed: ${errors.join('; ')}`, errors);
  }
  return value;
}

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
 * rule the kit would not enforce.
 */
export function validate(schema, value, at) {
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.has(keyword) && !ASSERTIONS.has(keyword)) {
      throw new Error(`devkit.schema.json uses "${keyword}", which the kit's validator (plugin/devkit-config.mjs) does not understand`);
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

  const errors = [];
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
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push(`${field} lists ${key} more than once`);
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${field}[${i}]`)));
    if (schema.contains && !value.some((item) => validate(schema.contains, item, '').length === 0)) {
      const wanted = 'const' in schema.contains ? JSON.stringify(schema.contains.const) : 'an item it accepts';
      errors.push(`${field} must include ${wanted}`);
    }
  }
  if (isObject(value)) {
    const child = (key) => (at === '' ? key : `${at}.${key}`);
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

function hasType(value, type) {
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

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function article(type) {
  return type === 'object' || type === 'array' || type === 'integer' ? `an ${type}` : `a ${type}`;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
