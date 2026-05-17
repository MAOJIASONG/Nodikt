/**
 * 文件名称：claudeCodeAdapter.ts
 * 文件作用：Claude Code 适配器，封装 `claude -p --output-format stream-json` 子进程的协议解析与结果归一。
 *
 * 主要职责：
 * 1. 构造非交互式 Claude Code CLI 命令，注入工作空间与运行时 HOME。
 * 2. 增量解析 stream-json 事件（system/assistant/user/result），维护工具调用与会话状态。
 * 3. 把工具调用、提问意图、权限阻塞映射为 Nodikt 调度器可识别的 WorkerHeartbeat / WorkerResult。
 * 4. 通过 environment_notes 接收上一轮 session 续接信号（claude_session_resume=...）以支持多轮反馈循环。
 *
 * 依赖模块：
 * - worker/adapters/baseLocalCommandAdapter：复用子进程生命周期、cwd 创建、行缓冲。
 * - domain：WorkerDispatchPacket、WorkerHeartbeat、WorkerResult 等协议类型。
 *
 * 注意事项：
 * - Claude Code 在 headless 模式下没有 UI 询问通道；如需用户介入，应在 prompt 中要求模型以 `NEED_CLARIFICATION:` 前缀输出问题，由本适配器映射为 NEED_HELP。
 * - 权限策略默认采用 `bypassPermissions`，调度器侧通过 worker.config.env.CLAUDE_CODE_PERMISSION_MODE 覆盖。
 * - stream-json 顺序事件较多，频繁 poll 会触发大量解析；本适配器在 onStdoutLine 增量更新，pollStatus/collectResult 只读快照，避免重复扫描。
 */
import path from "path";

import {
  WorkerDispatchPacket,
  WorkerHeartbeat,
  WorkerRegistration,
  WorkerResult,
  WorkerResultStatus,
  createId,
  nowIso
} from "../../domain/index.js";
import { BaseLocalCommandAdapter } from "./baseLocalCommandAdapter.js";

const CLAUDE_CODE_INSTALL_ROOT =
  process.env.CLAUDE_CODE_INSTALL_ROOT ?? "";
const CLAUDE_CODE_RUNTIME_HOME =
  process.env.CLAUDE_CODE_RUNTIME_HOME
  || path.resolve(process.cwd(), ".claude-code-runtime");
const DEFAULT_PERMISSION_MODE =
  process.env.CLAUDE_CODE_PERMISSION_MODE
  || "bypassPermissions";
const NEED_CLARIFICATION_PREFIX = "NEED_CLARIFICATION:";

interface ToolUseTrace {
  id: string;
  name: string;
  inputPreview: string;
  startedAt: string;
  finishedAt?: string;
  resultPreview?: string;
  isError?: boolean;
  /**
   * 若该 tool_use 是结构化文件写入工具（Write / Edit / MultiEdit / NotebookEdit），
   * 这里记录目标绝对路径，便于 collectResult 精确生成 artifact，避免把所有产物都钉到 cwd 上
   * 导致 verifier 在 workspace 外的文件被误判为"没生成"。
   */
  filePath?: string;
}

// Claude Code 已知的结构化文件写入工具集合。Bash 间接写文件（cat > / tee 等）暂不在这里识别，
// 那条路径要靠"workspace_grants + 路径授权决策"来处理（P2 计划项），P0 先 cover 显式工具。
const STRUCTURED_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function extractWriteFilePath(toolName: string, input: unknown): string | undefined {
  if (!STRUCTURED_WRITE_TOOLS.has(toolName) || !input || typeof input !== "object") {
    return undefined;
  }
  const payload = input as Record<string, unknown>;
  const candidate = payload.file_path ?? payload.notebook_path ?? payload.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

interface AskUserSignal {
  source: "ask_user_tool" | "need_clarification_prefix" | "result_question";
  prompt: string;
  options?: Array<{ label: string; description?: string }>;
  raw?: unknown;
}

interface ParsedClaudeState {
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  allowedTools: string[];
  toolUses: ToolUseTrace[];
  toolUseById: Map<string, ToolUseTrace>;
  latestAssistantText: string | null;
  resultText: string | null;
  resultSubtype: string | null;
  numTurns: number | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  askSignals: AskUserSignal[];
  parseErrors: string[];
}

function createInitialState(): ParsedClaudeState {
  return {
    sessionId: null,
    model: null,
    cwd: null,
    allowedTools: [],
    toolUses: [],
    toolUseById: new Map(),
    latestAssistantText: null,
    resultText: null,
    resultSubtype: null,
    numTurns: null,
    totalCostUsd: null,
    durationMs: null,
    askSignals: [],
    parseErrors: []
  };
}

function summarize(value: unknown, maxLength = 240): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
}

/**
 * 函数作用：把 stream-json 解析出的工具轨迹组装成给 verifier / 决策模型阅读的紧凑历史。
 *
 * 参数说明：
 * - state：解析过程沉淀的 ParsedClaudeState。
 * - maxLength：总长度上限（默认 6000 字符，留给 verifier 上下文空间）。
 *
 * 返回值：
 * - string：每行一个事件的结构化历史。
 *
 * 注意事项：
 * - 头部包含 session id / model / turns / result subtype 元信息，便于 verifier 快速定位。
 * - 工具行格式为 `[i] Name(input_preview) ✓|✗: result_preview`，让 verifier 能确认到底写了哪些文件、跑了哪些命令。
 * - 末尾附最后一段助手文本或 result text，作为 worker 的总结陈述。
 * - 超过 maxLength 时从中段截断，保留头和尾。
 */
function buildStructuredHistory(state: ParsedClaudeState, maxLength = 6000): string {
  const lines: string[] = [];
  const header = [
    "[claude_code]",
    `session=${state.sessionId ?? "(none)"}`,
    state.model ? `model=${state.model}` : "",
    state.numTurns != null ? `num_turns=${state.numTurns}` : "",
    state.resultSubtype ? `result=${state.resultSubtype}` : "",
    state.totalCostUsd != null ? `cost_usd=${state.totalCostUsd.toFixed(4)}` : ""
  ].filter(Boolean).join(" ");
  lines.push(header);

  state.toolUses.forEach((trace, index) => {
    const status = !trace.finishedAt
      ? "…"
      : trace.isError
        ? "✗"
        : "✓";
    const resultFragment = trace.resultPreview ? `: ${trace.resultPreview}` : "";
    lines.push(`[${index + 1}] ${trace.name}(${trace.inputPreview}) ${status}${resultFragment}`);
  });

  if (state.askSignals.length > 0) {
    const last = state.askSignals[state.askSignals.length - 1];
    lines.push(`[ask_user] ${last.source}: ${summarize(last.prompt, 240)}`);
  }

  if (state.resultText) {
    lines.push(`[result_text] ${summarize(state.resultText, 600)}`);
  } else if (state.latestAssistantText) {
    lines.push(`[assistant_text] ${summarize(state.latestAssistantText, 600)}`);
  }

  let combined = lines.join("\n");
  if (combined.length <= maxLength) {
    return combined;
  }

  // 超长时保留头和尾，中间用省略号标记，方便 verifier 仍然看到末段总结。
  const headBudget = Math.floor(maxLength * 0.6);
  const tailBudget = maxLength - headBudget - 32;
  const head = combined.slice(0, headBudget);
  const tail = combined.slice(combined.length - tailBudget);
  return `${head}\n... [${combined.length - headBudget - tailBudget} chars truncated] ...\n${tail}`;
}

function detectInlineAsk(text: string): AskUserSignal | null {
  const trimmed = text.trim();
  if (trimmed.startsWith(NEED_CLARIFICATION_PREFIX)) {
    return {
      source: "need_clarification_prefix",
      prompt: trimmed.slice(NEED_CLARIFICATION_PREFIX.length).trim() || trimmed
    };
  }

  if (!trimmed.endsWith("?")) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  const hints = [
    "would you like",
    "should i",
    "do you want",
    "which option",
    "please confirm",
    "please clarify",
    "can you confirm",
    "could you clarify",
    "shall i",
    "is it ok",
    "is that ok"
  ];
  if (hints.some((hint) => lower.includes(hint))) {
    return { source: "result_question", prompt: trimmed };
  }
  return null;
}

function extractAskUserToolCall(toolName: string, input: unknown): AskUserSignal | null {
  if (typeof toolName !== "string") {
    return null;
  }
  const normalized = toolName.toLowerCase();
  const matchesAsk = normalized === "askuserquestion"
    || normalized === "ask_user_question"
    || normalized.includes("askuser")
    || normalized === "userinput"
    || normalized === "user_input";
  if (!matchesAsk) {
    return null;
  }

  const payload = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const firstQuestion = questions[0] as Record<string, unknown> | undefined;
  const prompt = typeof firstQuestion?.question === "string"
    ? firstQuestion.question
    : typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.question === "string"
        ? payload.question
        : "Claude Code requested user input";
  const rawOptions = firstQuestion && Array.isArray(firstQuestion.options) ? firstQuestion.options : [];
  const options = rawOptions
    .map((option) => (option && typeof option === "object") ? option as Record<string, unknown> : null)
    .filter((option): option is Record<string, unknown> => option !== null)
    .map((option) => ({
      label: typeof option.label === "string" ? option.label : "",
      description: typeof option.description === "string" ? option.description : undefined
    }))
    .filter((option) => option.label.length > 0);

  return {
    source: "ask_user_tool",
    prompt,
    options: options.length > 0 ? options : undefined,
    raw: input
  };
}

function readResumeSessionId(packet: WorkerDispatchPacket): string | null {
  const note = packet.context_slice.environment_notes.find((entry) => entry.startsWith("claude_session_resume="));
  if (!note) {
    return null;
  }
  const value = note.slice("claude_session_resume=".length).trim();
  return value.length > 0 ? value : null;
}

function readWorkspaceRoot(packet: WorkerDispatchPacket, worker: WorkerRegistration): string {
  const note = packet.context_slice.environment_notes.find((entry) => entry.startsWith("workspace_root="));
  return note ? note.slice("workspace_root=".length) : worker.config.workspace_root;
}

function readAllowedPaths(packet: WorkerDispatchPacket): string[] {
  const note = packet.context_slice.environment_notes.find((entry) => entry.startsWith("workspace_allowed_paths="));
  if (!note) return [];
  return note
    .slice("workspace_allowed_paths=".length)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
}

function buildPrompt(packet: WorkerDispatchPacket, workspaceRoot: string): string {
  const subgoal = packet.subgoal_contract;
  const successCriteria = subgoal.success_criteria.length > 0
    ? subgoal.success_criteria.map((item) => `- ${item}`).join("\n")
    : "- (none specified)";
  const constraints = subgoal.constraints.length > 0
    ? subgoal.constraints.map((item) => `- ${item}`).join("\n")
    : "- (none specified)";
  const hints = packet.context_slice.shared_hints.length > 0
    ? packet.context_slice.shared_hints.map((item) => `- ${item}`).join("\n")
    : "- (no prior lessons recorded)";

  const isRecon = subgoal.kind === "recon";
  const grantedPaths = readAllowedPaths(packet);
  // 主 workspace + 额外授权路径合集，给 worker 看清楚自己被允许写哪里。
  const allowedPathsBlock = grantedPaths.length === 0
    ? `- ${workspaceRoot || "(see env)"}  [primary workspace]`
    : [
        `- ${workspaceRoot || "(see env)"}  [primary workspace]`,
        ...grantedPaths
          .filter((p) => p !== workspaceRoot)
          .map((p) => `- ${p}  [granted]`)
      ].join("\n");

  // recon 与 build 用不同的交互协议：
  // recon —— 原则 + 禁止清单（任何 read-only 工具都允许：本地文件、Web、子任务调研、远程只读 API）；
  // build —— 直接产出文件 / 状态变更。
  const interactionProtocol = isRecon
    ? [
        `## Interaction protocol (RECONNAISSANCE — READ-ONLY)`,
        `- This is a RECONNAISSANCE subgoal. Your job is to **inspect / investigate and report findings**, not to change anything.`,
        ``,
        `### Principle`,
        `- You may use **any read-only / observational tool** available to you. Choose whichever fits this subgoal best.`,
        `  Examples of acceptable tools:`,
        `    * Local inspection: Read, Glob, Grep, Bash (read-only commands: ls, cat, head, find, git status, git log, git diff, etc.).`,
        `    * Web / documentation lookup: WebFetch (for known URLs), WebSearch (for discovery), HTTP GET via curl in read-only mode.`,
        `    * Delegated sub-investigation: Task (spawn a focused read-only sub-agent if the inspection is complex enough to warrant it).`,
        `    * Read-only third-party APIs (anything that does not write/mutate remote state).`,
        ``,
        `### Hard prohibitions`,
        `- File mutation tools: Write, Edit, MultiEdit, NotebookEdit — **never call these**.`,
        `- Filesystem-mutating Bash: touch, mkdir, mv, cp (with new destination), rm, sed -i, any output redirection (>, >>, tee), patch, etc.`,
        `- State-changing system actions: git commit / git push / git stash / git checkout (modifying), package installs (npm install, pip install, apt install, etc.), service restarts, docker run/build, kubectl apply, ...`,
        `- Side-effectful network calls: any HTTP POST / PUT / PATCH / DELETE; do not authenticate-and-write to remote services; do not send messages, create issues, post comments, etc.`,
        ``,
        `### Output rules`,
        `- Report findings as your final assistant text (Markdown / bullet list is fine). **Do not write findings into a file** — just print them as the assistant reply so the planner can consume them directly.`,
        `- If you cannot find the information after a reasonable inspection, say so in plain language; do not guess.`,
        `- If you cannot proceed because you need clarification from the human user, stop and reply with a single line starting with "${NEED_CLARIFICATION_PREFIX}" followed by the precise question.`
      ]
    : [
        `## Interaction protocol`,
        `- Use available tools (Read/Edit/Write/Bash) to complete the subgoal.`,
        `- **Write only inside the allowed paths listed above.** If the task requires writing somewhere else, do not improvise — stop and reply with "${NEED_CLARIFICATION_PREFIX} need write access to <path>" so the user can grant it explicitly.`,
        `- If you cannot proceed because you need information from the human user, do not guess. Stop and reply with a single line starting with "${NEED_CLARIFICATION_PREFIX}" followed by the precise question.`,
        `- When the task is done, briefly summarize what changed and stop.`
      ];

  return [
    `# Demand`,
    packet.clarified_demand,
    "",
    `# Subgoal: ${subgoal.title}${isRecon ? "  [RECON]" : ""}`,
    subgoal.objective,
    "",
    `## Success criteria`,
    successCriteria,
    "",
    `## Constraints`,
    constraints,
    "",
    `## Mission state`,
    packet.context_slice.mission_state_summary,
    "",
    `## Prior history`,
    packet.context_slice.relevant_history,
    "",
    `## Shared hints`,
    hints,
    "",
    `## Allowed write paths`,
    allowedPathsBlock,
    grantedPaths.length === 0
      ? "(No additional paths granted. Stay inside primary workspace.)"
      : "(Listed paths are explicitly authorized. Any other path is off-limits until the user grants access.)",
    "",
    ...interactionProtocol
  ].join("\n");
}

export class ClaudeCodeAdapter extends BaseLocalCommandAdapter {
  private readonly parsedByExecution = new Map<string, ParsedClaudeState>();

  protected resolveCommand(worker: WorkerRegistration, packet: WorkerDispatchPacket) {
    const workspaceRoot = readWorkspaceRoot(packet, worker);
    const prompt = buildPrompt(packet, workspaceRoot);
    const permissionMode = (worker.config.env?.CLAUDE_CODE_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE).trim() || DEFAULT_PERMISSION_MODE;
    const allowedToolsEnv = worker.config.env?.CLAUDE_CODE_ALLOWED_TOOLS;
    const disallowedToolsEnv = worker.config.env?.CLAUDE_CODE_DISALLOWED_TOOLS;
    const resumeSessionId = readResumeSessionId(packet);

    const claudeBinary = CLAUDE_CODE_INSTALL_ROOT.length > 0
      ? path.join(CLAUDE_CODE_INSTALL_ROOT, "bin", "claude")
      : "claude";

    const args: string[] = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      permissionMode
    ];
    if (allowedToolsEnv && allowedToolsEnv.trim().length > 0) {
      args.push("--allowedTools", allowedToolsEnv.trim());
    }
    if (disallowedToolsEnv && disallowedToolsEnv.trim().length > 0) {
      args.push("--disallowedTools", disallowedToolsEnv.trim());
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    // 初始化解析状态，便于后续 onStdoutLine 写入
    this.parsedByExecution.set(packet.execution_id, createInitialState());

    return {
      command: claudeBinary,
      args,
      env: {
        HOME: CLAUDE_CODE_RUNTIME_HOME,
        PATH: CLAUDE_CODE_INSTALL_ROOT.length > 0
          ? `${path.join(CLAUDE_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`
          : process.env.PATH ?? "",
        NODIKT_EXECUTION_ID: packet.execution_id,
        ...(worker.config.env ?? {})
      },
      cwd: workspaceRoot
    };
  }

  protected onStdoutLine(executionId: string, line: string): void {
    const state = this.parsedByExecution.get(executionId) ?? createInitialState();
    this.parsedByExecution.set(executionId, state);

    let message: any;
    try {
      message = JSON.parse(line);
    } catch (error) {
      state.parseErrors.push(`parse_error: ${(error as Error).message}`);
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const type = message.type as string | undefined;
    switch (type) {
      case "system":
        if (message.subtype === "init") {
          state.sessionId = typeof message.session_id === "string" ? message.session_id : state.sessionId;
          state.model = typeof message.model === "string" ? message.model : state.model;
          state.cwd = typeof message.cwd === "string" ? message.cwd : state.cwd;
          if (Array.isArray(message.tools)) {
            state.allowedTools = message.tools.filter((tool: unknown) => typeof tool === "string");
          }
        }
        break;

      case "assistant": {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            if (block.type === "text" && typeof block.text === "string") {
              state.latestAssistantText = block.text;
              const inlineAsk = detectInlineAsk(block.text);
              if (inlineAsk) {
                state.askSignals.push(inlineAsk);
              }
            } else if (block.type === "tool_use" && typeof block.id === "string") {
              const toolName = typeof block.name === "string" ? block.name : "unknown_tool";
              const trace: ToolUseTrace = {
                id: block.id,
                name: toolName,
                inputPreview: summarize(block.input ?? {}),
                startedAt: nowIso(),
                filePath: extractWriteFilePath(toolName, block.input)
              };
              state.toolUses.push(trace);
              state.toolUseById.set(trace.id, trace);
              const askSignal = extractAskUserToolCall(trace.name, block.input);
              if (askSignal) {
                state.askSignals.push(askSignal);
              }
            }
          }
        }
        break;
      }

      case "user": {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              const trace = state.toolUseById.get(block.tool_use_id);
              if (trace) {
                trace.finishedAt = nowIso();
                trace.resultPreview = summarize(block.content ?? "");
                trace.isError = Boolean(block.is_error);
              }
            }
          }
        }
        break;
      }

      case "result":
        state.resultSubtype = typeof message.subtype === "string" ? message.subtype : state.resultSubtype;
        state.resultText = typeof message.result === "string" ? message.result : state.resultText;
        state.numTurns = typeof message.num_turns === "number" ? message.num_turns : state.numTurns;
        state.totalCostUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : state.totalCostUsd;
        state.durationMs = typeof message.duration_ms === "number" ? message.duration_ms : state.durationMs;
        if (typeof message.session_id === "string" && !state.sessionId) {
          state.sessionId = message.session_id;
        }
        if (state.resultText) {
          const inlineAsk = detectInlineAsk(state.resultText);
          if (inlineAsk) {
            state.askSignals.push(inlineAsk);
          }
        }
        break;

      default:
        break;
    }
  }

  async pollStatus(executionId: string): Promise<WorkerHeartbeat | null> {
    const heartbeat = await super.pollStatus(executionId);
    if (!heartbeat) {
      return null;
    }
    const state = this.parsedByExecution.get(executionId);
    if (!state) {
      return heartbeat;
    }

    const latestTool = state.toolUses[state.toolUses.length - 1];
    const progressFragments: string[] = [];
    if (latestTool) {
      progressFragments.push(`tool ${latestTool.name}${latestTool.finishedAt ? " ✓" : "…"}`);
      if (latestTool.inputPreview) {
        progressFragments.push(latestTool.inputPreview);
      }
    }
    if (state.latestAssistantText) {
      progressFragments.push(summarize(state.latestAssistantText, 160));
    }

    return {
      ...heartbeat,
      progress_note: progressFragments.length > 0
        ? progressFragments.join(" | ")
        : heartbeat.progress_note,
      adapter_meta: {
        ...(heartbeat.adapter_meta ?? {}),
        claude_session_id: state.sessionId,
        claude_model: state.model,
        claude_tool_use_count: state.toolUses.length,
        claude_latest_tool: latestTool
          ? { name: latestTool.name, finished: Boolean(latestTool.finishedAt), is_error: Boolean(latestTool.isError) }
          : null,
        claude_ask_signal_count: state.askSignals.length
      }
    };
  }

  async collectResult(executionId: string): Promise<WorkerResult | null> {
    const baseResult = await super.collectResult(executionId);
    if (!baseResult) {
      return null;
    }

    const state = this.parsedByExecution.get(executionId);
    if (!state) {
      return baseResult;
    }

    const askSignal = state.askSignals[state.askSignals.length - 1] ?? null;
    let workerStatus = baseResult.worker_status;
    let blockerReason = baseResult.blocker_reason;
    let claimedOutcome = baseResult.claimed_outcome;
    let suggestedNextStep = baseResult.suggested_next_step;

    if (askSignal) {
      workerStatus = WorkerResultStatus.NEED_HELP;
      blockerReason = {
        code: askSignal.source === "ask_user_tool"
          ? "claude_code_ask_user_tool"
          : askSignal.source === "need_clarification_prefix"
            ? "claude_code_need_clarification"
            : "claude_code_question_in_result",
        message: askSignal.prompt
      };
      claimedOutcome = `Claude Code requested clarification: ${summarize(askSignal.prompt, 160)}`;
      suggestedNextStep = "Open the decision panel and reply with clarifying information; the next attempt will resume the same Claude session.";
    } else if (state.resultSubtype && state.resultSubtype !== "success") {
      workerStatus = state.resultSubtype === "error_max_turns"
        ? WorkerResultStatus.PARTIAL
        : WorkerResultStatus.FAILED;
      blockerReason = blockerReason ?? {
        code: `claude_code_${state.resultSubtype}`,
        message: state.resultText ?? `Claude Code finished with subtype ${state.resultSubtype}`
      };
    } else if (state.resultSubtype === "success") {
      // stream-json 说成功就以此为准；基类基于 stdout 启发式给的状态不要再压制 DONE。
      workerStatus = WorkerResultStatus.DONE;
      blockerReason = null;
      if (state.resultText) {
        claimedOutcome = summarize(state.resultText, 280);
      }
    }

    // 优先：从结构化 Write/Edit/MultiEdit/NotebookEdit 工具调用里直接抽 file_path，
    // 这样产物 uri 就是绝对路径，verifier 用 existsSync/statSync 能精确判断，
    // 哪怕文件被写到 settings.workspace_root 之外（如用户在 prompt 里指定的目标目录）。
    const writtenAbsolutePaths = Array.from(new Set(
      state.toolUses
        .filter((trace) => Boolean(trace.filePath) && !trace.isError && trace.finishedAt)
        .map((trace) => trace.filePath as string)
    ));

    let artifacts: WorkerResult["produced_artifacts"];
    if (baseResult.produced_artifacts.length > 0) {
      artifacts = baseResult.produced_artifacts;
    } else if (writtenAbsolutePaths.length > 0) {
      artifacts = writtenAbsolutePaths.map((filePath) => ({
        artifact_id: createId("artifact"),
        artifact_type: "file_bundle" as const,
        backend: "filesystem" as const,
        uri: filePath,
        metadata: { execution_id: executionId, source: "claude_code_write_tool" },
        created_at: nowIso()
      }));
    } else if (state.toolUses.some((trace) => ["Edit", "Write", "Bash"].includes(trace.name) && !trace.isError)) {
      // 兜底：用了 Bash 之类的非结构化工具（或工具调用没带 file_path 字段），
      // 没法精确定位，回到旧行为指向 cwd。verifier 仍会扫一遍这个目录。
      // 长期方向是 P2 阶段补 PATH_GRANT_REQUIRED 决策 + workspace_grants schema。
      artifacts = [{
        artifact_id: createId("artifact"),
        artifact_type: "file_bundle" as const,
        backend: "filesystem" as const,
        uri: state.cwd ?? "",
        metadata: { execution_id: executionId, source: "claude_code_tools_cwd_fallback" },
        created_at: nowIso()
      }];
    } else {
      artifacts = [];
    }

    const structuredHistory = buildStructuredHistory(state);

    return {
      ...baseResult,
      worker_status: workerStatus,
      claimed_outcome: claimedOutcome,
      blocker_reason: blockerReason,
      suggested_next_step: suggestedNextStep,
      produced_artifacts: artifacts,
      compressed_history: structuredHistory,
      adapter_meta: {
        ...(baseResult.adapter_meta ?? {}),
        claude_session_id: state.sessionId,
        claude_model: state.model,
        claude_result_subtype: state.resultSubtype,
        claude_num_turns: state.numTurns,
        claude_total_cost_usd: state.totalCostUsd,
        claude_duration_ms: state.durationMs,
        claude_tool_traces: state.toolUses.map((trace) => ({
          id: trace.id,
          name: trace.name,
          finished: Boolean(trace.finishedAt),
          is_error: Boolean(trace.isError),
          input_preview: trace.inputPreview,
          result_preview: trace.resultPreview ?? null
        })),
        claude_ask_signal: askSignal,
        claude_parse_errors: state.parseErrors.slice(-5)
      }
    };
  }

  protected onProcessClose(executionId: string, exitCode: number | null): void {
    void exitCode;
    // 维持解析状态，等 collectResult 调用后再清理；避免轮询/收集竞态丢失数据。
    void executionId;
  }

  /**
   * 函数作用：返回指定执行已捕获的 Claude Code 会话 ID。
   *
   * 参数说明：
   * - executionId：执行记录 ID。
   *
   * 返回值：
   * - string | null：若已观察到 system.init，则返回 session_id；否则 null。
   *
   * 注意事项：
   * - 供 reviewHandlers/dispatcher 在 retry 或决策续接时拼装 `--resume`。
   */
  getCapturedSessionId(executionId: string): string | null {
    return this.parsedByExecution.get(executionId)?.sessionId ?? null;
  }

  /**
   * 函数作用：判断指定执行是否产生了需要人工介入的信号。
   *
   * 参数说明：
   * - executionId：执行记录 ID。
   *
   * 返回值：
   * - boolean：true 表示有 ask_user / need_clarification / 提问式 result。
   */
  hasPendingAskSignal(executionId: string): boolean {
    return (this.parsedByExecution.get(executionId)?.askSignals.length ?? 0) > 0;
  }
}
