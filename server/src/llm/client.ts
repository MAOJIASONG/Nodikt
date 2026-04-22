import { ModelConfig, Settings } from "../domain/index.js";

export class LlmInvocationError extends Error {}

export class LlmClient {
  constructor(private readonly timeoutMs: number = 45000) {}

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        throw new LlmInvocationError(`LLM request failed with status ${response.status}: ${text.slice(0, 400)}`);
      }
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof LlmInvocationError) {
        throw error;
      }
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
