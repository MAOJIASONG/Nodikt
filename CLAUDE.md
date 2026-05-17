# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

npm workspaces monorepo on Node 20 (`.nvmrc` = 20.20.1):
- `server/` — TypeScript backend (Express + ws + pino), CommonJS output to `server/dist/`. This is the Nodikt **Brain** + **Interface** transport (HTTP/WebSocket).
- `web/` — React 18 + Vite frontend (the Nodikt Interface UI), built to `web/dist/`.
- `doc/` — Authoritative design specs (Chinese). `doc/06_backend_module_boundaries.md` defines module dependency rules; consult before adding cross-module imports.
- `server/data/*.json` — runtime persistence (demands, subgoals, executions, workers, decisions, events, memory, sessions, settings). These files are tracked in git but mutate as the server runs.
- `server/logs/app.log` — pino log output (also tracked, also mutates).

## Common commands

```bash
# Build both workspaces (server tsc + web vite build)
npm run build

# Server: tsc --watch only (does NOT auto-restart node). Run dist/index.js separately.
npm run dev               # = npm run dev -w server
npm start -w server       # = node dist/index.js, listens on PORT (default 3001)

# Web: Vite dev server on :5173, proxies /api and /ws to http://localhost:3001
npm run dev:web

# Server tests (node --test runner against compiled dist-test/)
npm test                  # = npm test -w server
```

Note: `npm test` currently invokes `tsc -p tsconfig.test.json` and looks for `dist-test/**/*.test.js`, but `server/tsconfig.test.json` and any `*.test.ts` files are absent from the tree — the script will fail until they are added. Don't claim tests pass without verifying.

## Runtime configuration

Copy `.env.example` → `.env`. Variables read at server startup (`server/src/index.ts`, `server/src/logger.ts`):

- `PORT` — HTTP/WS port (default 3001).
- `OPENCODE_INSTALL_ROOT` — absolute path to the opencode CLI install (contains `bin/opencode` and `opencode_run.sh`). Defaults to `../opencode` relative to cwd.
- `OPENCODE_RUNTIME_HOME` — HOME dir injected into worker subprocesses (session state). Defaults to `./.opencode-runtime`.
- `CLAUDE_CODE_INSTALL_ROOT` — optional absolute path to a Claude Code CLI install. When set, the adapter prepends `${ROOT}/bin` to PATH and uses `${ROOT}/bin/claude` as the binary. Leave empty if `claude` is on the node process's PATH already.
- `CLAUDE_CODE_RUNTIME_HOME` — HOME dir injected into the Claude Code subprocess (where `~/.claude` config and sessions live). Defaults to `./.claude-code-runtime`.
- `CLAUDE_CODE_PERMISSION_MODE` — passed to `claude --permission-mode`. Defaults to `bypassPermissions`. Pair with workspace isolation.
- `CLAUDE_CODE_ALLOWED_TOOLS` / `CLAUDE_CODE_DISALLOWED_TOOLS` — optional, forwarded verbatim to `claude --allowedTools` / `--disallowedTools`.
- `NODIKT_WORKSPACE_ROOT` — workspace dir spawned worker tasks operate in. Defaults to `./workspace`.
- `LOG_LEVEL`, `LOG_FILE` — pino config.

On boot, `ensureDefaultWorkers` in `server/src/index.ts` reconciles `server/data/workers.json` with the env-driven workspace root and routes each existing worker to its adapter (`opencode` / `claude_code` / `codex`) by `adapter_type`. If `worker_opencode_local` or `worker_claude_code_local` is absent it seeds the default. It also deletes any legacy `worker_codex_local` row — be aware if you're testing codex paths.

The `claude_code` adapter parses Claude Code's `--output-format stream-json` output: tool calls drive heartbeats, the `result` event drives the final WorkerResult, and `AskUserQuestion` calls / `NEED_CLARIFICATION:` prefixes / question-shaped result text are mapped to `worker_status=NEED_HELP` with structured info in `adapter_meta.claude_ask_signal` so the existing decision panel can surface them. Across retries and replans, `onExecutionDispatched` looks up the most recent prior execution's `adapter_meta.claude_session_id` and appends `claude_session_resume=<sid>` to the packet's `environment_notes`; the adapter rewrites that into `claude --resume <sid>`, so Claude Code's session continues across subgoal boundaries.

## Architecture

The system implements the three-layer architecture described in `README.md` (Interface / Brain / Workers). In this repo, the server hosts both Interface transport and the entire Brain; Workers are out-of-process adapters (`codex`, `opencode`) launched via the worker adapter contract.

### Event-sourced scheduler (the load-bearing pattern)

Everything in the Brain flows through one `EventBus` (`server/src/brain/scheduler/event_bus/eventBus.ts`):

1. HTTP routes (`server/src/interface/http/routes.ts`) translate user actions into `SchedulerEvent`s and call `eventBus.publish(event)`. **Routes should not directly mutate domain state** — they publish events and read back from repositories.
2. `EventBus.publish` persists every event to `events.json`, looks up the handler in `HandlerMap`, executes it with a `HandlerContext`, broadcasts the event via `WsBroadcaster`, then recursively publishes any follow-up events the handler returned. This recursion is how multi-step flows (clarify → plan → dispatch → verify → reconcile) compose.
3. Handlers live under `server/src/brain/scheduler/handlers/eventHandlers/` grouped by concern (`demandHandlers`, `planningHandlers`, `executionHandlers`, `reviewHandlers`, `opsHandlers`). Each handler returns a `HandlerResult` whose `events` field drives the next step. The registration map is in `handlers/index.ts` — adding a new `EventType` requires both an enum entry (`server/src/domain/enums.ts`) and a handler entry here, otherwise the event is just persisted and the flow stalls silently.
4. State machines are enforced through helpers in `handlers/stateMachine.ts` and `handlers/sessionState.ts`. Demand/Subgoal/Execution states are enums in `domain/enums.ts`; cross-module code should reference these enums rather than string literals.

### Brain services (called by handlers, not by routes)

- `brain/engines/planner` — `clarifyDemand` and plan generation (calls LLM).
- `brain/engines/decision` — human-in-the-loop decision requests.
- `brain/engines/llm` — model client abstraction.
- `brain/dispatch/dispatcher` — packages `SubgoalContract` → `WorkerDispatchPacket` for an adapter. Reads a `DispatchMemorySnapshot` from `MemoryManager` and weaves recent `mission_state` / `episodic_trace` / `lessons_or_policy` records into `context_slice.mission_state_summary`, `relevant_history`, and `shared_hints`. For `claude_code` workers, also injects `claude_session_resume=<sid>` into `environment_notes` when a prior session id is supplied.
- `brain/review/verifier` — inspects artifacts/files to validate worker claims.
- `brain/review/reconciliation` — folds verified results back into `MissionState`.
- `brain/store/memory_manager` — three-layer memory described in README. Exposes `createExecutionMemories` (writes mission/trace/lesson records on every verification) and `getDispatchMemorySnapshot` (reads them back for the dispatcher). Together they form the progressive feedback loop — each retry/replan ships the prior attempt's lessons to the worker.
- `brain/ops` — heartbeat/timeout monitor; runs as an interval started in `main()` and emits `OPS_*` events.

### Storage

`brain/store/repositories/` exposes a `RepositoryBundle` of typed `CollectionRepository<T>` instances over a shared `JsonFileStore`. Each collection is one JSON file under `server/data/`. Schemas live in `domain/validators.ts` (zod) and gate every write. **Only handlers and services touch repositories** — adapters and the HTTP layer go through services or events.

### Worker adapters

`server/src/worker/adapters/` — `WorkerAdapter` contract (`contract.ts`) with `register / startExecution / stopExecution / pollStatus / collectResult / healthCheck`. Concrete implementations (`codexAdapter`, `opencodeAdapter`) extend `baseLocalCommandAdapter`. The `AdapterRegistry` is an **in-memory** map of `worker_id → adapter` populated at startup from `workers.json`; a process restart without re-registration leaves dispatched executions orphaned.

### Realtime

`interface/realtime/service.ts` (`WsBroadcaster`) pushes three message types over `/ws`: `event` (raw `SchedulerEvent`), `demand_view` (recomputed for the affected demand), and `workers` (full list). The web client subscribes via `web/src/api/socket.ts`. Vite dev proxies both `/api` and `/ws` to `localhost:3001`, so run the server before `npm run dev:web`.

## Module-boundary rules to respect

From `doc/06_backend_module_boundaries.md`:
- The Interface layer (`interface/http`, `interface/realtime`) must not contain business logic — it translates I/O to events and reads views back.
- Only event handlers perform state transitions; do not mutate `demands`/`subgoals`/`executions` from routes, services, or adapters directly.
- During execution, the demand's `operational_objective` is immutable — replan modifies subgoals, not the objective.
- v1 storage is JSON files. Don't introduce a database layer without coordinating with the design docs.

## Conventions seen across the codebase

- File-level Chinese docblocks (`文件名称 / 文件作用 / 主要职责 / 依赖模块 / 注意事项`) are the norm; new server files should follow the same template so the doc tone stays consistent.
- TypeScript `strict: true`, ESM-style relative imports with explicit `.js` extensions (because output is CommonJS resolved by Node's module resolver — keep the `.js` suffix in source).
- Domain types/enums/validators are the source of truth. Adding a new persisted field means updating `domain/types.ts`, `domain/validators.ts`, and any handler that constructs the entity.
