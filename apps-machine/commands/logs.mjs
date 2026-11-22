import { serviceName } from '../paths.mjs';
import { registrationOf } from '../registry.mjs';
import { UsageError } from '../usage.mjs';

export const usage = 'apps-machine logs <name> [<period>]';
export const summary = 'print an app\'s journal, oldest first: the last day, or the period given (30min, 6h, 3d, 2w)';

const PERIOD = /^[1-9][0-9]{0,3}(min|h|d|w)$/;

export function command(args, { run, paths }) {
  if (args.length < 1 || args.length > 2) throw new UsageError();
  const [name, period = '1d'] = args;
  if (!PERIOD.test(period)) throw new UsageError('a period is a whole number and min, h, d or w, as in 30min, 6h, 3d or 2w');
  const unit = serviceName(registrationOf(paths, name).name);
  const read = run('journalctl', ['--quiet', '--no-pager', `--unit=${unit}`, `--since=-${period}`], { live: true });
  if (read.code !== 0) throw new Error(`journalctl could not read the journal of ${unit}`);
}
