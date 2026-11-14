// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Explicit "not yet landed" failure for E2E flows whose feature has
// not been implemented in the web fork yet.
//
// A TODO flow MUST call notYetLanded as its first statement and do
// nothing else. The thrown error fails the test with a message that
// names the missing feature, so the suite reports the gap honestly:
// - No test.skip / test.fixme: a skipped test hides the gap.
// - No test.fail: an expected failure that "passes" when it fails is
//   a false pass in the report.
// - No placeholder assertions: an assertion that cannot fail is a lie.
//
// When the feature lands, the flow author replaces the notYetLanded
// call with the real steps (outlined in comments in each TODO spec)
// and removes this import. The message wording "fitur belum mendarat"
// is the agreed marker; keep it verbatim so reports and greps match.

export function notYetLanded(flowId: string, missing: string): never {
  throw new Error(
    `fitur belum mendarat: ${flowId}: ${missing} ` +
      'Implement the feature first, then replace the notYetLanded call ' +
      'in this spec with the real steps outlined in its comments.',
  )
}
