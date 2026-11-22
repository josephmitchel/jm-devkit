/** Thrown by a command given arguments it cannot use: the entry point prints the command's usage and exits 2. */
export class UsageError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'UsageError';
  }
}
