/**
 * 文件名称：service.ts
 * 文件作用：验证服务模块，负责检查工作器产出是否满足执行目标和产物要求。
 *
 * 主要职责：
 * 1. 根据工作器结果判断执行是否通过验证。
 * 2. 检查声明产物在文件系统中的可访问性。
 * 3. 生成标准 VerificationResult 供归并服务使用。
 *
 * 依赖模块：
 * - fs：产物路径存在性和目录扫描检查。
 * - domain：验证结果、验证状态和工作器结果类型。
 *
 * 注意事项：
 * - 验证逻辑应可解释，失败原因需要便于工作器或用户修复。
 * - 文件系统检查应限制在声明产物范围内，避免昂贵扫描。
 */
import { existsSync, readdirSync, statSync } from "fs";

import { VerificationResult, VerificationStatus, WorkerResult, nowIso } from "../../../domain/index.js";

export class VerifierService {
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

  /**
   * 函数作用：验证工作器结果是否满足子目标要求。
   *
   * 参数说明：
   * - subgoalId：被验证的子目标 ID。
   * - workerResult：工作器返回的执行结果。
   *
   * 返回值：
   * - VerificationResult：包含验证状态、发现项和阻塞原因的结果。
   */
  verify(subgoalId: string, workerResult: WorkerResult): VerificationResult {
    let verifiedStatus = VerificationStatus.FAILED;
    let notes = "Worker result failed verification";
    const acceptedArtifacts = workerResult.produced_artifacts.filter((artifact) => this.hasMaterializedArtifact(artifact.uri));

    if (workerResult.worker_status === "DONE" && acceptedArtifacts.length > 0) {
      verifiedStatus = VerificationStatus.VERIFIED_DONE;
      notes = "Produced artifacts exist and contain materialized files";
    } else if (workerResult.worker_status === "PARTIAL") {
      verifiedStatus = VerificationStatus.PARTIAL;
      notes = "Partial progress observed";
    } else if (workerResult.worker_status === "DONE") {
      verifiedStatus = VerificationStatus.FAILED;
      notes = "Worker reported DONE but no materialized files were found";
    } else if (workerResult.worker_status === "NEED_HELP" || workerResult.worker_status === "BLOCKED") {
      verifiedStatus = VerificationStatus.UNVERIFIABLE;
      notes = workerResult.blocker_reason?.message ?? "Worker needs manual intervention";
    }

    return {
      schema_version: "v1",
      execution_id: workerResult.execution_id,
      subgoal_id: subgoalId,
      verified_status: verifiedStatus,
      accepted_artifacts: verifiedStatus === VerificationStatus.VERIFIED_DONE
        ? acceptedArtifacts
        : [],
      notes,
      verified_at: nowIso()
    };
  }
}
