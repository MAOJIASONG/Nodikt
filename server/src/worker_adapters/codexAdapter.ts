import { WorkerDispatchPacket, WorkerRegistration } from "../domain/index.js";
import { BaseLocalCommandAdapter } from "./baseLocalCommandAdapter.js";

export class CodexAdapter extends BaseLocalCommandAdapter {
  protected resolveCommand(worker: WorkerRegistration, packet: WorkerDispatchPacket) {
    return {
      command: worker.config.command ?? "bash",
      args: worker.config.args ?? [
        "-lc",
        `echo "Codex execution ${packet.execution_id}"; echo "${packet.subgoal_contract.objective}"`
      ],
      env: worker.config.env ?? {},
      cwd: worker.config.workspace_root
    };
  }
}
