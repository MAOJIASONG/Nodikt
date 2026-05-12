/**
 * 文件名称：service.ts
 * 文件作用：决策服务模块，负责在调度流程需要人工或模型判断时生成决策请求与决策响应。
 *
 * 主要职责：
 * 1. 根据上下文构造决策对话和模型输入。
 * 2. 调用 LLM 客户端生成下一步动作建议。
 * 3. 将模型输出整理为调度系统可消费的决策响应。
 *
 * 依赖模块：
 * - domain：决策请求、响应和动作类型。
 * - brain/engines/llm：模型调用客户端。
 *
 * 注意事项：
 * - 模型输出必须经过结构化约束，避免非预期文本直接驱动调度。
 * - 决策语义应与事件处理器中的动作分支保持一致。
 */
import {
  DecisionAction,
  DecisionReasonCode,
  DecisionRequest,
  Demand,
  DecisionSource,
  DecisionStatus,
  Settings,
  createId,
  nowIso
} from "../../../domain/index.js";
import { LlmClient } from "../llm/index.js";

type DecisionConversationTurn = {
  role: "assistant" | "user";
  content: string;
  created_at: string;
};

export class DecisionService {
  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 函数作用：为待处理决策生成面向用户的提示文本。
   *
   * 参数说明：
   * - input.demand：当前需求。
   * - input.settings：模型调用设置。
   * - input.reasonCode：触发决策的原因代码。
   * - input.source：决策来源。
   * - input.fallbackPrompt：模型不可用时使用的兜底提示。
   *
   * 返回值：
   * - Promise<string>：生成后的提示文本。
   */
  async buildPrompt(input: {
    demand: Demand;
    settings: Settings;
    reasonCode: DecisionReasonCode;
    source: DecisionSource;
    fallbackPrompt: string;
  }): Promise<string> {
    try {
      return await this.llmClient.generateText({
        settings: input.settings,
        role: input.source === "ops" ? "ops_backup" : "primary",
        temperature: 0.1,
        maxTokens: 2000,
        systemPrompt: [
          "你是 Nodikt v1 里的故障助手。",
          "请用中文回复用户。",
          "针对失败或阻塞的 subgoal，先用通俗语言解释当前卡点，再给出具体可执行的建议。",
          "不要逐行复读原始错误日志。",
          "建议要偏向“用户现在可以怎么做”以及“系统下一步适合怎么继续”。",
          "如有必要，最多提出两个有助于排障的短问题。",
          "不要改变原始 objective。",
          "语气直接、冷静、像工程排障助手。"
        ].join("\n"),
        userPrompt: [
          `Demand title: ${input.demand.title}`,
          `Demand objective: ${input.demand.operational_objective?.objective ?? input.demand.initial_input}`,
          `Reason code: ${input.reasonCode}`,
          `Source: ${input.source}`,
          `Context: ${input.fallbackPrompt}`
        ].join("\n")
      });
    } catch {
      return input.fallbackPrompt;
    }
  }

  /**
   * 函数作用：基于用户回复生成决策对话的后续回应。
   *
   * 参数说明：
   * - input.demand：当前需求。
   * - input.settings：模型调用设置。
   * - input.decision：当前打开的决策请求。
   * - input.userReply：用户最新回复内容。
   *
   * 返回值：
   * - Promise<string>：面向用户的后续回应文本。
   */
  async buildFollowUp(input: {
    demand: Demand;
    settings: Settings;
    decision: DecisionRequest;
    userReply: string;
  }): Promise<string> {
    const history = this.readConversationHistory(input.decision.metadata);
    try {
      return await this.llmClient.generateText({
        settings: input.settings,
        role: "primary",
        temperature: 0.2,
        maxTokens: 1200,
        systemPrompt: [
          "你是 Nodikt v1 的故障助手。",
          "请始终用中文继续这段关于失败或阻塞 subgoal 的对话。",
          "你的任务是帮助用户理解现状、判断下一步怎么做、以及还缺什么信息。",
          "不要机械复述日志，除非日志中的某个点对排障真的关键。",
          "优先给出实用建议；如果还缺信息，可以追问一个简短问题。",
          "除非用户提供的信息已经明显解除阻塞，否则不要假装问题已解决。"
        ].join("\n"),
        userPrompt: [
          `Demand title: ${input.demand.title}`,
          `Demand objective: ${input.demand.operational_objective?.objective ?? input.demand.initial_input}`,
          `Decision reason code: ${input.decision.reason_code}`,
          `Conversation so far: ${JSON.stringify(history)}`,
          `Latest user reply: ${input.userReply}`
        ].join("\n")
      });
    } catch {
      return "我收到了你的回复。现在还需要进一步确认缺失的信息，例如路径、权限、依赖状态，或者你希望采用的处理方式。你可以继续告诉我这些细节，我会基于当前失败原因给出更具体的建议。";
    }
  }

  /**
   * 函数作用：从决策元数据中读取历史对话。
   *
   * 参数说明：
   * - metadata：决策请求的元数据对象。
   *
   * 返回值：
   * - DecisionConversationTurn[]：历史对话轮次列表。
   */
  readConversationHistory(metadata?: Record<string, unknown>): DecisionConversationTurn[] {
    const raw = metadata?.conversation_history;
    return Array.isArray(raw) ? raw as DecisionConversationTurn[] : [];
  }

  /**
   * 函数作用：向决策元数据追加对话轮次。
   *
   * 参数说明：
   * - metadata：原始元数据。
   * - turns：需要追加的对话轮次。
   *
   * 返回值：
   * - Record<string, unknown>：带有更新后 conversation_history 的元数据。
   */
  appendConversationTurns(
    metadata: Record<string, unknown> | undefined,
    turns: DecisionConversationTurn[]
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      conversation_history: [...this.readConversationHistory(metadata), ...turns]
    };
  }

  /**
   * 函数作用：创建标准决策请求实体。
   *
   * 参数说明：
   * - input：包含需求 ID、提示文本、来源、原因、关联实体和候选动作。
   *
   * 返回值：
   * - DecisionRequest：初始化为 OPEN 状态的决策请求。
   */
  createRequest(input: {
    demandId: string;
    prompt: string;
    source: DecisionSource;
    reasonCode: DecisionReasonCode;
    subgoalId?: string | null;
    executionId?: string | null;
    options?: DecisionAction[];
    metadata?: Record<string, unknown>;
  }): DecisionRequest {
    const createdAt = nowIso();
    const metadata = this.appendConversationTurns(input.metadata, [
      {
        role: "assistant",
        content: input.prompt,
        created_at: createdAt
      }
    ]);

    return {
      schema_version: "v1",
      decision_id: createId("decision"),
      demand_id: input.demandId,
      subgoal_id: input.subgoalId ?? null,
      execution_id: input.executionId ?? null,
      source: input.source,
      reason_code: input.reasonCode,
      prompt: input.prompt,
      options: input.options ?? [
        DecisionAction.APPROVE,
        DecisionAction.REJECT,
        DecisionAction.PROVIDE_INFO,
        DecisionAction.PAUSE,
        DecisionAction.STOP,
        DecisionAction.CANCEL_DEMAND
      ],
      status: DecisionStatus.OPEN,
      created_at: createdAt,
      resolved_at: null,
      metadata
    };
  }
}
