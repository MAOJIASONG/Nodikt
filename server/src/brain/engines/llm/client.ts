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
   * 函数作用：按角色选择可用模型配置。
   *
   * 参数说明：
   * - settings：系统设置。
   * - role：模型角色，如 primary、planner、verifier 或 ops_backup。
   *
   * 返回值：
   * - ModelConfig：可用的模型配置。
   *
   * 注意事项：
   * - 指定角色禁用时会尝试回退到 primary，全部不可用时抛出错误。
   */
  getConfig(settings: Settings, role: "primary" | "planner" | "verifier" | "ops_backup"): ModelConfig {
    const preferred = settings.models[role];
    if (preferred.enabled) {
      return preferred;
    }
    if (settings.models.primary.enabled) {
      return settings.models.primary;
    }
    throw new LlmInvocationError(`LLM config for ${role} is disabled and primary fallback is also disabled`);
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

    if (provider.includes("anthropic") || config.model.toLowerCase().includes("claude")) {
      return this.callAnthropic(config, input.systemPrompt, input.userPrompt, input.temperature, input.maxTokens);
    }

    return this.callOpenAiCompatible(config, input.systemPrompt, input.userPrompt, input.temperature, input.maxTokens);
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
    if (!config.enabled) {
      throw new LlmInvocationError("Selected LLM config is disabled");
    }
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
    maxTokens = 4000
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
        }
      );
    } catch (error) {
      const message = String((error as Error).message ?? "");
      if (!/response_format|json_object|unsupported|invalid/i.test(message)) {
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
        }
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
    maxTokens = 4000
  ): Promise<string> {
    const response = await this.postJson(
      `${config.base_url.replace(/\/$/, "")}/messages`,
      {
        "x-api-key": config.api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      {
        model: config.model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature,
        max_tokens: maxTokens
      }
    );

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

  private async postJson(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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

  private extractJson(text: string): string {
    const trimmed = text.trim();
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
      return balanced.sort((left, right) => right.length - left.length)[0];
    }

    throw new LlmInvocationError("No JSON object found in LLM response");
  }

  private parseJsonResponse<T>(text: string): T {
    const directCandidates = [text.trim()].filter(Boolean);
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

    const balancedCandidates = this.findBalancedJsonCandidates(text);
    for (const candidate of balancedCandidates.sort((left, right) => right.length - left.length)) {
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
