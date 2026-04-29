import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactRef,
  DecisionAction,
  DecisionReasonCode,
  DecisionRequest,
  DecisionSource,
  DecisionStatus,
  Demand,
  DemandPhase,
  DemandState,
  EventType,
  Execution,
  ExecutionState,
  MemoryRecord,
  OperationalObjective,
  SchedulerEvent,
  Settings,
  SubgoalContract,
  SubgoalState,
  VerificationResult,
  VerificationStatus,
  WorkerExecutionStatus,
  WorkerRegistration,
  WorkerRegistryStatus,
  WorkerResult,
  WorkerResultStatus
} from "../domain/index.js";
import { HandlerContext } from "../event_bus/types.js";
import { ReconciliationService } from "../reconciliation/service.js";
import { createHandlers } from "./index.js";
import {
  demandHasActiveExecutions,
  listActiveExecutionsForDemand,
  syncWorkerExecutionSlots
} from "./executionRuntime.js";
import {
  onClarificationCompleted,
  onDemandCancelled,
  onDemandPaused,
  onDemandResumed,
  onMissionCompleted,
  onUserInput
} from "./eventHandlers/demandHandlers.js";
import {
  onExecutionCreated,
  onExecutionDispatched,
  onExecutionStopRequested,
  onWorkerHeartbeat,
  onWorkerResult
} from "./eventHandlers/executionHandlers.js";
import { onOpsAlert } from "./eventHandlers/opsHandlers.js";
import {
  onPlanGenerated,
  onReplanRequested,
  onSubgoalCreated,
  onSubgoalMarkedReady
} from "./eventHandlers/planningHandlers.js";
import {
  onDecisionRequestCreated,
  onDecisionResponseReceived,
  onVerificationCompleted
} from "./eventHandlers/reviewHandlers.js";
import {
  collectUnlockedPlannedSubgoals,
  isSubgoalUnlockedByPlan
} from "./planProgress.js";
import {
  appendConversationTurns,
  patchRuntimeSession,
  readConversationHistory
} from "./sessionState.js";
import {
  assertTransition,
  transitionDemand,
  transitionExecution,
  transitionSubgoal
} from "./stateMachine.js";

const TS = "2026-01-01T00:00:00.000Z";

class MemoryCollection<TItem extends Record<string, any>> {
  constructor(
    private readonly idKey: keyof TItem,
    private items: TItem[] = []
  ) {}

  async list(): Promise<TItem[]> {
    return this.items;
  }

  async getById(id: string): Promise<TItem | undefined> {
    return this.items.find((item) => String(item[this.idKey]) === id);
  }

  async upsert(item: TItem): Promise<void> {
    const id = item[this.idKey];
    this.items = this.items.filter((existing) => existing[this.idKey] !== id);
    this.items.push(item);
  }

  async saveAll(items: TItem[]): Promise<void> {
    this.items = items;
  }
}

type ContextSeed = {
  demands?: Demand[];
  subgoals?: SubgoalContract[];
  executions?: Execution[];
  workers?: WorkerRegistration[];
  decisions?: DecisionRequest[];
  events?: SchedulerEvent<any>[];
  memory?: MemoryRecord[];
};

function objective(): OperationalObjective {
  return {
    objective: "Ship the requested change",
    acceptance_criteria: ["Tests pass"],
    constraints: ["Keep scope small"]
  };
}

function settings(): Settings {
  return {
    version: "v1",
    updated_at: TS,
    workspace_root: "F:/Nodikt",
    default_autonomy_level: "L2",
    default_permissions: {
      can_modify_files: true,
      can_run_commands: true,
      can_install_dependencies: false,
      can_open_pr: false
    },
    runtime: {
      heartbeat_interval_seconds: 10,
      execution_timeout_seconds: 120,
      max_retry_count: 1
    },
    worker_policy: {
      skill_install_scope: "workspace_only"
    },
    models: {
      primary: { provider: "test", model: "test", base_url: "", api_key: "", enabled: false },
      planner: { provider: "test", model: "test", base_url: "", api_key: "", enabled: false },
      verifier: { provider: "test", model: "test", base_url: "", api_key: "", enabled: false },
      ops_backup: { provider: "test", model: "test", base_url: "", api_key: "", enabled: false }
    }
  };
}

function demand(patch: Partial<Demand> = {}): Demand {
  return {
    demand_id: "demand_1",
    title: "Test demand",
    type: "project",
    initial_input: "Do the thing",
    clarified_demand: "Do the thing in this repo",
    operational_objective: objective(),
    state: DemandState.READY,
    autonomy_level: "L2",
    acceptance_criteria: ["Tests pass"],
    constraints: ["Keep scope small"],
    progress_percent: 0,
    current_phase: DemandPhase.PLANNING,
    active_decision_id: null,
    tags: [],
    created_at: TS,
    updated_at: TS,
    metadata: {},
    ...patch
  };
}

function subgoal(patch: Partial<SubgoalContract> = {}): SubgoalContract {
  return {
    subgoal_id: "subgoal_1",
    demand_id: "demand_1",
    title: "Implement unit",
    objective: "Implement one unit",
    success_criteria: ["Works"],
    failure_criteria: ["Does not work"],
    constraints: [],
    budget: { max_steps: 10 },
    deliverables: ["file_bundle"],
    dependencies: [],
    priority: 1,
    state: SubgoalState.PLANNED,
    planning_round: 1,
    created_at: TS,
    updated_at: TS,
    ...patch
  };
}

function execution(patch: Partial<Execution> = {}): Execution {
  return {
    execution_id: "exec_1",
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    worker_id: "worker_1",
    state: ExecutionState.QUEUED,
    attempt: 1,
    started_at: null,
    completed_at: null,
    last_heartbeat_at: null,
    latest_worker_status: null,
    result_status: null,
    claimed_outcome: null,
    compressed_history: "",
    artifacts: [],
    adapter_meta: {},
    created_at: TS,
    updated_at: TS,
    ...patch
  };
}

function worker(patch: Partial<WorkerRegistration> = {}): WorkerRegistration {
  return {
    worker_id: "worker_1",
    name: "Worker One",
    adapter_type: "codex",
    runtime_type: "local_command",
    status: WorkerRegistryStatus.IDLE,
    max_concurrency: 1,
    capabilities: ["code_generation", "file_edit"],
    available_skills: [],
    install_policy: "none",
    config: { workspace_root: "F:/Nodikt" },
    current_execution_ids: [],
    last_seen_at: null,
    last_error: null,
    is_enabled: true,
    created_at: TS,
    updated_at: TS,
    ...patch
  };
}

function decision(patch: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    schema_version: "v1",
    decision_id: "decision_1",
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: null,
    source: "scheduler",
    reason_code: DecisionReasonCode.BLOCKED,
    prompt: "Need a decision",
    options: [
      DecisionAction.APPROVE,
      DecisionAction.REJECT,
      DecisionAction.PROVIDE_INFO,
      DecisionAction.PAUSE,
      DecisionAction.STOP,
      DecisionAction.CANCEL_DEMAND
    ],
    status: DecisionStatus.OPEN,
    created_at: TS,
    resolved_at: null,
    metadata: {},
    ...patch
  };
}

function artifact(patch: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    artifact_id: "artifact_1",
    artifact_type: "file_bundle",
    backend: "filesystem",
    uri: "F:/Nodikt/server",
    created_at: TS,
    ...patch
  };
}

function workerResult(patch: Partial<WorkerResult> = {}): WorkerResult {
  return {
    schema_version: "v1",
    execution_id: "exec_1",
    worker_id: "worker_1",
    worker_status: WorkerResultStatus.DONE,
    claimed_outcome: "Done",
    compressed_history: "Changed files",
    produced_artifacts: [artifact()],
    returned_at: TS,
    ...patch
  };
}

function verification(patch: Partial<VerificationResult> = {}): VerificationResult {
  return {
    schema_version: "v1",
    execution_id: "exec_1",
    subgoal_id: "subgoal_1",
    verified_status: VerificationStatus.VERIFIED_DONE,
    accepted_artifacts: [artifact()],
    notes: "Looks good",
    verified_at: TS,
    ...patch
  };
}

let eventCounter = 0;
function event<TPayload>(
  eventType: EventType,
  payload: TPayload,
  refs: Partial<SchedulerEvent> = {}
): SchedulerEvent<TPayload> {
  eventCounter += 1;
  return {
    event_id: `evt_${eventCounter}`,
    event_type: eventType,
    payload,
    created_at: TS,
    demand_id: refs.demand_id ?? null,
    subgoal_id: refs.subgoal_id ?? null,
    execution_id: refs.execution_id ?? null,
    decision_id: refs.decision_id ?? null,
    worker_id: refs.worker_id ?? null
  };
}

function createContext(seed: ContextSeed = {}) {
  const repositories = {
    demands: new MemoryCollection<Demand>("demand_id", seed.demands ?? []),
    subgoals: new MemoryCollection<SubgoalContract>("subgoal_id", seed.subgoals ?? []),
    executions: new MemoryCollection<Execution>("execution_id", seed.executions ?? []),
    workers: new MemoryCollection<WorkerRegistration>("worker_id", seed.workers ?? []),
    decisions: new MemoryCollection<DecisionRequest>("decision_id", seed.decisions ?? []),
    events: new MemoryCollection<SchedulerEvent<any>>("event_id", seed.events ?? []),
    memory: new MemoryCollection<MemoryRecord>("memory_id", seed.memory ?? []),
    loadSettings: async () => settings()
  };
  const adapters = new Map<string, any>();
  const executionAdapters = new Map<string, any>();
  const startedPackets: any[] = [];
  const stoppedExecutions: string[] = [];
  const published: SchedulerEvent<unknown>[] = [];

  const ctx = {
    repositories,
    planner: {
      clarifyDemand: async () => ({
        status: "READY",
        display_title: "Ready demand",
        clarified_demand: "Clarified demand",
        operational_objective: objective(),
        clarification_summary: "Ready to plan"
      }),
      generateFrontierPlan: async (inputDemand: Demand, reason: any, planningRound: number) => {
        const createdSubgoal = subgoal({
          subgoal_id: "planned_subgoal_1",
          demand_id: inputDemand.demand_id,
          planning_round: planningRound
        });
        return {
          subgoals: [createdSubgoal],
          payload: {
            planning_round: planningRound,
            dependency_graph_snapshot: { frontier: [createdSubgoal.subgoal_id] },
            frontier_subgoal_ids: [createdSubgoal.subgoal_id],
            overall_plan_outline: [
              {
                plan_item_id: "plan_1",
                title: "Plan item",
                objective: "Do it",
                execution_mode: "parallel",
                rationale: "Fast",
                frontier_subgoal_ids: [createdSubgoal.subgoal_id]
              }
            ],
            high_level_summary: {
              mission_state_summary: "Mission",
              episodic_trace_summary: "Trace",
              lessons_or_policy_summary: "Lessons"
            },
            reason
          }
        };
      }
    },
    dispatcher: {
      selectWorker: (workers: WorkerRegistration[]) => workers.find((item) => (
        item.is_enabled && item.current_execution_ids.length < item.max_concurrency
      )),
      buildExecution: ({ demand: demandInput, subgoal: subgoalInput, worker: workerInput }: any) => execution({
        execution_id: "exec_from_dispatch",
        demand_id: demandInput.demand_id,
        subgoal_id: subgoalInput.subgoal_id,
        worker_id: workerInput.worker_id
      }),
      buildPacket: ({ demand: demandInput, subgoal: subgoalInput, execution: executionInput, worker: workerInput }: any) => ({
        schema_version: "v1",
        demand_id: demandInput.demand_id,
        subgoal_id: subgoalInput.subgoal_id,
        execution_id: executionInput.execution_id,
        worker_id: workerInput.worker_id
      })
    },
    verifier: {
      verify: (subgoalId: string, result: WorkerResult) => verification({
        subgoal_id: subgoalId,
        execution_id: result.execution_id
      })
    },
    reconciliation: new ReconciliationService(),
    decisionService: {
      buildPrompt: async (input: { fallbackPrompt: string }) => `prompt:${input.fallbackPrompt}`,
      buildFollowUp: async () => "follow-up",
      appendConversationTurns: (
        metadata: Record<string, unknown> | undefined,
        turns: Array<{ role: "assistant" | "user"; content: string; created_at: string }>
      ) => ({
        ...(metadata ?? {}),
        conversation_history: [
          ...(Array.isArray(metadata?.conversation_history) ? metadata!.conversation_history as any[] : []),
          ...turns
        ]
      }),
      readConversationHistory: (metadata?: Record<string, unknown>) => (
        Array.isArray(metadata?.conversation_history) ? metadata!.conversation_history : []
      ),
      createRequest: (input: {
        demandId: string;
        source: DecisionSource;
        reasonCode: DecisionReasonCode;
        prompt: string;
        subgoalId?: string | null;
        executionId?: string | null;
      }) => decision({
        decision_id: "decision_from_service",
        demand_id: input.demandId,
        source: input.source,
        reason_code: input.reasonCode,
        prompt: input.prompt,
        subgoal_id: input.subgoalId ?? null,
        execution_id: input.executionId ?? null
      })
    },
    memoryManager: {
      createExecutionMemories: () => []
    },
    adapterRegistry: {
      getAdapter: (workerId: string) => adapters.get(workerId),
      bindExecution: (executionId: string, workerId: string) => {
        const adapter = adapters.get(workerId);
        if (!adapter) {
          throw new Error(`Missing adapter for worker ${workerId}`);
        }
        executionAdapters.set(executionId, adapter);
      },
      getExecutionAdapter: (executionId: string) => executionAdapters.get(executionId)
    },
    wsBroadcaster: {
      broadcastEvent: async () => undefined
    },
    opsMonitor: {},
    publish: async (publishedEvent: SchedulerEvent<unknown>) => {
      published.push(publishedEvent);
    }
  } as unknown as HandlerContext;

  const adapter = {
    startExecution: async (packet: any) => {
      startedPackets.push(packet);
    },
    stopExecution: async (executionId: string) => {
      stoppedExecutions.push(executionId);
    }
  };

  return {
    ctx,
    repositories,
    adapters,
    executionAdapters,
    adapter,
    startedPackets,
    stoppedExecutions,
    published
  };
}

test("createHandlers 会注册调度器事件处理器", () => {
  const handlers = createHandlers();
  const handled = [
    EventType.USER_INPUT_RECEIVED,
    EventType.DEMAND_CLARIFICATION_COMPLETED,
    EventType.REPLAN_REQUESTED,
    EventType.PLAN_GENERATED,
    EventType.SUBGOAL_CREATED,
    EventType.SUBGOAL_MARKED_READY,
    EventType.EXECUTION_CREATED,
    EventType.EXECUTION_DISPATCHED,
    EventType.WORKER_HEARTBEAT_RECEIVED,
    EventType.WORKER_RESULT_RECEIVED,
    EventType.VERIFICATION_COMPLETED,
    EventType.DECISION_REQUEST_CREATED,
    EventType.DECISION_RESPONSE_RECEIVED,
    EventType.DEMAND_PAUSED,
    EventType.DEMAND_RESUMED,
    EventType.DEMAND_CANCELLED,
    EventType.MISSION_COMPLETED,
    EventType.EXECUTION_STOP_REQUESTED,
    EventType.OPS_ALERT
  ];

  for (const eventType of handled) {
    assert.equal(typeof handlers[eventType], "function", `${eventType} should be registered`);
  }
});

test("状态机工具会更新状态时间并拒绝非法流转", () => {
  const baseDemand = demand();
  const nextDemand = transitionDemand(baseDemand, { state: DemandState.ACTIVE }, {
    waiting_on: "worker_result",
    progress_note: "Dispatched"
  });
  assert.equal(nextDemand.state, DemandState.ACTIVE);
  assert.equal((nextDemand.metadata?.runtime_session as any).waiting_on, "worker_result");
  assert.equal((nextDemand.metadata?.runtime_session as any).progress_note, "Dispatched");

  const nextSubgoal = transitionSubgoal(subgoal({ state: SubgoalState.READY }), { state: SubgoalState.DISPATCHED });
  assert.equal(nextSubgoal.state, SubgoalState.DISPATCHED);

  const nextExecution = transitionExecution(execution({ state: ExecutionState.RUNNING }), { state: ExecutionState.VERIFYING });
  assert.equal(nextExecution.state, ExecutionState.VERIFYING);

  assert.throws(
    () => assertTransition("demand", DemandState.COMPLETED, DemandState.READY, {
      [DemandState.COMPLETED]: [DemandState.COMPLETED]
    } as any),
    /Illegal demand transition/
  );
});

test("会话状态工具会保留并追加运行时元数据", () => {
  const metadata = patchRuntimeSession(undefined, {
    phase: DemandPhase.ALIGNMENT,
    waiting_on: "user_clarification",
    frontier_subgoal_ids: ["subgoal_1"],
    latest_checkpoint: "evt_1",
    progress_note: "Waiting"
  }, TS);

  assert.deepEqual((metadata.runtime_session as any).frontier_subgoal_ids, ["subgoal_1"]);
  assert.equal((metadata.runtime_session as any).last_progress_at, TS);

  const appended = appendConversationTurns(metadata, [
    { role: "user", content: "hello", created_at: TS },
    { role: "assistant", content: "hi", created_at: TS }
  ]);
  assert.equal(readConversationHistory(appended).length, 2);
});

test("计划进度只会在前置计划完成后解锁后续项", () => {
  const plannedDemand = demand({
    metadata: {
      latest_plan: {
        overall_plan_outline: [
          { plan_item_id: "plan_1", frontier_subgoal_ids: ["subgoal_1"] },
          { plan_item_id: "plan_2", frontier_subgoal_ids: ["subgoal_2"] }
        ]
      }
    }
  });
  const first = subgoal({ subgoal_id: "subgoal_1", state: SubgoalState.PLANNED });
  const second = subgoal({ subgoal_id: "subgoal_2", state: SubgoalState.PLANNED });

  assert.equal(isSubgoalUnlockedByPlan(plannedDemand, "subgoal_1", [first, second]), true);
  assert.equal(isSubgoalUnlockedByPlan(plannedDemand, "subgoal_2", [first, second]), false);

  const completedFirst = { ...first, state: SubgoalState.DONE };
  assert.deepEqual(collectUnlockedPlannedSubgoals(plannedDemand, [completedFirst, second]), ["subgoal_2"]);
});

test("执行运行时工具会查找活跃执行并同步 worker 槽位", async () => {
  const running = execution({ execution_id: "exec_running", state: ExecutionState.RUNNING });
  const done = execution({ execution_id: "exec_done", state: ExecutionState.DONE });
  const seededWorker = worker({
    current_execution_ids: ["exec_running", "exec_done"],
    status: WorkerRegistryStatus.BUSY
  });
  const { ctx, repositories } = createContext({
    executions: [running, done],
    workers: [seededWorker]
  });

  assert.equal(await demandHasActiveExecutions("demand_1", ctx), true);
  assert.deepEqual((await listActiveExecutionsForDemand("demand_1", ctx)).map((item) => item.execution_id), ["exec_running"]);

  await syncWorkerExecutionSlots("worker_1", ctx, "last error");
  const syncedWorker = await repositories.workers.getById("worker_1");
  assert.deepEqual(syncedWorker?.current_execution_ids, ["exec_running"]);
  assert.equal(syncedWorker?.status, WorkerRegistryStatus.BUSY);
  assert.equal(syncedWorker?.last_error, "last error");
});

test("onUserInput 会在仍需澄清时创建待对齐需求", async () => {
  const { ctx, repositories } = createContext();
  (ctx.planner as any).clarifyDemand = async () => ({
    status: "NEEDS_CLARIFICATION",
    display_title: "Needs info",
    clarification_question: "Which workspace?"
  });

  const result = await onUserInput(event(EventType.USER_INPUT_RECEIVED, {
    input_text: "Please fix tests",
    input_kind: "initial_demand"
  }, { demand_id: "demand_new" }), ctx);

  assert.deepEqual(result, {});
  const created = await repositories.demands.getById("demand_new");
  assert.equal(created?.state, DemandState.PENDING_ALIGNMENT);
  assert.equal(created?.metadata?.clarification_question, "Which workspace?");
  assert.equal(readConversationHistory(created?.metadata).length, 2);
});

test("onUserInput 会为已就绪的初始需求发出澄清完成事件", async () => {
  const { ctx, repositories } = createContext();

  const result = await onUserInput(event(EventType.USER_INPUT_RECEIVED, {
    input_text: "Please add tests",
    input_kind: "initial_demand"
  }, { demand_id: "demand_ready" }), ctx);

  const created = await repositories.demands.getById("demand_ready");
  assert.equal(created?.state, DemandState.PENDING_ALIGNMENT);
  assert.equal(result.events?.[0].event_type, EventType.DEMAND_CLARIFICATION_COMPLETED);
  assert.equal(result.events?.[0].demand_id, "demand_ready");
});

test("onClarificationCompleted 会保存澄清后的需求并请求规划", async () => {
  const seededDemand = demand({
    state: DemandState.PENDING_ALIGNMENT,
    current_phase: DemandPhase.ALIGNMENT,
    clarified_demand: null,
    operational_objective: null
  });
  const { ctx, repositories } = createContext({ demands: [seededDemand] });

  const result = await onClarificationCompleted(event(EventType.DEMAND_CLARIFICATION_COMPLETED, {
    clarified_demand: "Clarified",
    operational_objective: objective(),
    acceptance_criteria: ["Pass"],
    constraints: ["Small"],
    clarification_summary: "Ready"
  }, { demand_id: "demand_1" }), ctx);

  const updated = await repositories.demands.getById("demand_1");
  assert.equal(updated?.state, DemandState.READY);
  assert.equal(updated?.current_phase, DemandPhase.PLANNING);
  assert.equal(result.events?.[0].event_type, EventType.REPLAN_REQUESTED);
});

test("需求控制处理器会暂停、恢复、取消和完成需求", async () => {
  const activeDemand = demand({ state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION });
  const activeExecution = execution({ state: ExecutionState.RUNNING });
  const { ctx, repositories } = createContext({
    demands: [activeDemand],
    executions: [activeExecution]
  });

  const paused = await onDemandPaused(event(EventType.DEMAND_PAUSED, { action: "pause" }, { demand_id: "demand_1" }), ctx);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.PAUSED);
  assert.equal(paused.events?.[0].event_type, EventType.EXECUTION_STOP_REQUESTED);

  const resumed = await onDemandResumed(event(EventType.DEMAND_RESUMED, { action: "resume" }, { demand_id: "demand_1" }), ctx);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.READY);
  assert.equal(resumed.events?.[0].event_type, EventType.REPLAN_REQUESTED);

  await repositories.demands.upsert(demand({ state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION }));
  const cancelled = await onDemandCancelled(event(EventType.DEMAND_CANCELLED, { action: "cancel" }, { demand_id: "demand_1" }), ctx);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.CANCELLED);
  assert.equal(cancelled.events?.[0].event_type, EventType.EXECUTION_STOP_REQUESTED);

  await repositories.demands.upsert(demand({ demand_id: "demand_complete", state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION }));
  await onMissionCompleted(event(EventType.MISSION_COMPLETED, { summary: "done" }, { demand_id: "demand_complete" }), ctx);
  const completed = await repositories.demands.getById("demand_complete");
  assert.equal(completed?.state, DemandState.COMPLETED);
  assert.equal(completed?.progress_percent, 100);
});

test("规划处理器会生成计划、保存最新计划并解锁就绪子目标", async () => {
  const seededDemand = demand();
  const { ctx, repositories } = createContext({ demands: [seededDemand] });

  const replan = await onReplanRequested(event(EventType.REPLAN_REQUESTED, {
    reason: "initial_plan"
  }, { demand_id: "demand_1" }), ctx);
  assert.equal(replan.events?.[0].event_type, EventType.PLAN_GENERATED);
  assert.equal(replan.events?.[1].event_type, EventType.SUBGOAL_CREATED);

  await onPlanGenerated(replan.events![0], ctx);
  const withPlan = await repositories.demands.getById("demand_1");
  assert.ok(withPlan?.metadata?.latest_plan);

  const created = await onSubgoalCreated(replan.events![1], ctx);
  assert.equal((await repositories.subgoals.getById("planned_subgoal_1"))?.state, SubgoalState.PLANNED);
  assert.equal(created.events?.[0].event_type, EventType.SUBGOAL_MARKED_READY);
});

test("onSubgoalCreated 不会在前置项完成前解锁后续计划项", async () => {
  const lockedDemand = demand({
    metadata: {
      latest_plan: {
        overall_plan_outline: [
          { plan_item_id: "plan_1", frontier_subgoal_ids: ["subgoal_1"] },
          { plan_item_id: "plan_2", frontier_subgoal_ids: ["subgoal_2"] }
        ]
      }
    }
  });
  const first = subgoal({ subgoal_id: "subgoal_1", state: SubgoalState.PLANNED });
  const second = subgoal({ subgoal_id: "subgoal_2", state: SubgoalState.PLANNED });
  const { ctx } = createContext({ demands: [lockedDemand], subgoals: [first] });

  const result = await onSubgoalCreated(event(EventType.SUBGOAL_CREATED, {
    subgoal_contract: second,
    planning_round: 1,
    source: "planner"
  }, { demand_id: "demand_1", subgoal_id: "subgoal_2" }), ctx);

  assert.deepEqual(result, {});
});

test("onSubgoalMarkedReady 会在有可用 worker 时创建执行", async () => {
  const seededDemand = demand();
  const readyCandidate = subgoal({ state: SubgoalState.PLANNED });
  const seededWorker = worker();
  const { ctx } = createContext({
    demands: [seededDemand],
    subgoals: [readyCandidate],
    workers: [seededWorker]
  });

  const result = await onSubgoalMarkedReady(event(EventType.SUBGOAL_MARKED_READY, {
    dependency_check: { satisfied_dependencies: [], remaining_dependencies: [] }
  }, { demand_id: "demand_1", subgoal_id: "subgoal_1" }), ctx);

  assert.equal(result.events?.[0].event_type, EventType.EXECUTION_CREATED);
  assert.equal((result.events?.[0].payload as any).execution.execution_id, "exec_from_dispatch");
});

test("onSubgoalMarkedReady 会忽略已经派发的重复就绪事件", async () => {
  const seededDemand = demand({ state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION });
  const dispatchedSubgoal = subgoal({ state: SubgoalState.DISPATCHED });
  const seededWorker = worker();
  const { ctx, repositories } = createContext({
    demands: [seededDemand],
    subgoals: [dispatchedSubgoal],
    workers: [seededWorker]
  });

  const result = await onSubgoalMarkedReady(event(EventType.SUBGOAL_MARKED_READY, {
    dependency_check: { satisfied_dependencies: [], remaining_dependencies: [] }
  }, { demand_id: "demand_1", subgoal_id: "subgoal_1" }), ctx);

  assert.deepEqual(result, {});
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.DISPATCHED);
});

test("onSubgoalMarkedReady 会在无可用 worker 且需求空闲时请求决策", async () => {
  const { ctx } = createContext({
    demands: [demand()],
    subgoals: [subgoal({ state: SubgoalState.PLANNED })],
    workers: []
  });

  const result = await onSubgoalMarkedReady(event(EventType.SUBGOAL_MARKED_READY, {
    dependency_check: { satisfied_dependencies: [], remaining_dependencies: [] }
  }, { demand_id: "demand_1", subgoal_id: "subgoal_1" }), ctx);

  assert.equal(result.events?.[0].event_type, EventType.DECISION_REQUEST_CREATED);
  assert.equal((result.events?.[0].payload as any).decision_request.reason_code, DecisionReasonCode.BLOCKED);
});

test("执行处理器会持久化派发生命周期和 worker 输出", async () => {
  const seededDemand = demand();
  const seededSubgoal = subgoal({ state: SubgoalState.READY });
  const seededWorker = worker();
  const queuedExecution = execution({ state: ExecutionState.QUEUED });
  const { ctx, repositories, adapters, adapter, startedPackets } = createContext({
    demands: [seededDemand],
    subgoals: [seededSubgoal],
    workers: [seededWorker]
  });
  adapters.set("worker_1", adapter);

  const created = await onExecutionCreated(event(EventType.EXECUTION_CREATED, {
    execution: queuedExecution,
    dispatch_packet: { execution_id: "exec_1" }
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.QUEUED);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.ACTIVE);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.DISPATCHED);
  assert.deepEqual((await repositories.workers.getById("worker_1"))?.current_execution_ids, ["exec_1"]);
  assert.equal(created.events?.[0].event_type, EventType.EXECUTION_DISPATCHED);

  await onExecutionDispatched(created.events![0], ctx);
  assert.equal(startedPackets.length, 1);
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.RUNNING);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.EXECUTING);

  await onWorkerHeartbeat(event(EventType.WORKER_HEARTBEAT_RECEIVED, {
    heartbeat: {
      schema_version: "v1",
      worker_id: "worker_1",
      execution_id: "exec_1",
      status: WorkerExecutionStatus.RUNNING,
      source: "hook",
      emitted_at: "2026-01-01T00:01:00.000Z"
    }
  }, { execution_id: "exec_1" }), ctx);
  assert.equal((await repositories.executions.getById("exec_1"))?.last_heartbeat_at, "2026-01-01T00:01:00.000Z");

  const result = await onWorkerResult(event(EventType.WORKER_RESULT_RECEIVED, {
    worker_result: workerResult()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.VERIFYING);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.VERIFYING);
  assert.equal(result.events?.[0].event_type, EventType.VERIFICATION_COMPLETED);
});

test("onExecutionDispatched converts worker startup failures into worker result events", async () => {
  const seededDemand = demand({ state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION });
  const seededSubgoal = subgoal({ state: SubgoalState.DISPATCHED });
  const seededWorker = worker({
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: ["exec_1"]
  });
  const queuedExecution = execution({ state: ExecutionState.QUEUED });
  const { ctx, repositories, adapters } = createContext({
    demands: [seededDemand],
    subgoals: [seededSubgoal],
    workers: [seededWorker],
    executions: [queuedExecution]
  });
  adapters.set("worker_1", {
    startExecution: async () => {
      throw new Error("opencode executable not found");
    }
  });

  const result = await onExecutionDispatched(event(EventType.EXECUTION_DISPATCHED, {
    adapter_type: "opencode",
    runtime_type: "local_command",
    dispatch_started_at: TS
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.RUNNING);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.EXECUTING);
  assert.equal(result.events?.[0].event_type, EventType.WORKER_RESULT_RECEIVED);
  const workerFailure = (result.events?.[0].payload as any).worker_result as WorkerResult;
  assert.equal(workerFailure.worker_status, WorkerResultStatus.FAILED);
  assert.equal(workerFailure.blocker_reason?.code, "WORKER_START_FAILED");
  assert.match(workerFailure.blocker_reason?.message ?? "", /opencode executable not found/);
});

test("onWorkerResult accepts failed results arriving while execution is still queued", async () => {
  const queuedExecution = execution({ state: ExecutionState.QUEUED });
  const dispatchedSubgoal = subgoal({ state: SubgoalState.DISPATCHED });
  const { ctx, repositories } = createContext({
    executions: [queuedExecution],
    subgoals: [dispatchedSubgoal]
  });

  const result = await onWorkerResult(event(EventType.WORKER_RESULT_RECEIVED, {
    worker_result: workerResult({
      worker_status: WorkerResultStatus.FAILED,
      claimed_outcome: null,
      compressed_history: "worker crashed before running",
      produced_artifacts: [],
      blocker_reason: {
        code: "WORKER_RUNTIME_ERROR",
        message: "worker crashed before running"
      }
    })
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.VERIFYING);
  assert.equal((await repositories.executions.getById("exec_1"))?.result_status, WorkerResultStatus.FAILED);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.VERIFYING);
  assert.equal(result.events?.[0].event_type, EventType.VERIFICATION_COMPLETED);
});

test("onWorkerResult 会忽略取消后迟到的 worker 结果", async () => {
  const cancelledExecution = execution({ state: ExecutionState.CANCELLED });
  const cancelledSubgoal = subgoal({ state: SubgoalState.CANCELLED });
  const { ctx, repositories } = createContext({
    executions: [cancelledExecution],
    subgoals: [cancelledSubgoal]
  });

  const result = await onWorkerResult(event(EventType.WORKER_RESULT_RECEIVED, {
    worker_result: workerResult()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.deepEqual(result, {});
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.CANCELLED);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.CANCELLED);
});

test("onExecutionStopRequested 会中断活跃执行、更新子目标并释放 worker 槽位", async () => {
  const runningExecution = execution({ state: ExecutionState.RUNNING });
  const executingSubgoal = subgoal({ state: SubgoalState.EXECUTING });
  const busyWorker = worker({
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: ["exec_1"]
  });
  const { ctx, repositories, executionAdapters, adapter, stoppedExecutions } = createContext({
    executions: [runningExecution],
    subgoals: [executingSubgoal],
    workers: [busyWorker]
  });
  executionAdapters.set("exec_1", adapter);

  await onExecutionStopRequested(event(EventType.EXECUTION_STOP_REQUESTED, {
    reason: "pause"
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.deepEqual(stoppedExecutions, ["exec_1"]);
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.INTERRUPTED);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.BLOCKED);
  assert.equal((await repositories.workers.getById("worker_1"))?.status, WorkerRegistryStatus.IDLE);
});

test("评审处理器会归并已验证工作并解锁下一个顺序子目标", async () => {
  const plannedDemand = demand({
    state: DemandState.ACTIVE,
    current_phase: DemandPhase.EXECUTION,
    progress_percent: 40,
    metadata: {
      latest_plan: {
        overall_plan_outline: [
          { plan_item_id: "plan_1", frontier_subgoal_ids: ["subgoal_1"] },
          { plan_item_id: "plan_2", frontier_subgoal_ids: ["subgoal_2"] }
        ]
      }
    }
  });
  const verifyingSubgoal = subgoal({ subgoal_id: "subgoal_1", state: SubgoalState.VERIFYING });
  const plannedSubgoal = subgoal({ subgoal_id: "subgoal_2", state: SubgoalState.PLANNED });
  const verifyingExecution = execution({ state: ExecutionState.VERIFYING });
  const busyWorker = worker({
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: ["exec_1"]
  });
  const workerResultEvent = event(EventType.WORKER_RESULT_RECEIVED, {
    worker_result: workerResult()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  });
  const { ctx, repositories } = createContext({
    demands: [plannedDemand],
    subgoals: [verifyingSubgoal, plannedSubgoal],
    executions: [verifyingExecution],
    workers: [busyWorker],
    events: [workerResultEvent]
  });

  const result = await onVerificationCompleted(event(EventType.VERIFICATION_COMPLETED, {
    verification_result: verification()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.DONE);
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.DONE);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.ACTIVE);
  assert.equal((await repositories.demands.getById("demand_1"))?.current_phase, DemandPhase.EXECUTION);
  assert.equal((await repositories.workers.getById("worker_1"))?.status, WorkerRegistryStatus.IDLE);
  assert.deepEqual(result.events?.map((item) => item.event_type), [
    EventType.RECONCILIATION_COMPLETED,
    EventType.SUBGOAL_MARKED_READY
  ]);
});

test("评审处理器允许待决策需求里的活跃执行完成任务", async () => {
  const pendingDemand = demand({
    state: DemandState.PENDING_DECISION,
    current_phase: DemandPhase.REVIEW,
    active_decision_id: "decision_1",
    progress_percent: 80
  });
  const verifyingSubgoal = subgoal({ state: SubgoalState.VERIFYING });
  const verifyingExecution = execution({ state: ExecutionState.VERIFYING });
  const busyWorker = worker({
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: ["exec_1"]
  });
  const workerResultEvent = event(EventType.WORKER_RESULT_RECEIVED, {
    worker_result: workerResult()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  });
  const { ctx, repositories } = createContext({
    demands: [pendingDemand],
    subgoals: [verifyingSubgoal],
    executions: [verifyingExecution],
    workers: [busyWorker],
    decisions: [decision()],
    events: [workerResultEvent]
  });

  const result = await onVerificationCompleted(event(EventType.VERIFICATION_COMPLETED, {
    verification_result: verification()
  }, {
    demand_id: "demand_1",
    subgoal_id: "subgoal_1",
    execution_id: "exec_1",
    worker_id: "worker_1"
  }), ctx);

  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.COMPLETED);
  assert.equal((await repositories.subgoals.getById("subgoal_1"))?.state, SubgoalState.DONE);
  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.DONE);
  assert.equal((await repositories.workers.getById("worker_1"))?.status, WorkerRegistryStatus.IDLE);
  assert.deepEqual(result.events?.map((item) => item.event_type), [
    EventType.RECONCILIATION_COMPLETED,
    EventType.MISSION_COMPLETED
  ]);
});

test("决策处理器会保存请求并将可执行用户信息转为重新规划", async () => {
  const pendingDemand = demand({
    state: DemandState.PENDING_DECISION,
    current_phase: DemandPhase.REVIEW,
    active_decision_id: "decision_1"
  });
  const openDecision = decision();
  const { ctx, repositories } = createContext({
    demands: [pendingDemand],
    decisions: [openDecision]
  });

  await onDecisionRequestCreated(event(EventType.DECISION_REQUEST_CREATED, {
    decision_request: decision({ decision_id: "decision_new", reason_code: DecisionReasonCode.MISSING_INFO })
  }, {
    demand_id: "demand_1",
    decision_id: "decision_new"
  }), ctx);
  assert.equal((await repositories.decisions.getById("decision_new"))?.status, DecisionStatus.OPEN);
  assert.equal((await repositories.demands.getById("demand_1"))?.active_decision_id, "decision_new");

  await repositories.demands.upsert(pendingDemand);
  const result = await onDecisionResponseReceived(event(EventType.DECISION_RESPONSE_RECEIVED, {
    decision_response: {
      schema_version: "v1",
      decision_id: "decision_1",
      action: DecisionAction.PROVIDE_INFO,
      note: "retry with the same plan",
      responded_at: TS
    }
  }, {
    demand_id: "demand_1",
    decision_id: "decision_1"
  }), ctx);

  assert.equal((await repositories.decisions.getById("decision_1"))?.status, DecisionStatus.RESOLVED);
  assert.equal((await repositories.demands.getById("demand_1"))?.state, DemandState.READY);
  assert.equal(result.events?.[0].event_type, EventType.REPLAN_REQUESTED);
});

test("决策停止响应会发出停止执行和重新规划事件", async () => {
  const pendingDemand = demand({
    state: DemandState.PENDING_DECISION,
    current_phase: DemandPhase.REVIEW,
    active_decision_id: "decision_1"
  });
  const runningExecution = execution({ state: ExecutionState.RUNNING });
  const { ctx } = createContext({
    demands: [pendingDemand],
    decisions: [decision({ execution_id: "exec_1" })],
    executions: [runningExecution]
  });

  const result = await onDecisionResponseReceived(event(EventType.DECISION_RESPONSE_RECEIVED, {
    decision_response: {
      schema_version: "v1",
      decision_id: "decision_1",
      action: DecisionAction.STOP,
      note: "stop this branch",
      responded_at: TS
    }
  }, {
    demand_id: "demand_1",
    decision_id: "decision_1",
    execution_id: "exec_1",
    subgoal_id: "subgoal_1",
    worker_id: "worker_1"
  }), ctx);

  assert.deepEqual(result.events?.map((item) => item.event_type), [
    EventType.EXECUTION_STOP_REQUESTED,
    EventType.REPLAN_REQUESTED
  ]);
});

test("运维告警会将活跃执行标记为超时并请求用户决策", async () => {
  const { ctx, repositories } = createContext({
    demands: [demand({ state: DemandState.ACTIVE, current_phase: DemandPhase.EXECUTION })],
    executions: [execution({ state: ExecutionState.RUNNING })]
  });

  const result = await onOpsAlert(event(EventType.OPS_ALERT, {
    code: "timeout",
    message: "Execution timed out",
    severity: "warning"
  }, {
    demand_id: "demand_1",
    execution_id: "exec_1"
  }), ctx);

  assert.equal((await repositories.executions.getById("exec_1"))?.state, ExecutionState.TIMEOUT);
  assert.equal(result.events?.[0].event_type, EventType.DECISION_REQUEST_CREATED);
  assert.equal((result.events?.[0].payload as any).decision_request.reason_code, DecisionReasonCode.OPS_ALERT);
});
