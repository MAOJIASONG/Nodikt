import { existsSync, readdirSync, statSync } from "fs";

import { VerificationResult, VerificationStatus, WorkerResult, nowIso } from "../domain/index.js";

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
