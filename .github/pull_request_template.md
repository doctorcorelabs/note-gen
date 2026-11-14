<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. -->
<!-- See LICENSE and FORK.md. -->

## Summary

<!-- What changes and why, in a few sentences. Link the design doc or decision (AD-xx / F1-xx) when one applies. -->

## Changes

<!-- List the main changes. Name any upstream file changed substantially. -->

## Test report

<!-- Commands run and their results. Paste the outcome per gate: typecheck, lint, unit, build, secret scan. If the contract or e2e smoke job is red only because its suite has not landed yet, say so explicitly. -->

## Checklist

- [ ] No em dash character (U+2014) in changed files or commit messages, verified with grep before commit.
- [ ] GPLv3 notice: every new file carries the short SPDX GPL-3.0-only header; every substantially changed upstream file carries a modification notice with date; LICENSE is untouched; upstream attribution is kept.
- [ ] No secret values in the diff; `.env.example` files contain placeholders only; the secret scan gate is green.
- [ ] CI gates are green: typecheck, lint, unit, build, secret scan. Contract and e2e smoke jobs fail explicitly until their suites land; any other red gate is explained in the test report above.
- [ ] This PR targets `web`, from a short-lived feature branch. No direct push to `web` or `dev`, no rebase of a pushed branch.
- [ ] `FORK.md` changelog and `CHANGELOG-FORK.md` updated when behavior changed, or N/A with a reason.
