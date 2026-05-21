import { existsSync, readdirSync, statSync } from "fs";

import { LlmClient } from "../../engines/llm/client.js";
import {
  ArtifactRef,
  Settings,
  SubgoalContract,
  VerificationResult,
  VerificationStatus,
  WorkerResult,
  nowIso
} from "../../../domain/index.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("verifier");

interface CriterionVerdict {
  criterion: string;
  verdict: "satisfied" | "unsatisfied" | "unverifiable";
  evidence: string;
}

interface LlmVerificationOutput {
  criteria_verdicts: CriterionVerdict[];
  outcome_consistent: boolean;
  outcome_inconsistency_notes: string;
}

export class VerifierService {
  constructor(private readonly llmClient: LlmClient) {}

  private hasMaterializedArtifact(uri: string): boolean {
    if (!existsSync(uri)) {
      return false;
    }

    const stats = statSync(uri);
    if (stats.isFile()) {
      return true;
    }

    if (!stats.isDirectory()) {
      return false;
    }

    const entries = readdirSync(uri, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
    if (entries.length === 0) {
      return false;
    }

    return entries.some((entry) => {
      const nextPath = `${uri}/${entry.name}`;
      if (entry.isFile()) {
        return true;
      }
      if (entry.isDirectory()) {
        return this.hasMaterializedArtifact(nextPath);
      }
      return false;
    });
  }

  async verify(
    subgoalId: string,
    subgoal: SubgoalContract,
    workerResult: WorkerResult,
    settings: Settings
  ): Promise<VerificationResult> {
    const declaredCount = workerResult.produced_artifacts.length;
    const acceptedArtifacts = workerResult.produced_artifacts.filter(
      (artifact) => this.hasMaterializedArtifact(artifact.uri)
    );
    logger.info(
      { subgoalId, executionId: workerResult.execution_id, workerStatus: workerResult.worker_status, declaredArtifacts: declaredCount, acceptedArtifacts: acceptedArtifacts.length },
      "开始验证工作器结果"
    );
    if (declaredCount > 0) {
      const rejected = workerResult.produced_artifacts.filter((a) => !acceptedArtifacts.includes(a));
      for (const a of rejected) {
        logger.warn({ subgoalId, uri: a.uri }, "产物路径不存在或为空目录，已拒绝");
      }
    }

    if (workerResult.worker_status === "NEED_HELP" || workerResult.worker_status === "BLOCKED") {
      logger.info({ subgoalId, executionId: workerResult.execution_id, workerStatus: workerResult.worker_status }, "工作器阻塞，跳过 LLM 验证，直接标记为 UNVERIFIABLE");
      return {
        schema_version: "v1",
        execution_id: workerResult.execution_id,
        subgoal_id: subgoalId,
        verified_status: VerificationStatus.UNVERIFIABLE,
        accepted_artifacts: [],
        gap: subgoal.success_criteria,
        notes: workerResult.blocker_reason?.message ?? "Worker needs manual intervention",
        verified_at: nowIso()
      };
    }

    if (workerResult.worker_status === "FAILED") {
      logger.info({ subgoalId, executionId: workerResult.execution_id }, "工作器报告失败，跳过 LLM 验证，直接标记为 FAILED");
      return {
        schema_version: "v1",
        execution_id: workerResult.execution_id,
        subgoal_id: subgoalId,
        verified_status: VerificationStatus.FAILED,
        accepted_artifacts: [],
        gap: subgoal.success_criteria,
        notes: workerResult.blocker_reason?.message ?? "Worker reported failure",
        verified_at: nowIso()
      };
    }

    // recon 子目标走专用验证：它没有文件 artifact（产物是发现文本）
    if (subgoal.kind === "recon") {
      logger.info({ subgoalId, executionId: workerResult.execution_id, criteriaCount: subgoal.success_criteria.length }, "调用 LLM 验证 recon 发现");
      try {
        const llmResult = await this.runReconLlmVerification(subgoal, workerResult, settings);
        const result = this.buildReconResultFromLlm(subgoalId, workerResult, llmResult);
        logger.info(
          { subgoalId, executionId: workerResult.execution_id, verifiedStatus: result.verified_status, gap: result.gap, outcomeConsistent: llmResult.outcome_consistent },
          "Recon LLM 验证完成"
        );
        return result;
      } catch (error) {
        const traceLen = (workerResult.compressed_history?.trim().length ?? 0);
        const hasFindings = traceLen > 50;
        logger.warn({ subgoalId, executionId: workerResult.execution_id, err: error, hasFindings, traceLen }, "Recon LLM 验证失败，降级判定");
        return {
          schema_version: "v1",
          execution_id: workerResult.execution_id,
          subgoal_id: subgoalId,
          verified_status: hasFindings ? VerificationStatus.VERIFIED_DONE : VerificationStatus.UNVERIFIABLE,
          accepted_artifacts: [],
          gap: hasFindings ? [] : subgoal.success_criteria,
          notes: hasFindings
            ? `[LLM verifier unavailable] Worker reported DONE with non-empty findings (${traceLen} chars); accepted as recon VERIFIED_DONE`
            : `[LLM verifier unavailable] Recon worker did not return enough findings to verify`,
          verified_at: nowIso()
        };
      }
    }

    // DONE or PARTIAL: run LLM verification (build kind)
    logger.info({ subgoalId, executionId: workerResult.execution_id, criteriaCount: subgoal.success_criteria.length }, "调用 LLM 验证 success criteria 与 claimed outcome");
    try {
      const llmResult = await this.runLlmVerification(subgoal, workerResult, acceptedArtifacts, settings);
      const result = this.buildResultFromLlm(subgoalId, workerResult, acceptedArtifacts, llmResult);
      logger.info(
        { subgoalId, executionId: workerResult.execution_id, verifiedStatus: result.verified_status, gap: result.gap, outcomeConsistent: llmResult.outcome_consistent },
        "LLM 验证完成"
      );
      return result;
    } catch (error) {
      logger.warn({ subgoalId, executionId: workerResult.execution_id, err: error }, "LLM 验证调用失败，降级为产物存在性检查");
      const errorNote = `[LLM verification unavailable: ${error instanceof Error ? error.message : String(error)}]`;
      const result = this.buildArtifactOnlyResult(subgoalId, subgoal, workerResult, acceptedArtifacts, errorNote);
      logger.info({ subgoalId, executionId: workerResult.execution_id, verifiedStatus: result.verified_status }, "降级验证完成");
      return result;
    }
  }

  /**
   * 函数作用：对 recon 子目标做专用 LLM 验证。
   * recon 没有文件 artifact，verifier 只看发现是不是回答了 success_criteria 里的问题。
   */
  private async runReconLlmVerification(
    subgoal: SubgoalContract,
    workerResult: WorkerResult,
    settings: Settings
  ): Promise<LlmVerificationOutput> {
    const systemPrompt = [
      "You are an independent verifier of RECONNAISSANCE (read-only investigation) subgoals.",
      "A recon worker has no file artifacts to verify — its product is the FINDINGS reported in the execution trace and the claimed_outcome.",
      "Your job: judge whether the worker's findings actually answered each success criterion.",
      "Be lenient on form (free text / bullet list / inline data are all fine) but strict on substance — did the answer cover the question?",
      "If the trace shows only attempted lookups but no concrete answer, mark unsatisfied (or unverifiable if you genuinely can't tell).",
      "Output valid JSON only."
    ].join("\n");

    const userPrompt = [
      "## Recon Success Criteria (questions the worker was asked to answer)",
      subgoal.success_criteria.length > 0
        ? subgoal.success_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : "(no explicit criteria — judge whether the worker delivered useful findings for the subgoal objective)",
      "",
      "## Subgoal Objective (context)",
      subgoal.objective,
      "",
      "## Worker Final Summary (claimed_outcome)",
      workerResult.claimed_outcome ?? "(not provided)",
      "",
      "## Worker Execution Trace (tool calls + findings, structured)",
      workerResult.compressed_history || "(not provided)",
      "",
      "For each success criterion output a verdict:",
      '  "satisfied"    — the findings clearly answer this question',
      '  "unsatisfied"  — the findings did not address this, or contradict reality',
      '  "unverifiable" — cannot tell from the trace whether it was answered',
      "",
      "Also assess whether claimed_outcome is faithful to the execution trace (no fabricated facts).",
      "",
      "Output exactly this JSON shape:",
      '{"criteria_verdicts":[{"criterion":"...","verdict":"satisfied|unsatisfied|unverifiable","evidence":"..."}],"outcome_consistent":true,"outcome_inconsistency_notes":"..."}'
    ].join("\n");

    logger.debug({ subgoalId: subgoal.subgoal_id, criteriaCount: subgoal.success_criteria.length }, "发送 Recon LLM 验证请求");
    return this.llmClient.generateJson<LlmVerificationOutput>({
      settings,
      role: "verifier",
      systemPrompt,
      userPrompt,
      temperature: 0.1,
      maxTokens: 1500
    });
  }

  /**
   * 函数作用：把 recon LLM 判定结果组装成 VerificationResult。
   * recon 不要求 acceptedArtifacts，只要 LLM 说 success_criteria 都满足就给 VERIFIED_DONE。
   */
  private buildReconResultFromLlm(
    subgoalId: string,
    workerResult: WorkerResult,
    llmResult: LlmVerificationOutput
  ): VerificationResult {
    const verdicts = llmResult.criteria_verdicts ?? [];
    const satisfied = verdicts.filter((v) => v.verdict === "satisfied");
    const unsatisfied = verdicts.filter((v) => v.verdict === "unsatisfied");
    const gap = unsatisfied.map((v) => v.criterion);

    let verifiedStatus: VerificationStatus;
    let notes: string;

    if (verdicts.length === 0 || verdicts.every((v) => v.verdict === "unverifiable")) {
      verifiedStatus = VerificationStatus.UNVERIFIABLE;
      notes = "Recon: no criterion could be verified from the findings";
    } else if (unsatisfied.length === 0) {
      verifiedStatus = VerificationStatus.VERIFIED_DONE;
      notes = `Recon: all ${satisfied.length} success criteria answered`;
      if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
        notes += `. Note: claimed_outcome inconsistency — ${llmResult.outcome_inconsistency_notes}`;
      }
    } else if (satisfied.length > 0) {
      verifiedStatus = VerificationStatus.PARTIAL;
      notes = `Recon: ${satisfied.length}/${verdicts.length} criteria answered`;
      if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
        notes += `. Inconsistency: ${llmResult.outcome_inconsistency_notes}`;
      }
    } else {
      verifiedStatus = VerificationStatus.UNVERIFIABLE;
      notes = "Recon: findings did not satisfy any criterion";
    }

    return {
      schema_version: "v1",
      execution_id: workerResult.execution_id,
      subgoal_id: subgoalId,
      verified_status: verifiedStatus,
      accepted_artifacts: [],
      gap,
      notes,
      verified_at: nowIso()
    };
  }

  private async runLlmVerification(
    subgoal: SubgoalContract,
    workerResult: WorkerResult,
    acceptedArtifacts: ArtifactRef[],
    settings: Settings
  ): Promise<LlmVerificationOutput> {
    const systemPrompt = [
      "You are an independent execution verifier. You do not trust the worker's self-assessment.",
      "Check whether each success criterion is actually satisfied based on the execution history and verified artifacts.",
      "Also check whether the claimed outcome is consistent with the execution history — flag contradictions.",
      "Be strict but fair. Output valid JSON only, no extra text."
    ].join("\n");

    const artifactsList = acceptedArtifacts.length > 0
      ? acceptedArtifacts.map((a) => `- ${a.uri} (type: ${a.artifact_type})`).join("\n")
      : "None";

    const userPrompt = [
      "## Success Criteria",
      subgoal.success_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
      "",
      "## Worker Claimed Outcome",
      workerResult.claimed_outcome ?? "(not provided)",
      "",
      "## Execution History (compressed)",
      workerResult.compressed_history || "(not provided)",
      "",
      "## Accepted Artifacts (physically verified to exist on disk)",
      artifactsList,
      "",
      "For each success criterion output a verdict:",
      '  "satisfied"    — execution history or artifacts clearly confirm it',
      '  "unsatisfied"  — history shows it was not achieved or contradicts it',
      '  "unverifiable" — no evidence either way in the provided history',
      "",
      "Also assess whether the claimed outcome is consistent with the execution history.",
      "",
      "Output exactly this JSON shape:",
      '{"criteria_verdicts":[{"criterion":"...","verdict":"satisfied|unsatisfied|unverifiable","evidence":"..."}],"outcome_consistent":true,"outcome_inconsistency_notes":"..."}'
    ].join("\n");

    logger.debug({ subgoalId: subgoal.subgoal_id, criteriaCount: subgoal.success_criteria.length, acceptedArtifacts: acceptedArtifacts.length }, "发送 LLM 验证请求");
    const output = await this.llmClient.generateJson<LlmVerificationOutput>({
      settings,
      role: "verifier",
      systemPrompt,
      userPrompt,
      temperature: 0.1,
      maxTokens: 1500
    });
    logger.debug(
      { subgoalId: subgoal.subgoal_id, verdictCount: output.criteria_verdicts?.length ?? 0, outcomeConsistent: output.outcome_consistent },
      "LLM 验证响应已接收"
    );
    return output;
  }

  private buildResultFromLlm(
    subgoalId: string,
    workerResult: WorkerResult,
    acceptedArtifacts: ArtifactRef[],
    llmResult: LlmVerificationOutput
  ): VerificationResult {
    const verdicts = llmResult.criteria_verdicts ?? [];
    const satisfied = verdicts.filter((v) => v.verdict === "satisfied");
    const unsatisfied = verdicts.filter((v) => v.verdict === "unsatisfied");
    const gap = unsatisfied.map((v) => v.criterion);

    let verifiedStatus: VerificationStatus;
    let notes: string;

    logger.debug(
      { subgoalId, satisfied: satisfied.length, unsatisfied: unsatisfied.length, unverifiable: verdicts.length - satisfied.length - unsatisfied.length, outcomeConsistent: llmResult.outcome_consistent },
      "LLM criteria 判定分布"
    );
    for (const v of unsatisfied) {
      logger.debug({ subgoalId, criterion: v.criterion, evidence: v.evidence }, "criteria 未满足");
    }
    if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
      logger.warn({ subgoalId, inconsistencyNotes: llmResult.outcome_inconsistency_notes }, "claimed outcome 与执行历史存在矛盾");
    }

    if (verdicts.length === 0 || verdicts.every((v) => v.verdict === "unverifiable")) {
      verifiedStatus = VerificationStatus.UNVERIFIABLE;
      notes = "No criteria could be verified from the execution history";
    } else if (unsatisfied.length === 0) {
      // 所有 criterion 都满足（或部分 unverifiable 但无 unsatisfied）→ 信任 LLM 判定为 VERIFIED_DONE。
      //
      // 之前这里有个硬约束：`acceptedArtifacts.length > 0 ? VERIFIED_DONE : PARTIAL`，导致**纯文本任务**
      // （分析、总结、回答问题、explain 类的）即使所有 criteria 都满足也只能拿 PARTIAL，触发自动 replan，
      // 下一轮 worker 同样吐文字答案、verifier 同样判 PARTIAL，无限循环。
      //
      // 如果 success_criteria 真的要求"产出文件 X"，worker 没产，LLM 看 execution_history 时就会判
      // 这条 criterion 为 unsatisfied —— 该走 PARTIAL 的还是会走 PARTIAL。不要在 LLM 之上再加一层
      // 一刀切的 artifact 硬约束。
      verifiedStatus = VerificationStatus.VERIFIED_DONE;
      const artifactNote = acceptedArtifacts.length > 0
        ? `, ${acceptedArtifacts.length} artifact(s) accepted`
        : ", text-only result (no file artifact required)";
      notes = `All ${satisfied.length} criteria satisfied${artifactNote}`;
      if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
        notes += `. Note: claimed outcome inconsistency — ${llmResult.outcome_inconsistency_notes}`;
      }
    } else if (satisfied.length > 0) {
      verifiedStatus = VerificationStatus.PARTIAL;
      notes = `${satisfied.length}/${verdicts.length} criteria satisfied`;
      if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
        notes += `. Inconsistency: ${llmResult.outcome_inconsistency_notes}`;
      }
    } else {
      verifiedStatus = VerificationStatus.FAILED;
      notes = `All ${verdicts.length} criteria unsatisfied`;
      if (!llmResult.outcome_consistent && llmResult.outcome_inconsistency_notes) {
        notes += `. Claimed outcome contradicts history: ${llmResult.outcome_inconsistency_notes}`;
      }
    }

    return {
      schema_version: "v1",
      execution_id: workerResult.execution_id,
      subgoal_id: subgoalId,
      verified_status: verifiedStatus,
      accepted_artifacts: verifiedStatus === VerificationStatus.VERIFIED_DONE ? acceptedArtifacts : [],
      gap,
      notes,
      verified_at: nowIso()
    };
  }

  private buildArtifactOnlyResult(
    subgoalId: string,
    subgoal: SubgoalContract,
    workerResult: WorkerResult,
    acceptedArtifacts: ArtifactRef[],
    extraNotes: string
  ): VerificationResult {
    let verifiedStatus: VerificationStatus;
    let notes: string;

    // LLM 不可用时的启发式降级：worker DONE + (有文件 artifact 或有 claimed_outcome 文字答案) → VERIFIED_DONE。
    // 之前这条 fallback 强制要求 acceptedArtifacts.length > 0 才算 DONE，否则视为 FAILED；
    // 这导致 LLM 网络故障时所有纯文本任务（分析/总结/explain）被一刀切判 FAILED。
    // 既然 LLM 不可用没法精验，至少要尊重 worker 自报和它实际产出的形式（文字或文件）。
    const hasArtifact = acceptedArtifacts.length > 0;
    const hasTextOutcome = (workerResult.claimed_outcome?.trim().length ?? 0) > 0;

    if (workerResult.worker_status === "DONE" && (hasArtifact || hasTextOutcome)) {
      verifiedStatus = VerificationStatus.VERIFIED_DONE;
      notes = hasArtifact
        ? `Produced artifacts exist and contain materialized files. ${extraNotes}`
        : `Worker DONE with text-only outcome (no artifact required). ${extraNotes}`;
    } else if (workerResult.worker_status === "PARTIAL") {
      verifiedStatus = VerificationStatus.PARTIAL;
      notes = `Partial progress observed. ${extraNotes}`;
    } else {
      verifiedStatus = VerificationStatus.FAILED;
      notes = `Worker reported DONE but neither artifacts nor a text outcome were produced. ${extraNotes}`;
    }

    return {
      schema_version: "v1",
      execution_id: workerResult.execution_id,
      subgoal_id: subgoalId,
      verified_status: verifiedStatus,
      accepted_artifacts: verifiedStatus === VerificationStatus.VERIFIED_DONE ? acceptedArtifacts : [],
      gap: verifiedStatus === VerificationStatus.VERIFIED_DONE ? [] : subgoal.success_criteria,
      notes,
      verified_at: nowIso()
    };
  }
}
