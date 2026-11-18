import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rulesPath = fileURLToPath(new URL('../house-rules.md', import.meta.url));

export const NUDGE = 'This project is behind the kit: run /devkit:sync to bring its kit-owned files level.';

// The house rules for every event. At session start, a project whose kit-owned files differ from
// what the generator writes for its devkit.json also gets the nudge: shown to the user through
// systemMessage, and added to Claude's context after the rules.
export async function houseRulesOutput(event) {
  const rules = readFileSync(rulesPath, 'utf8');
  const nudge = event.hook_event_name === 'SessionStart' && (await isBehind(event.cwd ?? process.cwd()));
  const output = {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: nudge ? `${rules}\n${NUDGE}\n` : rules,
    },
  };
  if (nudge) output.systemMessage = NUDGE;
  return output;
}

// No devkit.json, an invalid one, or any failure at all counts as not behind: the house rules
// must arrive whatever the project holds. The generator is imported here rather than at the top
// so that a broken generator costs the nudge, never the rules.
export async function isBehind(projectDir) {
  try {
    const { drifted, generate, readConfig } = await import('../generator/generate.mjs');
    return drifted(projectDir, generate(readConfig(projectDir))).length > 0;
  } catch {
    return false;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(await houseRulesOutput(event)));
}
