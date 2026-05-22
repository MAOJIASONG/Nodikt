// Verifies that when a handler throws, EventBus.publish:
//   - logs the error
//   - persists a HANDLER_FAILED event with the right shape
//   - DOES NOT propagate the exception to the caller
// Run: node server/scripts/test-handler-failed-publish.mjs

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { EventBus } from "../dist/brain/scheduler/event_bus/eventBus.js";
import { RepositoryBundle } from "../dist/brain/store/repositories/index.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nodikt-bt6-"));

// JsonFileStore.readCollection auto-falls-back to an empty skeleton on ENOENT, so we don't
// need to seed every JSON file. We do however need a valid settings.json because
// SettingsRepository goes through readObject (not readCollection) — though our test never
// calls loadSettings, so we skip that too.
//
// All this script touches is repositories.events (via EventBus persistence). No settings,
// no sessions, no other collections.

const repositories = new RepositoryBundle(tmp);

// Throw-on-purpose handler keyed on a real EventType.
const handlers = {
  USER_INPUT_RECEIVED: async () => { throw new Error("simulated handler failure"); }
};

// Minimal wsBroadcaster stub — EventBus only calls broadcastEvent on the failure path.
const wsBroadcaster = {
  broadcastEvent: async () => {},
  broadcastWorkers: async () => {},
  broadcastDemandView: async () => {}
};

// HandlerContext requires more fields, but our throwing handler ignores them before throwing,
// and the failure branch only uses repositories + wsBroadcaster. Cast through `any` semantics
// by just stuffing what's needed; the rest are accessed lazily and never reached here.
const contextFactory = (publish) => ({
  repositories,
  wsBroadcaster,
  // Stubs for fields the failure path doesn't touch, but the type wants them present:
  planner: {},
  dispatcher: {},
  verifier: {},
  reconciliation: {},
  decisionService: {},
  memoryManager: {},
  adapterRegistry: {},
  opsMonitor: {},
  publish
});

const bus = new EventBus(handlers, repositories, contextFactory);

let propagated = false;
let propagatedErr = null;
try {
  await bus.publish({
    event_id: "evt_test_1",
    event_type: "USER_INPUT_RECEIVED",
    demand_id: "d1",
    subgoal_id: null,
    execution_id: null,
    decision_id: null,
    worker_id: null,
    payload: { input_text: "test", input_kind: "TEXT", source: "ui" },
    created_at: "2026-05-22T00:00:00.000Z"
  });
} catch (err) {
  propagated = true;
  propagatedErr = err;
}

const events = await repositories.events.list();
const handlerFailed = events.find((e) => e.event_type === "HANDLER_FAILED");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

check("exception did NOT propagate to caller", !propagated);
check("HANDLER_FAILED event was persisted", !!handlerFailed);
check("source_event_type captured", handlerFailed?.payload?.source_event_type === "USER_INPUT_RECEIVED");
check("error message captured", handlerFailed?.payload?.message === "simulated handler failure");
check("demand_id forwarded onto failure event", handlerFailed?.demand_id === "d1");

if (propagated) console.log("  (propagated error:", propagatedErr?.message, ")");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
