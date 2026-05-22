// Verifies tryTransition returns ok=true for legal moves, ok=false for illegal ones,
// and never throws. Run: node server/scripts/test-try-transition.mjs

import { tryTransition } from "../dist/brain/scheduler/handlers/stateMachine.js";

const transitions = {
  A: ["A", "B"],
  B: ["B", "C"],
  C: ["C"]
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

check("legal A->B", tryTransition("t", "A", "B", transitions).ok === true);
check("legal A->A (self)", tryTransition("t", "A", "A", transitions).ok === true);
check("illegal A->C", tryTransition("t", "A", "C", transitions).ok === false);

const illegal = tryTransition("t", "A", "C", transitions);
check("illegal returns reason string", !illegal.ok && typeof illegal.reason === "string" && illegal.reason.includes("A"));

const unknown = tryTransition("t", "Z", "A", transitions);
check("unknown source returns ok=false", !unknown.ok);

// Critical: must not throw
let didNotThrow = true;
try { tryTransition("t", "A", "Z", transitions); } catch { didNotThrow = false; }
check("never throws", didNotThrow);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
