# Nodikt v1 Codegen Implementation Brief

以下总提示词是实现 Nodikt v1 的最高优先级约束，必须置顶使用，并与当前文档一起作为代码生成输入。

## Core Prompt

Nodikt v1 不是聊天 Agent 产品，而是代码主导的事件驱动状态机 + rolling planning + worker execution + verifier + decision panel。优先保证架构正确、状态迁移正确、协议正确、可调试、易扩展。不要把 Scheduler 写成自治 Agent，不要让 LLM 直接决定主流程，不要在 repository / adapter / planner / verifier / api / ws_broadcaster 中偷偷改状态，不要做全局聊天框，不要允许执行期修改 demand objective。

必须严格遵守：

1. `01_scheduler_state_machine.md`
2. `02_scheduler_events_and_transitions.md`
3. `03_json_schemas.md`
4. `04_worker_protocol_schemas.md`
5. `05_event_payload_schemas.md`
6. `06_backend_module_boundaries.md`
7. `07_worker_adapter_plan.md`
8. `08_frontend_frozen_spec.md`

## Implementation Defaults

- Tech stack: `TypeScript + Express + ws + React/Vite`
- Storage: JSON files only
- Worker scope: `codex`, `opencode`
- Resume path: `PAUSED -> READY -> REPLAN_REQUESTED`
- Verification rule: `UNVERIFIABLE -> Subgoal=BLOCKED, Execution=FAILED, create DecisionRequest`
- Install policy: review required, workspace only

## Milestone Order

1. domain types / validators / event payload map
2. repositories
3. event bus
4. handlers skeleton
5. planner / dispatcher / verifier / reconciliation minimum loop
6. worker adapters
7. api + websocket
8. frozen frontend skeleton
