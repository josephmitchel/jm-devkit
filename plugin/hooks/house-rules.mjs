import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rulesPath = fileURLToPath(new URL('../house-rules.md', import.meta.url));

export const NUDGE = 'This project is behind the kit: run /devkit:sync to bring its kit-owned files level.';

// The house rules for every event. At session start, a project that is behind the kit also gets
// the nudge: shown to the user through systemMessage, and added to Claude's context after the rules.
export async function houseRulesOutput(event) {
  const rules = readFileSync(rulesPath, 'utf8');
  const nudge = event.hook_event_name === 'SessionStart' ? await nudgeFor(event.cwd ?? process.cwd()) : null;
  const output = {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: nudge ? `${rules}\n${nudge}\n` : rules,
    },
  };
  if (nudge) output.systemMessage = nudge;
  return output;
}

// What a project behind the kit is told, or null for one that is level. Removing a retired file
// changes how the project works, so a project that still has one is told what syncing will do
// rather than only that it is behind.
//
// No devkit.json, an invalid one, or any failure at all counts as level: the house rules must
// arrive whatever the project holds. The generator is imported here rather than at the top so
// that a broken generator costs the nudge, never the rules.
export async function nudgeFor(projectDir) {
  try {
    const { RETIRED, drifted, generate, readConfig, retiredFiles } = await import('../generator/generate.mjs');
    const behind = drifted(projectDir, generate(readConfig(projectDir))).length > 0;
    const retired = retiredFiles(projectDir);
    if (retired.length === 0) return behind ? NUDGE : null;
    const also = (file) => `Its pull request will also remove ${file}, which the kit has retired, and ${RETIRED[file]}.`;
    const [first, ...rest] = retired;
    const lead = behind
      ? `${NUDGE} ${also(first)}`
      : `This project still has ${first}, a kit-owned file the kit has retired, which can no longer run: the kit no longer has its action. ` +
        `/devkit:sync opens a pull request that removes it, and ${RETIRED[first]}.`;
    return [lead, ...rest.map(also)].join(' ');
  } catch {
    return null;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(await houseRulesOutput(event)));
}
