export declare const CONFIG_FILE: 'devkit.json';
export declare const SCHEMA_PATH: string;

export declare class DevkitConfigError extends Error {
  constructor(message: string, errors?: string[]);
  /** Each field at fault, when the file parsed but broke the schema. */
  readonly errors: string[];
}

/** The process-module part of devkit.json, as devkit.schema.json defines it. */
export interface DevkitConfig {
  $schema?: string;
  modules: Array<'process' | 'web' | 'canvas'>;
  kit?: string;
  /** Retired: accepted and ignored. */
  sweep?: { hour: number };
  reviewer: {
    setup?: string;
    tests: Array<{ name: string; command: string }>;
    env?: Record<string, string>;
    /** The environment variables that each get an empty database for the run. */
    databases?: string[];
    /** Retired: accepted, and read by nothing but the sweep workflow's last form. */
    services?: Record<string, DevkitService>;
    harnessNotes?: string;
    redundancy?: number;
    extraContext?: string;
  };
  nightly?: {
    /** Commands run once a night after the project's sweep, in the order written. */
    checks?: Array<{ name: string; command: string }>;
  };
  /** How the apps machine deploys the project. A project that is not deployed has none. */
  deploy?: DeployConfig;
}

/** The `deploy` section: commands run with `sh -c` from the root of the commit being deployed. */
export interface DeployConfig {
  setup: string;
  build: string;
  /** Left out by a project that migrates as it starts. */
  migrate?: string;
  start: string;
  /** The local port the app listens on. */
  port: number;
  /** The path on `port` that answers once the app is healthy. */
  healthPath: string;
}

/** One entry of `reviewer.services`: a GitHub Actions job service. */
export interface DevkitService {
  image: string;
  env?: Record<string, string>;
  ports?: Array<string | number>;
  volumes?: string[];
  options?: string;
  credentials?: { username: string; password: string };
}

/** A JSON Schema, of the keywords devkit.schema.json uses. */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  uniqueItems?: boolean;
  /** The kit's own keyword: properties whose value no two items of the array may share. */
  uniqueItemProperties?: string[];
  contains?: JsonSchema;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  [annotation: string]: unknown;
}

export type JsonType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

export declare function devkitSchema(): JsonSchema;
export declare function parseDevkitConfig(text: string): DevkitConfig;
/** The checked `deploy` section of a devkit.json's text, or null when the project has none. */
export declare function parseDeployConfig(text: string): DeployConfig | null;
export declare function checkDevkitConfig(value: unknown): DevkitConfig;
export declare function validate(schema: JsonSchema, value: unknown, at: string): string[];
