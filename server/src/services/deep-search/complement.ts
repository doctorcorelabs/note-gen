// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Complement trigger (F2-2, wave G-F2-2d).
//
// Pure evaluation over the stored fact candidates of one job.
// The Complement stage runs only when the Assessor output is
// weak (decision 10): any fact score below the fact threshold,
// or the average score below the average threshold. Thresholds
// default to the binding coordinator values (fact 70, average
// 80) and a job may only tighten them; validation enforces the
// tighten-only rule at job creation, this module only reads the
// stored job input.
//
// Without fact candidates there is nothing to strengthen, so the
// trigger stays off with reason no_fact_candidates. Scores that
// are still null (not yet assessed) do not count: the Assessor
// always stores a score, so a null here means the stage order
// was bypassed and the honest outcome is no trigger.

import type { SearchFactCandidateRow } from './represent.js';
import { averageScoreOf } from './assessor.js';

export interface ComplementThresholds {
  complementThresholdFact: number;
  complementThresholdAverage: number;
}

export interface ComplementTriggerResult {
  triggered: boolean;
  minScore: number | null;
  averageScore: number | null;
  // Stable machine code: no_fact_candidates,
  // fact_below_threshold, average_below_threshold,
  // fact_and_average_below_threshold, not_triggered.
  reason: string;
}

export function evaluateComplementTrigger(
  factCandidates: Pick<SearchFactCandidateRow, 'score'>[],
  thresholds: ComplementThresholds,
): ComplementTriggerResult {
  const scores = factCandidates
    .map((fact) => fact.score)
    .filter((score): score is number => score !== null);
  if (scores.length === 0) {
    return {
      triggered: false,
      minScore: null,
      averageScore: null,
      reason: 'no_fact_candidates',
    };
  }
  const minScore = Math.min(...scores);
  const averageScore = averageScoreOf(scores);
  const factBelow = minScore < thresholds.complementThresholdFact;
  const averageBelow =
    averageScore !== null && averageScore < thresholds.complementThresholdAverage;
  if (factBelow && averageBelow) {
    return {
      triggered: true,
      minScore,
      averageScore,
      reason: 'fact_and_average_below_threshold',
    };
  }
  if (factBelow) {
    return { triggered: true, minScore, averageScore, reason: 'fact_below_threshold' };
  }
  if (averageBelow) {
    return { triggered: true, minScore, averageScore, reason: 'average_below_threshold' };
  }
  return { triggered: false, minScore, averageScore, reason: 'not_triggered' };
}
