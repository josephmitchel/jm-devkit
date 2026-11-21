/**
 * Who may answer. An answer is not a comment: it decides which concerns get fixed, is written into
 * the fixer's prompt, and is saved as a policy that every later audit of the project reads. Anyone
 * on the internet can comment on a public PR, so the author's relationship to the project is the
 * gate, and anything GitHub does not vouch for is read as ordinary conversation.
 */
export const ANSWER_AUTHORITY = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Written by someone who may answer, and not one of the code reviewer's own comments. The review
 * reads answers by this rule, and the poller continues a waiting review by the same one.
 */
export function countsAsReply(comment: { id: number; authorAssociation: string }, own: ReadonlySet<number>): boolean {
  return !own.has(comment.id) && ANSWER_AUTHORITY.has(comment.authorAssociation);
}

/** As `github_artifacts` records them. */
export const OWN_COMMENT_KINDS: ReadonlySet<string> = new Set([
  'report_comment',
  'summary_comment',
  'pr_summary_comment',
  'progress_comment',
  'failure_comment',
  'carry_comment',
]);
