// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Diff and report helpers for the codemod engine (V3-16a).
 *
 * The unified diff is implemented here with zero dependencies: common
 * prefix/suffix trimming plus an LCS over the remaining window, with
 * three lines of context. Import-only edits keep the window small, so
 * the LCS stays cheap; a guard falls back to one coarse hunk when the
 * window would make the table too large.
 */

const CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 25_000_000;

function splitLines(text) {
  const lines = text.split("\n");
  const trailingNewline = text.endsWith("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/**
 * LCS table for the windowed line lists. Returns the list of matched
 * index pairs, or null when the table would exceed the guard.
 */
function lcsPairs(before, after) {
  const rows = before.length + 1;
  const cols = after.length + 1;
  if (rows * cols > MAX_LCS_CELLS) return null;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const index = i * cols + j;
      if (before[i] === after[j]) table[index] = table[(i + 1) * cols + (j + 1)] + 1;
      else table[index] = Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function buildOps(before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ops = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: " ", beforeIndex: i, afterIndex: i });
  const beforeWindow = before.slice(prefix, before.length - suffix);
  const afterWindow = after.slice(prefix, after.length - suffix);
  const pairs = lcsPairs(beforeWindow, afterWindow);
  if (pairs === null) {
    for (let i = 0; i < beforeWindow.length; i += 1) {
      ops.push({ kind: "-", beforeIndex: prefix + i, afterIndex: null });
    }
    for (let j = 0; j < afterWindow.length; j += 1) {
      ops.push({ kind: "+", beforeIndex: null, afterIndex: prefix + j });
    }
  } else {
    let i = 0;
    let j = 0;
    for (const [pi, pj] of pairs) {
      while (i < pi) {
        ops.push({ kind: "-", beforeIndex: prefix + i, afterIndex: null });
        i += 1;
      }
      while (j < pj) {
        ops.push({ kind: "+", beforeIndex: null, afterIndex: prefix + j });
        j += 1;
      }
      ops.push({ kind: " ", beforeIndex: prefix + i, afterIndex: prefix + j });
      i += 1;
      j += 1;
    }
    while (i < beforeWindow.length) {
      ops.push({ kind: "-", beforeIndex: prefix + i, afterIndex: null });
      i += 1;
    }
    while (j < afterWindow.length) {
      ops.push({ kind: "+", beforeIndex: null, afterIndex: prefix + j });
      j += 1;
    }
  }
  for (let k = 0; k < suffix; k += 1) {
    ops.push({
      kind: " ",
      beforeIndex: before.length - suffix + k,
      afterIndex: after.length - suffix + k,
    });
  }
  return ops;
}

/** Render a unified diff for one file, or "" when the texts are equal. */
export function unifiedDiff(oldText, newText, relPath) {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  if (oldText === newText) return "";
  const ops = buildOps(before.lines, after.lines);
  const changed = ops.some((op) => op.kind !== " ");
  if (!changed) return "";
  const hunks = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === " ") {
      index += 1;
      continue;
    }
    const hunkStart = Math.max(0, index - CONTEXT_LINES);
    let hunkEnd = index;
    let lastChange = index;
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].kind !== " ") lastChange = hunkEnd;
      if (hunkEnd - lastChange > CONTEXT_LINES * 2) break;
      hunkEnd += 1;
    }
    hunkEnd = Math.min(ops.length, lastChange + CONTEXT_LINES + 1);
    hunks.push(ops.slice(hunkStart, hunkEnd));
    index = hunkEnd;
  }
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const hunk of hunks) {
    const beforeOps = hunk.filter((op) => op.kind !== "+");
    const afterOps = hunk.filter((op) => op.kind !== "-");
    const beforeStart = beforeOps.length > 0 ? beforeOps[0].beforeIndex + 1 : 0;
    const afterStart = afterOps.length > 0 ? afterOps[0].afterIndex + 1 : 0;
    out.push(`@@ -${beforeStart},${beforeOps.length} +${afterStart},${afterOps.length} @@`);
    for (const op of hunk) {
      const line = op.kind === "+" ? after.lines[op.afterIndex] : before.lines[op.beforeIndex];
      out.push(`${op.kind}${line}`);
      const isLastBefore = op.kind !== "+" && op.beforeIndex === before.lines.length - 1;
      const isLastAfter = op.kind !== "-" && op.afterIndex === after.lines.length - 1;
      if (isLastBefore && !before.trailingNewline) out.push("\\ No newline at end of file");
      if (isLastAfter && !after.trailingNewline) out.push("\\ No newline at end of file");
    }
  }
  return `${out.join("\n")}\n`;
}

/** Totals over per-file results. */
export function summarize(results) {
  const totals = {
    filesSeen: results.length,
    transformed: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    declarationsTransformed: 0,
    declarationsSkipped: 0,
    declarationsDeferred: 0,
    bindingsRemoved: 0,
    referencesReported: 0,
    dynamicImportsReported: 0,
    unsupportedReported: 0,
    manualReviewFiles: 0,
  };
  for (const result of results) {
    if (result.status === "transformed") totals.transformed += 1;
    else if (result.status === "unchanged") totals.unchanged += 1;
    else if (result.status === "skipped") totals.skipped += 1;
    else if (result.status === "error") totals.errors += 1;
    totals.declarationsTransformed += result.declarationsTransformed ?? 0;
    totals.declarationsSkipped += result.declarationsSkipped?.length ?? 0;
    totals.declarationsDeferred += result.declarationsDeferred?.length ?? 0;
    totals.bindingsRemoved += result.bindings?.length ?? 0;
    totals.referencesReported +=
      result.bindings?.reduce((sum, binding) => sum + (binding.totalReferences ?? 0), 0) ?? 0;
    totals.dynamicImportsReported += result.dynamicImports?.length ?? 0;
    totals.unsupportedReported += result.unsupported?.length ?? 0;
    if ((result.manualReview?.length ?? 0) > 0) totals.manualReviewFiles += 1;
  }
  return totals;
}

/** Human-readable one-line status per file plus skip reasons. */
export function printSummary(results, totals, mode) {
  const lines = [];
  lines.push(`codemod engine: ${mode}, ${totals.filesSeen} file(s) seen`);
  lines.push(
    `transformed=${totals.transformed} unchanged=${totals.unchanged} skipped=${totals.skipped} errors=${totals.errors}`,
  );
  lines.push(
    `declarations transformed=${totals.declarationsTransformed} skipped=${totals.declarationsSkipped} deferred=${totals.declarationsDeferred}`,
  );
  lines.push(
    `bindings removed=${totals.bindingsRemoved} references reported=${totals.referencesReported} dynamic imports reported=${totals.dynamicImportsReported}`,
  );
  lines.push(
    `unsupported=${totals.unsupportedReported} manual-review files=${totals.manualReviewFiles}`,
  );
  for (const result of results) {
    if (
      result.status === "unchanged" &&
      (result.unsupported?.length ?? 0) === 0 &&
      (result.manualReview?.length ?? 0) === 0
    ) {
      continue;
    }
    if (result.status === "error") {
      lines.push(`ERROR ${result.path}: ${result.error ?? "unknown error"}`);
      continue;
    }
    const reasons = [
      ...(result.declarationsSkipped ?? []).map((d) => `${d.reason} (line ${d.line}, ${d.specifier})`),
      ...(result.dynamicImports ?? [])
        .filter((d) => d.reason !== "rewritten")
        .map((d) => `${d.reason} (line ${d.line}${d.specifier ? `, ${d.specifier}` : ""})`),
      ...(result.unsupported ?? []).map((d) => `UNSUPPORTED ${d.reason} (line ${d.line}, ${d.specifier})`),
      ...(result.manualReview ?? []).map((d) => `MANUAL-REVIEW ${d.importedName} (${d.specifier})`),
    ];
    lines.push(
      `${result.status.toUpperCase()} ${result.path}: ${result.declarationsTransformed ?? 0} declaration(s) transformed` +
        (reasons.length > 0 ? `; skipped: ${reasons.join("; ")}` : ""),
    );
  }
  return `${lines.join("\n")}\n`;
}
