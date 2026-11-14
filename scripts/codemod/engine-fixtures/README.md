<!-- SPDX-License-Identifier: GPL-3.0-only -->

# Engine fixtures (V3-16aR)

Inputs for verifying the codemod engine in `scripts/codemod/`. Each
`engine-fNN-*.ts` file exercises one import pattern or edge case from
V1-05 section 4.3; see the pattern table in `../README.md`.

These fixtures are owned by the engine task (V3-16a). They are
separate from the before/after fixture pairs owned by V3-16c in
`scripts/codemod/fixtures/`. Do not import these files from `src/`;
run the engine over copies in a scratch directory (see `../README.md`).
