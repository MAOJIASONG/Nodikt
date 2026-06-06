/**
 * 文件名称：client.ts
 * 文件作用：LLM 客户端模块，负责封装兼容 OpenAI 协议的模型调用能力。
 *
 * 主要职责：
 * 1. 根据系统设置选择模型配置和 API Key。
 * 2. 发送聊天补全请求并解析模型响应。
 * 3. 将调用失败统一包装为 LlmInvocationError。
 *
 * 依赖模块：
 * - domain：模型配置和系统设置类型。
 *
 * 注意事项：
 * - 本模块位于外部模型调用边界，错误信息应便于上层降级和记录。
 * - 修改请求协议时，需要确认各模型供应商的兼容模式仍然可用。
 */
import { ModelConfig, Settings } from "../../../domain/index.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("llm");

export class LlmInvocationError extends Error {}

export class LlmClient {
  constructor(private readonly timeoutMs: number = 60000) {}

  /**
   * 函数作用：按角色选择模型配置。
   *
   * 参数说明：
   * - settings：系统设置。
   * - role：模型角色，如 primary、planner、verifier 或 ops_backup。
   *
   * 返回值：
   * - ModelConfig：对应角色的模型配置。
   */
  getConfig(settings: Settings, role: "primary" | "planner" | "verifier" | "ops_backup"): ModelConfig {
    return settings.models[role];
  }

  /**
   * 函数作用：调用模型生成文本响应。
   *
   * 参数说明：
   * - input：包含模型角色、系统提示、用户提示、温度和最大 token 数。
   *
   * 返回值：
   * - Promise<string>：模型返回的文本内容。
   */
  async generateText(input: {
    settings: Settings;
    role: "primary" | "planner" | "verifier" | "ops_backup";
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const config = this.getConfig(input.settings, input.role);
    this.validateConfig(config);
    const provider = config.provider.toLowerCase();
    // E-T1：每次调用从 settings.runtime.llm_timeout_seconds 读取超时，便于慢速国产模型在 UI 上调高；
    // 缺省/解析失败时回落到构造函数注入的 timeoutMs（保持向后兼容）。
    const timeoutMs = this.resolveTimeoutMs(input.settings);

    // 三种支持的 LLM 协议入口，按 provider 字段路由：
    //   - "anthropic" / "anthropic-messages" 或 model 含 "claude" → Anthropic Messages API (/v1/messages)
    //   - "openai-responses" / "responses" → OpenAI Responses API (/v1/responses)，推荐给 gpt-5 / o1 / o3 等 reasoning models
    //   - 其它（含 "openai" / "openai-compatible" / MiniMax / DeepSeek / Qwen / SiliconFlow 等兼容服务）→ OpenAI Chat Completions (/v1/chat/completions)
    if (provider.includes("anthropic") || config.model.toLowerCase().includes("claude")) {
      return this.callAnthropic(config, input.systemPrompt, input.userPrompt, input.temperature, input.maxTokens, timeoutMs);
    }

    if (provider.includes("responses") || provider === "openai-responses") {
      return this.callOpenAiResponses(config, input.systemPrompt, input.userPrompt, input.temperature, input.maxTokens, timeoutMs);
    }

    return this.callOpenAiCompatible(config, input.systemPrompt, input.userPrompt, input.temperature, input.maxTokens, timeoutMs);
  }

  /**
   * 函数作用：从设置中解析单次 LLM 调用的超时毫秒数。
   *
   * 参数说明：
   * - settings：系统设置；若缺失 runtime.llm_timeout_seconds 则回退到构造函数默认值。
   *
   * 返回值：
   * - number：本次调用使用的超时毫秒数（>=1000ms）。
   */
  private resolveTimeoutMs(settings: Settings | undefined): number {
    const seconds = settings?.runtime?.llm_timeout_seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      return Math.max(1, Math.floor(seconds)) * 1000;
    }
    return this.timeoutMs;
  }

  /**
   * 函数作用：调用模型并解析 JSON 响应。
   *
   * 参数说明：
   * - input：与 generateText 相同的模型调用参数。
   *
   * 返回值：
   * - Promise<T>：解析后的 JSON 对象。
   *
   * 注意事项：
   * - 模型返回非合法 JSON 时会抛出 LlmInvocationError。
   */
  async generateJson<T>(input: {
    settings: Settings;
    role: "primary" | "planner" | "verifier" | "ops_backup";
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<T> {
    const text = await this.generateText(input);
    try {
      return this.parseJsonResponse<T>(text);
    } catch (error) {
      throw new LlmInvocationError(`LLM response was not valid JSON: ${(error as Error).message}`);
    }
  }

  private validateConfig(config: ModelConfig): void {
    if (!config.base_url.trim()) {
      throw new LlmInvocationError("LLM base_url is empty");
    }
    if (!config.api_key.trim()) {
      throw new LlmInvocationError("LLM api_key is empty");
    }
    if (!config.model.trim()) {
      throw new LlmInvocationError("LLM model is empty");
    }
  }

  private async callOpenAiCompatible(
    config: ModelConfig,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.1,
    maxTokens = 4000,
    timeoutMs?: number
  ): Promise<string> {
    let response: any;
    try {
      response = await this.postJson(
        `${config.base_url.replace(/\/$/, "")}/chat/completions`,
        {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json"
        },
        {
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature,
          max_tokens: maxTokens,
          response_format: { type: "json_object" }
        },
        timeoutMs
      );
    } catch (error) {
      const message = String((error as Error).message ?? "");
      // 上游有时只回 422 / 400 + 空 body（不带"json_object"/"unsupported"等关键字），
      // 例如 uni-api.cstcloud.cn 的 gpt-oss 网关。这种情况也按"不支持 response_format"降级重试。
      if (!/response_format|json_object|unsupported|invalid|status (400|422)/i.test(message)) {
        throw error;
      }

      response = await this.postJson(
        `${config.base_url.replace(/\/$/, "")}/chat/completions`,
        {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json"
        },
        {
          model: config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature,
          max_tokens: maxTokens
        },
        timeoutMs
      );
    }

    const text = this.extractOpenAiMessageText(response?.choices?.[0]?.message?.content);
    if (!text.trim()) {
      throw new LlmInvocationError("OpenAI-compatible response returned empty content");
    }
    return text;
  }

  private async callAnthropic(
    config: ModelConfig,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.1,
    maxTokens = 4000,
    timeoutMs?: number
  ): Promise<string> {
    const url = `${config.base_url.replace(/\/$/, "")}/messages`;
    const headers = {
      "x-api-key": config.api_key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    };
    const baseBody: Record<string, unknown> = {
      model: config.model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: maxTokens
    };

    let response: any;
    try {
      response = await this.postJson(url, headers, { ...baseBody, temperature }, timeoutMs);
    } catch (error) {
      const message = String((error as Error).message ?? "");
      // 新一代 Claude（如 claude-opus-4-8）已弃用 temperature，上游会回
      // 400 "`temperature` is deprecated for this model."。这类"参数不被支持"
      // 的错误去掉 temperature 重试，与 callOpenAiCompatible / callOpenAiResponses 的降级策略一致。
      if (!/temperature|deprecated|unsupported/i.test(message)) {
        throw error;
      }
      response = await this.postJson(url, headers, baseBody, timeoutMs);
    }

    const parts = Array.isArray(response?.content)
      ? response.content
          .filter((item: unknown) => typeof item === "object" && item !== null && (item as { type?: string }).type === "text")
          .map((item: unknown) => String((item as { text?: string }).text ?? ""))
      : [];

    const text = parts.join("").trim();
    if (!text) {
      throw new LlmInvocationError("Anthropic response returned empty content");
    }
    return text;
  }

  /**
   * 调用 OpenAI Responses API (POST {base_url}/responses)。
   *
   * 这是 OpenAI 2024 推出的新协议，用于统一处理：
   *   - reasoning models（o1 / o3 / gpt-5）—— 它们不接受老的 temperature/max_tokens 老参数
   *   - 结构化输出（text.format）
   *   - tool calling / streaming（暂不在本实现范围内）
   *
   * 协议细节（跟 chat/completions 的差异）：
   *   - body 用 `input` 而不是 `messages`
   *   - body 用 `max_output_tokens` 而不是 `max_tokens`
   *   - JSON 强制约束放在 `text.format.type` 而不是 `response_format`
   *   - 响应里有便捷字段 `output_text`，没有就遍历 `output[].content[].text`
   *
   * 兼容降级：
   *   - 上游若不识别 `text.format`（部分自托管 reasoning 网关），自动 retry 不带格式约束
   *   - reasoning model 不接受 temperature 不是 1 / 不支持 system，这里仍传 system，依赖上游忽略或报错让 caller 处理
   */
  private async callOpenAiResponses(
    config: ModelConfig,
    systemPrompt: string,
    userPrompt: string,
    temperature = 0.1,
    maxTokens = 4000,
    timeoutMs?: number
  ): Promise<string> {
    const baseBody: Record<string, unknown> = {
      model: config.model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature,
      max_output_tokens: maxTokens
    };

    let response: any;
    try {
      response = await this.postJson(
        `${config.base_url.replace(/\/$/, "")}/responses`,
        {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json"
        },
        {
          ...baseBody,
          text: { format: { type: "json_object" } }
        },
        timeoutMs
      );
    } catch (error) {
      const message = String((error as Error).message ?? "");
      // 不支持 text.format / json_object 的网关：去掉格式约束重试。
      // 部分网关只回 422 / 400 + 空 body（不带关键字），同样按"不支持"处理。
      if (!/text\.format|json_object|unsupported|invalid|response_format|status (400|422)/i.test(message)) {
        throw error;
      }
      response = await this.postJson(
        `${config.base_url.replace(/\/$/, "")}/responses`,
        {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json"
        },
        baseBody,
        timeoutMs
      );
    }

    const text = this.extractResponsesText(response);
    if (!text.trim()) {
      throw new LlmInvocationError("OpenAI Responses API returned empty content");
    }
    return text;
  }

  /**
   * 从 Responses API 响应体里抽取最终文本。
   * 优先用便捷字段 `output_text`；没有就遍历 `output[].content[].text`（type === "output_text" 的块）。
   */
  private extractResponsesText(response: unknown): string {
    if (response && typeof response === "object") {
      const obj = response as Record<string, unknown>;
      if (typeof obj.output_text === "string" && obj.output_text.trim().length > 0) {
        return obj.output_text;
      }
      const output = obj.output;
      if (Array.isArray(output)) {
        const chunks: string[] = [];
        for (const item of output) {
          if (!item || typeof item !== "object") continue;
          const itemObj = item as Record<string, unknown>;
          if (itemObj.type !== "message") continue;
          const content = itemObj.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const blockObj = block as Record<string, unknown>;
            // 兼容 "output_text" 和老的 "text" 两种 type 命名
            if ((blockObj.type === "output_text" || blockObj.type === "text") && typeof blockObj.text === "string") {
              chunks.push(blockObj.text);
            }
          }
        }
        if (chunks.length > 0) {
          return chunks.join("");
        }
      }
    }
    return "";
  }

  private async postJson(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMsOverride?: number
  ): Promise<any> {
    const msgs = body.messages as Array<{ role: string; content: string }> | undefined;
    const sysTxt = typeof body.system === "string"
      ? body.system
      : (msgs?.find((m) => m.role === "system")?.content ?? "");
    const userTxt = msgs
      ?.filter((m) => m.role !== "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n") ?? "";

    logger.info({
      url,
      model: body.model,
      temperature: body.temperature,
      maxTokens: (body as Record<string, unknown>).max_tokens,
      systemLen: sysTxt.length,
      userLen: userTxt.length,
      systemPreview: sysTxt.replace(/\n+/g, " ").slice(0, 200),
      userPreview: userTxt.replace(/\n+/g, " ").slice(0, 300),
    }, "→ LLM 请求");

    const controller = new AbortController();
    const effectiveTimeoutMs = typeof timeoutMsOverride === "number" && Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
      ? timeoutMsOverride
      : this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    const startMs = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      const elapsed = `${((Date.now() - startMs) / 1000).toFixed(2)}s`;

      logger.info({
        url,
        status: response.status,
        elapsed,
        responseLen: text.length,
        responsePreview: text.replace(/\n+/g, " ").slice(0, 400),
      }, "← LLM 响应");

      if (!response.ok) {
        throw new LlmInvocationError(`LLM request failed with status ${response.status}: ${text.slice(0, 400)}`);
      }
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof LlmInvocationError) {
        throw error;
      }
      const elapsed = `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
      logger.error({ url, elapsed, err: error }, "← LLM 请求失败");
      throw new LlmInvocationError(`LLM request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 剥掉模型在最终答案前夹的"思考链"标签段（含内容）。
   *
   * 涵盖：<think>…</think> / <thinking>…</thinking> / <reasoning>…</reasoning> / <reflection>…</reflection>
   * 这些都是 thinking-style 模型（MiniMax M2.5、DeepSeek R1、QwQ 等）会主动产出的标签。
   * 思考块内部经常出现示例 JSON / 伪代码 / 大括号，对 JSON 提取干扰极大；先剥掉再做提取最稳。
   *
   * 注意：用非贪婪 + 多标签，且 case-insensitive。未闭合的 <think> 也吞掉（有些模型截断在思考中间）。
   */
  private stripThinkingTags(text: string): string {
    let cleaned = text;
    // 1) 配对完整的 <think>…</think>（及别名）
    cleaned = cleaned.replace(/<\s*(think|thinking|reasoning|reflection)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
    // 2) 未闭合的 <think> 标签（截断 / 流式没收尾）：从开标签一直吞到字符串末尾
    cleaned = cleaned.replace(/<\s*(think|thinking|reasoning|reflection)\s*>[\s\S]*$/i, "");
    return cleaned;
  }

  private extractJson(text: string): string {
    const cleaned = this.stripThinkingTags(text);
    const trimmed = cleaned.trim();
    if (!trimmed) {
      throw new LlmInvocationError("LLM response was empty");
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]?.trim()) {
      return fencedMatch[1].trim();
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return trimmed;
    }

    const balanced = this.findBalancedJsonCandidates(trimmed);
    if (balanced.length > 0) {
      // 优先取最后一个 —— thinking models 通常把最终答案放在末尾；之前用"最长的"会错选中间的示例 JSON。
      return balanced[balanced.length - 1];
    }

    throw new LlmInvocationError("No JSON object found in LLM response");
  }

  private parseJsonResponse<T>(text: string): T {
    // 整段文本（剥过 think 标签后）先尝试直接 JSON.parse，再尝试 extractJson 的输出。
    const cleaned = this.stripThinkingTags(text);
    const directCandidates = [cleaned.trim(), text.trim()].filter(Boolean);
    try {
      directCandidates.push(this.extractJson(text).trim());
    } catch {
      // Fall through to balanced extraction below.
    }

    for (const candidate of directCandidates) {
      const parsed = this.tryParseJson(candidate);
      if (parsed !== undefined) {
        return parsed as T;
      }
    }

    // 平衡候选最后兜底 —— 只在剥过 think 后的文本里找，"取最后一个"（thinking 模型答案在末尾）。
    // 不回到含 think 标签的原文找，否则会误把思考链里的伪 JSON / 截断片段当成答案；
    // 真截断时让 caller（如 clarifier）走自己的降级路径。
    const cleanedCandidates = this.findBalancedJsonCandidates(cleaned);
    for (const candidate of [...cleanedCandidates].reverse()) {
      const parsed = this.tryParseJson(candidate);
      if (parsed !== undefined) {
        return parsed as T;
      }
    }

    throw new LlmInvocationError("No JSON object found in LLM response");
  }

  private tryParseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  private findBalancedJsonCandidates(text: string): string[] {
    const candidates: string[] = [];
    const stack: Array<"{" | "["> = [];
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        if (stack.length === 0) {
          startIndex = index;
        }
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        if (stack.length === 0) {
          continue;
        }

        const last = stack[stack.length - 1];
        if ((last === "{" && char !== "}") || (last === "[" && char !== "]")) {
          continue;
        }

        stack.pop();
        if (stack.length === 0 && startIndex >= 0) {
          candidates.push(text.slice(startIndex, index + 1).trim());
          startIndex = -1;
        }
      }
    }

    return Array.from(new Set(candidates));
  }

  private extractOpenAiMessageText(content: unknown): string {
    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const typed = item as { type?: string; text?: string };
        if (typed.type === "text" && typeof typed.text === "string") {
          return typed.text;
        }
        return "";
      })
      .join("")
      .trim();
  }
}
