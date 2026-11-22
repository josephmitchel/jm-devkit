import { readRegistry } from '../registry.mjs';
import { servicePointsAt } from '../service.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine list';
export const summary = 'the apps registered on this machine: repository, Serve port, and whether each has been deployed';

export function command(args, { paths, out }) {
  if (args.length > 0) throw new UsageError();
  const apps = readRegistry(paths);
  if (apps.length === 0) {
    out.write('No app is registered.\n');
    return;
  }
  const rows = [
    ['APP', 'REPOSITORY', 'SERVE PORT', 'DEPLOYED'],
    ...apps.map((app) => [app.name, app.repository, String(app.servePort), servicePointsAt(paths, app.name) ? 'yes' : 'no']),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) out.write(`${row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()}\n`);
}
