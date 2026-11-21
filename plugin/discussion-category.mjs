// The code reviewer (reviewer/src/night-summary.ts) and install's check (install/discussions.mjs)
// both read the category from here, so they cannot disagree about what a project needs.

export const DISCUSSION_CATEGORY = 'Code reviewer';

const CATEGORY_VAR = 'REVIEWER_DISCUSSION_CATEGORY';

/** The setting when there is one, else the default. */
export function discussionCategory(env = process.env) {
  return env[CATEGORY_VAR]?.trim() || DISCUSSION_CATEGORY;
}

/**
 * Undefined when discussions are off or the project has none of that name. Capitals and surrounding
 * spaces do not count.
 */
export function findDiscussionCategory({ enabled, categories }, category) {
  const wanted = category.trim().toLowerCase();
  return enabled ? categories.find((c) => c.name.trim().toLowerCase() === wanted) : undefined;
}

/** What the owner must do before a night's summary can be posted in `project`. */
export function missingDiscussionCategory(project, category, enabled) {
  const create =
    `a discussion category named "${category}" (the project's Discussions tab, the pencil beside ` +
    'Categories, New category; format: Open-ended discussion)';
  return (
    (enabled
      ? `${project} has no discussion category named "${category}". Create ${create}.`
      : `${project} has discussions turned off. In the project's settings on GitHub, turn on Discussions ` +
        `(Settings, General, Features), then create ${create}.`) +
    " The code reviewer posts each night's summary there. It cannot create the category: GitHub's API has no call for it."
  );
}
