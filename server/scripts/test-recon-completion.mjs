// server/scripts/test-recon-completion.mjs
//
// Sanity checks for ReconciliationService.buildReconCompletion routing.
// Covers the failure mode the recon-completion-dispatch refactor was
// meant to eliminate: a recon completion silently dropping into the
// wrong downstream path because of an enum whitelist mismatch.
//
// Run: node server/scripts/test-recon-completion.mjs
// Exit: 0 if all cases pass, 1 on any mismatch.

import { ReconciliationService } from "../dist/brain/review/reconciliation/service.js";

const svc = new ReconciliationService();

function makeInputs({ hasOO, kind, verifiedStatus, claimedOutcome }) {
  return {
    demand: {
      demand_id: "d1",
      title: "t",
      type: "project",
      state: "PENDING_ALIGNMENT",
      current_phase: "ALIGNMENT",
      clarified_demand: null,
      initial_input: "i",
      operational_objective: hasOO
        ? { objective: "o", acceptance_criteria: [], constraints: [], non_goals: [], termination_conditions: [] }
        : null,
      autonomy_level: "L1",
      acceptance_criteria: [],
      constraints: [],
      progress_percent: 0,
      active_decision_id: null,
      tags: [],
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:00:00.000Z"
    },
    subgoal: {
      subgoal_id: "s1",
      demand_id: "d1",
      title: "fetch paper",
      objective: "o",
      success_criteria: [],
      failure_criteria: [],
      constraints: [],
      dependencies: [],
      priority: 1,
      planning_round: 1,
      kind,
      state: "EXECUTING",
      created_at: "2026-05-22T00:00:00.000Z",
      updated_at: "2026-05-22T00:00:00.000Z"
    },
    execution: {
      execution_id: "e1", demand_id: "d1", subgoal_id: "s1", worker_id: "w1",
      state: "VERIFYING", attempt: 1, started_at: null, completed_at: null, last_heartbeat_at: null,
      latest_worker_status: null, result_status: null, claimed_outcome: null, compressed_history: "",
      artifacts: [], adapter_meta: {}, created_at: "2026-05-22T00:00:00.000Z", updated_at: "2026-05-22T00:00:00.000Z"
    },
    workerResult: {
      schema_version: "v1", execution_id: "e1", worker_id: "w1",
      worker_status: "DONE", claimed_outcome: claimedOutcome ?? "found stuff",
      compressed_history: "trace", produced_artifacts: [], blocker_reason: null,
      suggested_next_step: null, returned_at: "2026-05-22T00:00:00.000Z"
    },
    verification: {
      schema_version: "v1", execution_id: "e1", subgoal_id: "s1",
      verified_status: verifiedStatus,
      accepted_artifacts: [], gap: [], notes: "n", verified_at: "2026-05-22T00:00:00.000Z"
    }
  };
}

const cases = [
  // The bug we fixed: PARTIAL recon in clarification phase MUST route to clarifier
  { name: "PARTIAL + no OO + recon → clarifier_feedback (failed=false)", hasOO: false, kind: "recon", verifiedStatus: "PARTIAL", expectStep: "clarifier_feedback", expectFailed: false },
  { name: "VERIFIED_DONE + no OO + recon → clarifier_feedback",        hasOO: false, kind: "recon", verifiedStatus: "VERIFIED_DONE", expectStep: "clarifier_feedback", expectFailed: false },
  { name: "FAILED + no OO + recon → clarifier_feedback (failed=true)", hasOO: false, kind: "recon", verifiedStatus: "FAILED", expectStep: "clarifier_feedback", expectFailed: true },
  { name: "UNVERIFIABLE + no OO + recon → clarifier_feedback (failed=true)", hasOO: false, kind: "recon", verifiedStatus: "UNVERIFIABLE", expectStep: "clarifier_feedback", expectFailed: true },
  // Recon in planning phase
  { name: "VERIFIED_DONE + has OO + recon → planner_replan",           hasOO: true,  kind: "recon", verifiedStatus: "VERIFIED_DONE", expectStep: "planner_replan", expectFailed: false },
  // Non-recon: no reconCompletion at all
  { name: "build subgoal + VERIFIED_DONE → no reconCompletion",        hasOO: true,  kind: "build", verifiedStatus: "VERIFIED_DONE", expectStep: null, expectFailed: null }
];

let passed = 0, failed = 0;
for (const tc of cases) {
  const out = svc.reconcile(makeInputs(tc));
  const rc = out.reconCompletion;

  if (tc.expectStep === null) {
    if (rc === undefined) {
      console.log(`  ✓ ${tc.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${tc.name} — expected reconCompletion=undefined, got ${JSON.stringify(rc)}`);
      failed++;
    }
    continue;
  }

  if (!rc) {
    console.log(`  ✗ ${tc.name} — expected reconCompletion present, got undefined`);
    failed++;
    continue;
  }
  if (rc.nextStep !== tc.expectStep) {
    console.log(`  ✗ ${tc.name} — nextStep expected ${tc.expectStep}, got ${rc.nextStep}`);
    failed++;
    continue;
  }
  if (rc.finding.failed !== tc.expectFailed) {
    console.log(`  ✗ ${tc.name} — finding.failed expected ${tc.expectFailed}, got ${rc.finding.failed}`);
    failed++;
    continue;
  }
  console.log(`  ✓ ${tc.name}`);
  passed++;
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
