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

    // DONE or PARTIAL: run LLM verification
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
      // All satisfied or unverifiable, none unsatisfied
      verifiedStatus = acceptedArtifacts.length > 0
        ? VerificationStatus.VERIFIED_DONE
        : VerificationStatus.PARTIAL;
      notes = `All ${satisfied.length} criteria satisfied`;
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

    if (workerResult.worker_status === "DONE" && acceptedArtifacts.length > 0) {
      verifiedStatus = VerificationStatus.VERIFIED_DONE;
      notes = `Produced artifacts exist and contain materialized files. ${extraNotes}`;
    } else if (workerResult.worker_status === "PARTIAL") {
      verifiedStatus = VerificationStatus.PARTIAL;
      notes = `Partial progress observed. ${extraNotes}`;
    } else {
      verifiedStatus = VerificationStatus.FAILED;
      notes = `Worker reported DONE but no materialized files were found. ${extraNotes}`;
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
