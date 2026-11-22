import { readRegistry } from '../registry.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine list';
export const summary = 'the apps registered on this machine';

export function command(args, { paths, out }) {
  if (args.length > 0) throw new UsageError();
  const apps = readRegistry(paths);
  if (apps.length === 0) out.write('No app is registered.\n');
  for (const app of apps) out.write(`${app.name}\n`);
}
