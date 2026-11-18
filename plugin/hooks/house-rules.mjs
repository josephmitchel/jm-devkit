import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rulesPath = fileURLToPath(new URL('../house-rules.md', import.meta.url));

export function houseRulesOutput(event) {
  return {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: readFileSync(rulesPath, 'utf8'),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(houseRulesOutput(event)));
}
