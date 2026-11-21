import { describe, expect, it } from 'vitest';
import { landingRecorded, ticketReferences } from './landed.js';

/**
 * The merge event reads the PR body to learn which tickets landed. `Addresses #N` is the
 * convention; a closing keyword is the slip the automation has to catch, because GitHub has
 * already closed that ticket by the time this runs.
 */
describe('ticketReferences', () => {
  it('reads Addresses lines, one or many', () => {
    expect(ticketReferences('Addresses #2\n\nAddresses #7')).toEqual({ addressed: [2, 7], closed: [] });
    expect(ticketReferences('addresses #3, #4 and #5')).toEqual({ addressed: [3, 4, 5], closed: [] });
    expect(ticketReferences('Addresses: #9')).toEqual({ addressed: [9], closed: [] });
  });

  it('separates GitHub closing keywords from Addresses', () => {
    expect(ticketReferences('Closes #2\nAddresses #3\nfixes #4')).toEqual({ addressed: [3], closed: [2, 4] });
  });

  it('ignores cross-repo references and bare mentions', () => {
    expect(ticketReferences('Addresses acme/other#5. See also #6 for context.')).toEqual({ addressed: [], closed: [] });
  });

  it('dedupes', () => {
    expect(ticketReferences('Addresses #2\nAddresses #2')).toEqual({ addressed: [2], closed: [] });
  });
});

describe('landingRecorded', () => {
  const comment = (body: string, by: { authorLogin?: string; authorAssociation?: string } = {}) => ({
    body,
    authorLogin: 'the-code-reviewer[bot]',
    authorAssociation: 'NONE',
    ...by,
  });
  const landed = 'PR #12 landed. Labelled `needs-judging`: the nightly judge decides whether this ticket is solved.';

  it("finds this pull request's landed comment on the ticket", () => {
    expect(landingRecorded([comment('I will take this one'), comment(landed)], 12)).toBe(true);
  });

  it('is not recorded on a ticket with no such comment', () => {
    expect(landingRecorded([], 12)).toBe(false);
    expect(landingRecorded([comment('See PR #12, which landed.')], 12)).toBe(false);
  });

  it("does not take another pull request's landing for this one's", () => {
    expect(landingRecorded([comment(landed)], 1)).toBe(false);
    expect(landingRecorded([comment(landed)], 120)).toBe(false);
  });

  it('counts the same words from the owner, and from nobody GitHub does not vouch for', () => {
    expect(landingRecorded([comment(landed, { authorLogin: 'the-owner', authorAssociation: 'OWNER' })], 12)).toBe(true);
    expect(landingRecorded([comment(landed, { authorLogin: 'a-stranger', authorAssociation: 'NONE' })], 12)).toBe(false);
  });
});
