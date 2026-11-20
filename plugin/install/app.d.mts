// Types for what the code reviewer imports from app.mjs.

/** GitHub answered a request with something other than success. */
export declare class GitHubError extends Error {
  constructor(message: string, status: number);
  readonly status: number;
}

/** Every repository the App is installed on, as owner/name, with a token that can read it. */
export declare function installedRepos(options: {
  fetch: typeof fetch;
  credentials: { clientId: string; privateKey: string };
  now?: number;
}): Promise<Array<{ slug: string; token: string }>>;

/** The text of the file at `path` on `slug`'s default branch, or null when it has none. */
export declare function defaultBranchFile(options: {
  fetch: typeof fetch;
  slug: string;
  token: string;
  path: string;
}): Promise<string | null>;
