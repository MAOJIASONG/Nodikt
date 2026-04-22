import {
  createEvent,
  createId,
  DecisionAction,
  DemandPhase,
  DemandState,
  EventType,
  ExecutionState,
  HandlerResult,
  SchedulerEvent,
  SubgoalState,
  WorkerRegistryStatus,
  nowIso
} from "../domain/index.js";
import { HandlerContext, HandlerMap } from "../event_bus/types.js";

const ACTIVE_EXECUTION_STATES = new Set([
  ExecutionState.QUEUED,
  ExecutionState.RUNNING,
  ExecutionState.VERIFYING
]);

type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type DecisionReplyIntent = "chat" | "retry" | "revise";

type PlanOutlineItem = {
  plan_item_id: string;
  frontier_subgoal_ids?: string[];
};

function readConversationHistory(metadata?: Record<string, unknown>): ConversationTurn[] {
  const raw = metadata?.conversation_history;
  return Array.isArray(raw) ? raw as ConversationTurn[] : [];
}

function appendConversationTurns(
  metadata: Record<string, unknown> | undefined,
  turns: ConversationTurn[]
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    conversation_history: [...readConversationHistory(metadata), ...turns]
  };
}

function classifyDecisionReplyIntent(note: string): DecisionReplyIntent {
  const normalized = note.toLowerCase();

  const retryPatterns = [
    "重试",
    "重新试",
    "再试一次",
    "重新跑",
    "再跑一次",
    "继续跑",
    "继续执行",
    "继续做",
    "继续干",
    "去干",
    "开始干",
    "开始做",
    "直接做",
    "重新开始",
    "重新来",
    "继续推进",
    "继续往下",
    "往下做",
    "往下推进",
    "继续处理",
    "处理一下",
    "replan",
    "re-plan",
    "plan again",
    "retry",
    "rerun",
    "run again",
    "try again"
  ];

  const revisePatterns = [
    "修改",
    "调整",
    "改一下",
    "改成",
    "改为",
    "换成",
    "按这个改",
    "按这个做",
    "照这个改",
    "照这个做",
    "按这个方案",
    "按这个方向",
    "优化",
    "不要",
    "把",
    "change ",
    "modify",
    "adjust",
    "revise"
  ];

  if (retryPatterns.some((item) => normalized.includes(item))) {
    return "retry";
  }

  if (revisePatterns.some((item) => normalized.includes(item))) {
    return "revise";
  }

  return "chat";
}

function appendExecutionGuidance(
  metadata: Record<string, unknown> | undefined,
  guidance: { source: string; note: string; created_at: string }
): Record<string, unknown> {
  const raw = metadata?.execution_guidance;
  const existing = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
  return {
    ...(metadata ?? {}),
    execution_guidance: [...existing, guidance]
  };
}

async function demandHasActiveExecutions(
  demandId: string,
  ctx: HandlerContext,
  excludeExecutionId?: string
): Promise<boolean> {
  const executions = await ctx.repositories.executions.list();
  return executions.some((execution) => (
    execution.demand_id === demandId
    && execution.execution_id !== excludeExecutionId
    && ACTIVE_EXECUTION_STATES.has(execution.state)
  ));
}

function readPlanOutline(demand: { metadata?: Record<string, unknown> | undefined }): PlanOutlineItem[] {
  const latestPlan = demand.metadata?.latest_plan as { overall_plan_outline?: PlanOutlineItem[] } | undefined;
  return Array.isArray(latestPlan?.overall_plan_outline) ? latestPlan!.overall_plan_outline : [];
}

function findPlanItemIndexBySubgoalId(
  planOutline: PlanOutlineItem[],
  subgoalId: string
): number {
  return planOutline.findIndex((item) => (
    Array.isArray(item.frontier_subgoal_ids) && item.frontier_subgoal_ids.includes(subgoalId)
  ));
}

function isSubgoalUnlockedByPlan(
  demand: { metadata?: Record<string, unknown> | undefined },
  subgoalId: string,
  subgoals: Array<{ subgoal_id: string; state: SubgoalState }>
): boolean {
  const planOutline = readPlanOutline(demand);
  const itemIndex = findPlanItemIndexBySubgoalId(planOutline, subgoalId);

  if (itemIndex <= 0) {
    return true;
  }

  for (const priorItem of planOutline.slice(0, itemIndex)) {
    const ids = Array.isArray(priorItem.frontier_subgoal_ids) ? priorItem.frontier_subgoal_ids : [];
    if (ids.length === 0) {
      continue;
    }

    const hasCompletedPriorSubgoal = ids.some((candidateId) => (
      subgoals.some((candidate) => candidate.subgoal_id === candidateId && candidate.state === SubgoalState.DONE)
    ));

    if (!hasCompletedPriorSubgoal) {
      return false;
    }
  }

  return true;
}

function collectUnlockedPlannedSubgoals(
  demand: { metadata?: Record<string, unknown> | undefined },
  subgoals: Array<{ subgoal_id: string; state: SubgoalState }>
): string[] {
  return subgoals
    .filter((item) => item.state === SubgoalState.PLANNED)
    .filter((item) => isSubgoalUnlockedByPlan(demand, item.subgoal_id, subgoals))
    .map((item) => item.subgoal_id);
}

async function syncWorkerExecutionSlots(
  workerId: string,
  ctx: HandlerContext,
  lastError?: string | null
): Promise<void> {
  const worker = await ctx.repositories.workers.getById(workerId);
  if (!worker) {
    return;
  }

  const executions = await ctx.repositories.executions.list();
  const activeExecutionIds = worker.current_execution_ids.filter((executionId) => {
    const execution = executions.find((item) => item.execution_id === executionId);
    return execution ? ACTIVE_EXECUTION_STATES.has(execution.state) : false;
  });

  await ctx.repositories.workers.upsert({
    ...worker,
    status: activeExecutionIds.length > 0 ? WorkerRegistryStatus.BUSY : WorkerRegistryStatus.IDLE,
    current_execution_ids: activeExecutionIds,
    last_error: lastError ?? worker.last_error,
    updated_at: nowIso()
  });
}

function extractWorkerError(workerResult: { blocker_reason?: { message?: string | null } | null; compressed_history?: string }): string | null {
  return workerResult.blocker_reason?.message ?? workerResult.compressed_history ?? null;
}

async function onUserInput(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { input_text: string; input_kind: string };
  if (payload.input_kind === "initial_demand") {
    const timestamp = nowIso();
    const demandId = event.demand_id ?? createId("demand");
    const settings = await ctx.repositories.loadSettings();
    const clarification = await ctx.planner.clarifyDemand({
      rawInput: payload.input_text,
      settings
    });
    await ctx.repositories.demands.upsert({
      demand_id: demandId,
      title: clarification.display_title?.slice(0, 60) || payload.input_text.slice(0, 80),
      type: "project",
      initial_input: payload.input_text,
      clarified_demand: null,
      operational_objective: null,
      state: DemandState.PENDING_ALIGNMENT,
      autonomy_level: settings.default_autonomy_level,
      acceptance_criteria: [],
      constraints: [],
      progress_percent: 0,
      current_phase: DemandPhase.ALIGNMENT,
      active_decision_id: null,
      tags: [],
      created_at: timestamp,
      updated_at: timestamp,
      metadata: clarification.status === "NEEDS_CLARIFICATION"
        ? {
            clarification_question: clarification.clarification_question,
            conversation_history: [
              { role: "user", content: payload.input_text, created_at: timestamp },
              {
                role: "assistant",
                content: clarification.clarification_question ?? "Please provide the missing project/workspace path and key constraints.",
                created_at: timestamp
              }
            ]
          }
        : {
            conversation_history: [
              { role: "user", content: payload.input_text, created_at: timestamp },
              {
                role: "assistant",
                content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
                created_at: timestamp
              }
            ]
          }
    });

    if (clarification.status === "NEEDS_CLARIFICATION") {
      return {};
    }

    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demandId }
        )
      ]
    };
  }

  if (payload.input_kind === "clarification_reply" && event.demand_id) {
    const demand = await ctx.repositories.demands.getById(event.demand_id);
    if (!demand) {
      return {};
    }
    const settings = await ctx.repositories.loadSettings();
    const timestamp = nowIso();
    const clarification = await ctx.planner.clarifyDemand({
      rawInput: [
        `Original demand: ${demand.initial_input}`,
        `Clarification conversation so far: ${JSON.stringify(readConversationHistory(demand.metadata))}`,
        demand.metadata?.clarification_question
          ? `Previous clarification question: ${String(demand.metadata.clarification_question)}`
          : "",
        `User clarification reply: ${payload.input_text}`
      ].filter(Boolean).join("\n"),
      settings
    });

    if (clarification.status === "NEEDS_CLARIFICATION") {
      await ctx.repositories.demands.upsert({
        ...demand,
        title: clarification.display_title?.slice(0, 60) || demand.title,
        metadata: {
          ...appendConversationTurns(demand.metadata, [
            { role: "user", content: payload.input_text, created_at: timestamp },
            {
              role: "assistant",
              content: clarification.clarification_question ?? "Please provide the remaining missing execution context.",
              created_at: timestamp
            }
          ]),
          clarification_question: clarification.clarification_question
        },
        updated_at: timestamp
      });
      return {};
    }

    await ctx.repositories.demands.upsert({
      ...demand,
      title: clarification.display_title?.slice(0, 60) || demand.title,
      metadata: {
        ...appendConversationTurns(demand.metadata, [
          { role: "user", content: payload.input_text, created_at: timestamp },
          {
            role: "assistant",
            content: clarification.clarification_summary ?? "Clarification is complete. Moving to planning.",
            created_at: timestamp
          }
        ]),
        clarification_question: null
      },
      updated_at: timestamp
    });

    return {
      events: [
        createEvent(
          EventType.DEMAND_CLARIFICATION_COMPLETED,
          {
            clarified_demand: clarification.clarified_demand!,
            operational_objective: clarification.operational_objective!,
            acceptance_criteria: clarification.operational_objective!.acceptance_criteria,
            constraints: clarification.operational_objective!.constraints,
            clarification_summary: clarification.clarification_summary!
          },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  return {};
}

async function onClarificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  const payload = event.payload as {
    clarified_demand: string;
    operational_objective: NonNullable<typeof demand.operational_objective>;
    acceptance_criteria: string[];
    constraints: string[];
  };

  await ctx.repositories.demands.upsert({
    ...demand,
    clarified_demand: payload.clarified_demand,
    operational_objective: payload.operational_objective,
    acceptance_criteria: payload.acceptance_criteria,
    constraints: payload.constraints,
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING,
    updated_at: nowIso(),
    metadata: {
      ...(demand.metadata ?? {}),
      clarification_question: null
    }
  });

  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "initial_plan" }, { demand_id: demand.demand_id })]
  };
}

async function onReplanRequested(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand || !demand.operational_objective) {
    return {};
  }

  const settings = await ctx.repositories.loadSettings();
  const planningRound = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id).length + 1;
  const plan = await ctx.planner.generateFrontierPlan(
    demand,
    (event.payload as { reason: "initial_plan" | "replan_after_result" | "replan_after_decision" | "resume" }).reason,
    planningRound,
    settings
  );
  return {
    events: [
      createEvent(EventType.PLAN_GENERATED, plan.payload, { demand_id: demand.demand_id }),
      ...plan.subgoals.map((subgoal) => createEvent(
        EventType.SUBGOAL_CREATED,
        { subgoal_contract: subgoal, planning_round: planningRound, source: "planner" },
        { demand_id: demand.demand_id, subgoal_id: subgoal.subgoal_id }
      ))
    ]
  };
}

async function onPlanGenerated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }

  await ctx.repositories.demands.upsert({
    ...demand,
    metadata: {
      ...(demand.metadata ?? {}),
      latest_plan: event.payload
    },
    updated_at: nowIso()
  });

  return {};
}

async function onSubgoalCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { subgoal_contract: any };
  await ctx.repositories.subgoals.upsert(payload.subgoal_contract);

  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }

  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === demand.demand_id);
  const shouldUnlock = isSubgoalUnlockedByPlan(demand, payload.subgoal_contract.subgoal_id, demandSubgoals);
  if (!shouldUnlock) {
    return {};
  }

  return {
    events: [
      createEvent(
        EventType.SUBGOAL_MARKED_READY,
        {
          dependency_check: {
            satisfied_dependencies: [],
            remaining_dependencies: []
          }
        },
        {
          demand_id: event.demand_id,
          subgoal_id: payload.subgoal_contract.subgoal_id
        }
      )
    ]
  };
}

async function onSubgoalMarkedReady(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const workers = await ctx.repositories.workers.list();
  const settings = await ctx.repositories.loadSettings();
  if (!demand || !subgoal) {
    return {};
  }

  await ctx.repositories.subgoals.upsert({
    ...subgoal,
    state: SubgoalState.READY,
    updated_at: nowIso()
  });

  const worker = ctx.dispatcher.selectWorker(workers, subgoal);
  if (!worker) {
    if (await demandHasActiveExecutions(demand.demand_id, ctx)) {
      return {};
    }
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "scheduler",
      reasonCode: "BLOCKED" as any,
      fallbackPrompt: "No available worker matched the frontier subgoal"
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "scheduler",
      reasonCode: "BLOCKED" as any,
      prompt,
      subgoalId: subgoal.subgoal_id
    });
    return {
      events: [
        createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
          demand_id: demand.demand_id,
          subgoal_id: subgoal.subgoal_id,
          decision_id: decision.decision_id
        })
      ]
    };
  }

  const execution = ctx.dispatcher.buildExecution({ demand, subgoal, worker });
  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal: { ...subgoal, state: SubgoalState.READY },
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds
  });

  return {
    events: [
      createEvent(EventType.EXECUTION_CREATED, { execution, dispatch_packet: packet }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: worker.worker_id
      })
    ]
  };
}

async function onExecutionCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { execution: any; dispatch_packet: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  if (!demand || !subgoal || !worker) {
    return {};
  }

  await ctx.repositories.executions.upsert(payload.execution);
  await ctx.repositories.demands.upsert({
    ...demand,
    state: DemandState.ACTIVE,
    current_phase: DemandPhase.EXECUTION,
    updated_at: nowIso()
  });
  await ctx.repositories.subgoals.upsert({
    ...subgoal,
    state: SubgoalState.DISPATCHED,
    updated_at: nowIso()
  });
  await ctx.repositories.workers.upsert({
    ...worker,
    status: WorkerRegistryStatus.BUSY,
    current_execution_ids: [...worker.current_execution_ids, payload.execution.execution_id],
    updated_at: nowIso()
  });

  return {
    events: [
      createEvent(
        EventType.EXECUTION_DISPATCHED,
        {
          adapter_type: worker.adapter_type,
          runtime_type: worker.runtime_type,
          dispatch_started_at: nowIso()
        },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
}

async function onExecutionDispatched(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const worker = await ctx.repositories.workers.getById(event.worker_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const settings = await ctx.repositories.loadSettings();
  if (!execution || !worker || !demand || !subgoal || !demand.operational_objective) {
    return {};
  }

  const adapter = ctx.adapterRegistry.getAdapter(worker.worker_id);
  if (!adapter) {
    return {};
  }

  const packet = ctx.dispatcher.buildPacket({
    demand,
    subgoal,
    execution,
    worker,
    workspaceRoot: settings.workspace_root,
    heartbeatSeconds: settings.runtime.heartbeat_interval_seconds,
    timeoutSeconds: settings.runtime.execution_timeout_seconds
  });

  ctx.adapterRegistry.bindExecution(execution.execution_id, worker.worker_id);
  await adapter.startExecution(packet);
  await ctx.repositories.executions.upsert({
    ...execution,
    state: ExecutionState.RUNNING,
    started_at: nowIso(),
    updated_at: nowIso()
  });
  await ctx.repositories.subgoals.upsert({
    ...subgoal,
    state: SubgoalState.EXECUTING,
    updated_at: nowIso()
  });
  return {};
}

async function onWorkerHeartbeat(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  if (!execution) {
    return {};
  }

  const payload = event.payload as { heartbeat: { emitted_at: string; status: any } };
  await ctx.repositories.executions.upsert({
    ...execution,
    last_heartbeat_at: payload.heartbeat.emitted_at,
    latest_worker_status: payload.heartbeat.status,
    updated_at: nowIso()
  });
  return {};
}

async function onWorkerResult(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  if (!execution || !subgoal) {
    return {};
  }
  const payload = event.payload as { worker_result: any };

  await ctx.repositories.executions.upsert({
    ...execution,
    state: ExecutionState.VERIFYING,
    result_status: payload.worker_result.worker_status,
    claimed_outcome: payload.worker_result.claimed_outcome ?? null,
    compressed_history: payload.worker_result.compressed_history,
    artifacts: payload.worker_result.produced_artifacts,
    adapter_meta: payload.worker_result.adapter_meta ?? {},
    updated_at: nowIso()
  });
  await ctx.repositories.subgoals.upsert({
    ...subgoal,
    state: SubgoalState.VERIFYING,
    updated_at: nowIso()
  });

  const verification = ctx.verifier.verify(subgoal.subgoal_id, payload.worker_result);
  return {
    events: [
      createEvent(
        EventType.VERIFICATION_COMPLETED,
        { verification_result: verification },
        {
          demand_id: event.demand_id,
          subgoal_id: event.subgoal_id,
          execution_id: event.execution_id,
          worker_id: event.worker_id
        }
      )
    ]
  };
}

async function onVerificationCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  const subgoal = await ctx.repositories.subgoals.getById(event.subgoal_id ?? "");
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demandSubgoals = (await ctx.repositories.subgoals.list()).filter((item) => item.demand_id === event.demand_id);
  const workerResultEvent = (await ctx.repositories.events.list())
    .filter((item) => item.execution_id === event.execution_id && item.event_type === EventType.WORKER_RESULT_RECEIVED)
    .slice(-1)[0];
  if (!demand || !subgoal || !execution || !workerResultEvent) {
    return {};
  }
  const workerResult = (workerResultEvent.payload as { worker_result: any }).worker_result;
  const verification = (event.payload as { verification_result: any }).verification_result;
  const outcome = ctx.reconciliation.reconcile({ demand, subgoal, execution, workerResult, verification });
  const projectedSubgoals = demandSubgoals.map((item) => item.subgoal_id === outcome.subgoal.subgoal_id ? outcome.subgoal : item);

  if (verification.verified_status === "VERIFIED_DONE") {
    const unfinishedStates = new Set([
      SubgoalState.PLANNED,
      SubgoalState.READY,
      SubgoalState.DISPATCHED,
      SubgoalState.EXECUTING,
      SubgoalState.VERIFYING
    ]);
    const hasOtherUnfinishedSubgoals = projectedSubgoals.some((item) => (
      item.subgoal_id !== outcome.subgoal.subgoal_id && unfinishedStates.has(item.state)
    ));

    const latestPlan = (demand.metadata?.latest_plan ?? null) as {
      overall_plan_outline?: Array<{ frontier_subgoal_ids?: string[] }>;
    } | null;

    const hasFuturePlanSteps = Array.isArray(latestPlan?.overall_plan_outline)
      ? latestPlan!.overall_plan_outline.some((item) => {
          const ids = Array.isArray(item.frontier_subgoal_ids) ? item.frontier_subgoal_ids : [];
          if (ids.length === 0) {
            return true;
          }
          return !ids.some((subgoalId) => projectedSubgoals.some((candidate) => candidate.subgoal_id === subgoalId && candidate.state === SubgoalState.DONE));
        })
      : false;

    if (hasOtherUnfinishedSubgoals) {
      outcome.demand.state = DemandState.ACTIVE;
      outcome.demand.current_phase = DemandPhase.EXECUTION;
      outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 70));
      outcome.missionCompleted = false;
      outcome.replanRequested = false;
    } else if (hasFuturePlanSteps) {
      outcome.demand.state = DemandState.ACTIVE;
      outcome.demand.current_phase = DemandPhase.PLANNING;
      outcome.demand.progress_percent = Math.min(95, Math.max(outcome.demand.progress_percent, 75));
      outcome.missionCompleted = false;
      outcome.replanRequested = true;
    }
  }

  await ctx.repositories.demands.upsert(outcome.demand);
  await ctx.repositories.subgoals.upsert(outcome.subgoal);
  await ctx.repositories.executions.upsert(outcome.execution);
  await syncWorkerExecutionSlots(
    execution.worker_id,
    ctx,
    verification.verified_status === "FAILED" || verification.verified_status === "UNVERIFIABLE"
      ? extractWorkerError(workerResult)
      : null
  );
  for (const memory of ctx.memoryManager.createExecutionMemories({
    demandId: demand.demand_id,
    workerResult,
    verification
  })) {
    await ctx.repositories.memory.upsert(memory);
  }

  const events: SchedulerEvent<unknown>[] = [
    createEvent(
      EventType.RECONCILIATION_COMPLETED,
      {
        verification_status: verification.verified_status,
        decision_id: null,
        mission_completed: outcome.missionCompleted,
        replan_requested: outcome.replanRequested
      },
      {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        worker_id: execution.worker_id
      }
    )
  ];

  if (verification.verified_status === "VERIFIED_DONE") {
    const unlockedSubgoalIds = collectUnlockedPlannedSubgoals(outcome.demand, projectedSubgoals);
    for (const unlockedSubgoalId of unlockedSubgoalIds) {
      events.push(
        createEvent(
          EventType.SUBGOAL_MARKED_READY,
          {
            dependency_check: {
              satisfied_dependencies: ["prior_plan_items_done"],
              remaining_dependencies: []
            }
          },
          {
            demand_id: demand.demand_id,
            subgoal_id: unlockedSubgoalId
          }
        )
      );
    }
  }

  if (outcome.decisionReasonCode && outcome.decisionPrompt) {
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
      reasonCode: outcome.decisionReasonCode,
      fallbackPrompt: outcome.decisionPrompt
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: verification.verified_status === "UNVERIFIABLE" ? "verifier" : "worker",
      reasonCode: outcome.decisionReasonCode,
      prompt,
      subgoalId: subgoal.subgoal_id,
      executionId: execution.execution_id
    });
    events.push(
      createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
        demand_id: demand.demand_id,
        subgoal_id: subgoal.subgoal_id,
        execution_id: execution.execution_id,
        decision_id: decision.decision_id
      })
    );
  } else if (outcome.replanRequested) {
    events.push(
      createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_result" }, { demand_id: demand.demand_id })
    );
  } else if (outcome.missionCompleted) {
    events.push(
      createEvent(EventType.MISSION_COMPLETED, { summary: "Mission completed after verified execution" }, { demand_id: demand.demand_id })
    );
  }

  return { events };
}

async function onDecisionRequestCreated(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_request: any };
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (demand) {
    await ctx.repositories.demands.upsert({
      ...demand,
      state: DemandState.PENDING_DECISION,
      current_phase: DemandPhase.REVIEW,
      active_decision_id: payload.decision_request.decision_id,
      updated_at: nowIso()
    });
  }
  await ctx.repositories.decisions.upsert(payload.decision_request);
  return {};
}

async function onDecisionResponseReceived(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const payload = event.payload as { decision_response: { action: DecisionAction; note?: string; payload?: Record<string, unknown> } };
  const decision = await ctx.repositories.decisions.getById(event.decision_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!decision || !demand) {
    return {};
  }
  const hasActiveExecutions = await demandHasActiveExecutions(demand.demand_id, ctx);

  if (payload.decision_response.action === DecisionAction.PROVIDE_INFO) {
    const note = payload.decision_response.note?.trim();
    if (!note) {
      return {};
    }
    const replyIntent = classifyDecisionReplyIntent(note);
    const settings = await ctx.repositories.loadSettings();
    const assistantReply = await ctx.decisionService.buildFollowUp({
      demand,
      settings,
      decision,
      userReply: note
    });
    const timestamp = nowIso();
    const updatedDecisionMetadata = ctx.decisionService.appendConversationTurns(decision.metadata, [
      { role: "user", content: note, created_at: timestamp },
      { role: "assistant", content: assistantReply, created_at: timestamp }
    ]);

    if (replyIntent === "chat" || hasActiveExecutions) {
      await ctx.repositories.decisions.upsert({
        ...decision,
        status: "OPEN" as any,
        resolved_at: null,
        metadata: updatedDecisionMetadata
      });

      await ctx.repositories.demands.upsert({
        ...demand,
        state: DemandState.PENDING_DECISION,
        current_phase: DemandPhase.REVIEW,
        active_decision_id: decision.decision_id,
        updated_at: timestamp
      });
      return {};
    }

    await ctx.repositories.decisions.upsert({
      ...decision,
      status: "RESOLVED" as any,
      resolved_at: timestamp,
      metadata: updatedDecisionMetadata
    });

    await ctx.repositories.demands.upsert({
      ...demand,
      state: DemandState.READY,
      current_phase: DemandPhase.PLANNING,
      active_decision_id: null,
      updated_at: timestamp,
      metadata: appendExecutionGuidance(demand.metadata, {
        source: replyIntent,
        note,
        created_at: timestamp
      })
    });

    return {
      events: [
        createEvent(
          EventType.REPLAN_REQUESTED,
          { reason: "replan_after_decision" },
          { demand_id: demand.demand_id }
        )
      ]
    };
  }

  await ctx.repositories.decisions.upsert({
    ...decision,
    status: "RESOLVED" as any,
    resolved_at: nowIso()
  });

  if (hasActiveExecutions) {
    const openDecisions = (await ctx.repositories.decisions.list()).filter((item) => (
      item.demand_id === demand.demand_id
      && item.status === "OPEN"
      && item.decision_id !== decision.decision_id
    ));

    await ctx.repositories.demands.upsert({
      ...demand,
      state: openDecisions.length > 0 ? DemandState.PENDING_DECISION : DemandState.ACTIVE,
      current_phase: openDecisions.length > 0 ? DemandPhase.REVIEW : DemandPhase.EXECUTION,
      active_decision_id: openDecisions[0]?.decision_id ?? null,
      updated_at: nowIso()
    });
  }

  if (payload.decision_response.action === DecisionAction.PAUSE) {
    return {
      events: [createEvent(EventType.DEMAND_PAUSED, { action: "pause", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (payload.decision_response.action === DecisionAction.CANCEL_DEMAND) {
    return {
      events: [createEvent(EventType.DEMAND_CANCELLED, { action: "cancel", note: payload.decision_response.note }, { demand_id: demand.demand_id })]
    };
  }

  if (hasActiveExecutions) {
    return {};
  }

  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "replan_after_decision" }, { demand_id: demand.demand_id })]
  };
}

async function onDemandPaused(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  await ctx.repositories.demands.upsert({
    ...demand,
    state: DemandState.PAUSED,
    updated_at: nowIso()
  });
  return {};
}

async function onDemandResumed(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  await ctx.repositories.demands.upsert({
    ...demand,
    state: DemandState.READY,
    current_phase: DemandPhase.PLANNING,
    updated_at: nowIso()
  });
  return {
    events: [createEvent(EventType.REPLAN_REQUESTED, { reason: "resume" }, { demand_id: demand.demand_id })]
  };
}

async function onDemandCancelled(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  await ctx.repositories.demands.upsert({
    ...demand,
    state: DemandState.CANCELLED,
    current_phase: DemandPhase.CANCELLED,
    updated_at: nowIso()
  });
  return {};
}

async function onMissionCompleted(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (!demand) {
    return {};
  }
  await ctx.repositories.demands.upsert({
    ...demand,
    state: DemandState.COMPLETED,
    current_phase: DemandPhase.COMPLETED,
    progress_percent: 100,
    updated_at: nowIso()
  });
  return {};
}

async function onOpsAlert(event: SchedulerEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const execution = await ctx.repositories.executions.getById(event.execution_id ?? "");
  const demand = await ctx.repositories.demands.getById(event.demand_id ?? "");
  if (execution) {
    await ctx.repositories.executions.upsert({
      ...execution,
      state: ExecutionState.TIMEOUT,
      updated_at: nowIso()
    });
  }
  if (demand) {
    const settings = await ctx.repositories.loadSettings();
    const prompt = await ctx.decisionService.buildPrompt({
      demand,
      settings,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      fallbackPrompt: (event.payload as { message: string }).message
    });
    const decision = ctx.decisionService.createRequest({
      demandId: demand.demand_id,
      source: "ops",
      reasonCode: "OPS_ALERT" as any,
      prompt,
      executionId: execution?.execution_id ?? null,
      subgoalId: execution?.subgoal_id ?? null
    });
    return {
      events: [
        createEvent(EventType.DECISION_REQUEST_CREATED, { decision_request: decision }, {
          demand_id: demand.demand_id,
          subgoal_id: execution?.subgoal_id ?? null,
          execution_id: execution?.execution_id ?? null,
          decision_id: decision.decision_id
        })
      ]
    };
  }
  return {};
}

export function createHandlers(): HandlerMap {
  return {
    [EventType.USER_INPUT_RECEIVED]: onUserInput,
    [EventType.DEMAND_CLARIFICATION_COMPLETED]: onClarificationCompleted,
    [EventType.REPLAN_REQUESTED]: onReplanRequested,
    [EventType.PLAN_GENERATED]: onPlanGenerated,
    [EventType.SUBGOAL_CREATED]: onSubgoalCreated,
    [EventType.SUBGOAL_MARKED_READY]: onSubgoalMarkedReady,
    [EventType.EXECUTION_CREATED]: onExecutionCreated,
    [EventType.EXECUTION_DISPATCHED]: onExecutionDispatched,
    [EventType.WORKER_HEARTBEAT_RECEIVED]: onWorkerHeartbeat,
    [EventType.WORKER_RESULT_RECEIVED]: onWorkerResult,
    [EventType.VERIFICATION_COMPLETED]: onVerificationCompleted,
    [EventType.DECISION_REQUEST_CREATED]: onDecisionRequestCreated,
    [EventType.DECISION_RESPONSE_RECEIVED]: onDecisionResponseReceived,
    [EventType.DEMAND_PAUSED]: onDemandPaused,
    [EventType.DEMAND_RESUMED]: onDemandResumed,
    [EventType.DEMAND_CANCELLED]: onDemandCancelled,
    [EventType.MISSION_COMPLETED]: onMissionCompleted,
    [EventType.OPS_ALERT]: onOpsAlert
  };
}
