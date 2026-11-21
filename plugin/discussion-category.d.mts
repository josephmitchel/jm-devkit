// Types for what the code reviewer imports from discussion-category.mjs.

/** The default name of the category a night's summary is posted in. */
export declare const DISCUSSION_CATEGORY: string;

/** The name of the category: the setting when there is one, else the default. */
export declare function discussionCategory(env?: Record<string, string | undefined>): string;

/** The project's category of that name, or undefined when discussions are off or it has none. */
export declare function findDiscussionCategory<C extends { name: string }>(
  setup: { enabled: boolean; categories: C[] },
  category: string,
): C | undefined;

/** What the owner must do before a night's summary can be posted in `project`. */
export declare function missingDiscussionCategory(project: string, category: string, enabled: boolean): string;
