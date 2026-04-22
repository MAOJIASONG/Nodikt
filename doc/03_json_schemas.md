
1. 共享约定

先放一个共享 defs，后面各文件 schema 都会引用它。

{
  "$id": "schemas/common.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Nodikt Common Definitions",
  "type": "object",
  "$defs": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "isoDateTime": {
      "type": "string",
      "format": "date-time"
    },
    "demandState": {
      "type": "string",
      "enum": [
        "PENDING_ALIGNMENT",
        "READY",
        "ACTIVE",
        "PENDING_DECISION",
        "PAUSED",
        "COMPLETED",
        "FAILED",
        "CANCELLED"
      ]
    },
    "subgoalState": {
      "type": "string",
      "enum": [
        "PLANNED",
        "READY",
        "DISPATCHED",
        "EXECUTING",
        "BLOCKED",
        "VERIFYING",
        "DONE",
        "FAILED",
        "CANCELLED"
      ]
    },
    "executionState": {
      "type": "string",
      "enum": [
        "QUEUED",
        "RUNNING",
        "WAITING_RESULT",
        "VERIFYING",
        "DONE",
        "FAILED",
        "INTERRUPTED",
        "TIMEOUT",
        "CANCELLED"
      ]
    },
    "decisionStatus": {
      "type": "string",
      "enum": ["OPEN", "RESOLVED", "EXPIRED", "CANCELLED"]
    },
    "workerStatus": {
      "type": "string",
      "enum": ["idle", "busy", "offline", "error", "disabled"]
    },
    "autonomyLevel": {
      "type": "string",
      "enum": ["L0", "L1", "L2", "L3", "L4"]
    },
    "artifactRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["artifact_id", "artifact_type", "backend", "uri", "created_at"],
      "properties": {
        "artifact_id": { "$ref": "#/$defs/id" },
        "artifact_type": {
          "type": "string",
          "enum": [
            "git_commit",
            "pull_request",
            "file_bundle",
            "structured_output_json"
          ]
        },
        "backend": {
          "type": "string",
          "enum": ["git", "filesystem"]
        },
        "uri": {
          "type": "string",
          "minLength": 1
        },
        "metadata": {
          "type": "object",
          "default": {}
        },
        "created_at": {
          "$ref": "#/$defs/isoDateTime"
        }
      }
    },
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_steps": { "type": "integer", "minimum": 1 },
        "max_minutes": { "type": "integer", "minimum": 1 },
        "max_cost_usd": { "type": "number", "minimum": 0 },
        "max_actions": { "type": "integer", "minimum": 1 }
      },
      "default": {}
    },
    "permissions": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "can_modify_files",
        "can_run_commands",
        "can_install_dependencies",
        "can_open_pr"
      ],
      "properties": {
        "can_modify_files": { "type": "boolean" },
        "can_run_commands": { "type": "boolean" },
        "can_install_dependencies": { "type": "boolean" },
        "can_open_pr": { "type": "boolean" }
      }
    }
  }
}


⸻

2. demands.json

{
  "$id": "schemas/demands.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "demands.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/demand" }
    }
  },
  "$defs": {
    "demand": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "demand_id",
        "title",
        "initial_input",
        "state",
        "autonomy_level",
        "acceptance_criteria",
        "constraints",
        "created_at",
        "updated_at"
      ],
      "properties": {
        "demand_id": { "type": "string", "minLength": 1 },
        "title": { "type": "string", "minLength": 1 },
        "type": {
          "type": "string",
          "enum": ["project", "reminder"],
          "default": "project"
        },
        "initial_input": { "type": "string", "minLength": 1 },
        "clarified_demand": { "type": ["string", "null"], "default": null },
        "operational_objective": {
          "type": ["object", "null"],
          "default": null,
          "additionalProperties": false,
          "required": ["objective", "acceptance_criteria", "constraints"],
          "properties": {
            "objective": { "type": "string", "minLength": 1 },
            "acceptance_criteria": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "constraints": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "non_goals": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "termination_conditions": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            }
          }
        },
        "state": {
          "type": "string",
          "enum": [
            "PENDING_ALIGNMENT",
            "READY",
            "ACTIVE",
            "PENDING_DECISION",
            "PAUSED",
            "COMPLETED",
            "FAILED",
            "CANCELLED"
          ]
        },
        "autonomy_level": {
          "type": "string",
          "enum": ["L0", "L1", "L2", "L3", "L4"]
        },
        "acceptance_criteria": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "constraints": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "progress_percent": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "default": 0
        },
        "current_phase": {
          "type": "string",
          "enum": [
            "ALIGNMENT",
            "PLANNING",
            "EXECUTION",
            "REVIEW",
            "COMPLETED",
            "FAILED",
            "CANCELLED"
          ],
          "default": "ALIGNMENT"
        },
        "active_decision_id": {
          "type": ["string", "null"],
          "default": null
        },
        "tags": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "created_at": { "type": "string", "format": "date-time" },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

3. subgoals.json

{
  "$id": "schemas/subgoals.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "subgoals.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/subgoal" }
    }
  },
  "$defs": {
    "budget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_steps": { "type": "integer", "minimum": 1 },
        "max_minutes": { "type": "integer", "minimum": 1 },
        "max_cost_usd": { "type": "number", "minimum": 0 },
        "max_actions": { "type": "integer", "minimum": 1 }
      },
      "default": {}
    },
    "subgoal": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "subgoal_id",
        "demand_id",
        "title",
        "objective",
        "success_criteria",
        "failure_criteria",
        "constraints",
        "budget",
        "deliverables",
        "dependencies",
        "priority",
        "state",
        "created_at",
        "updated_at"
      ],
      "properties": {
        "subgoal_id": { "type": "string", "minLength": 1 },
        "demand_id": { "type": "string", "minLength": 1 },
        "title": { "type": "string", "minLength": 1 },
        "objective": { "type": "string", "minLength": 1 },
        "success_criteria": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "failure_criteria": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "constraints": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "budget": { "$ref": "#/$defs/budget" },
        "deliverables": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "git_commit",
              "pull_request",
              "file_bundle",
              "structured_output_json"
            ]
          },
          "default": []
        },
        "dependencies": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "priority": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "state": {
          "type": "string",
          "enum": [
            "PLANNED",
            "READY",
            "DISPATCHED",
            "EXECUTING",
            "BLOCKED",
            "VERIFYING",
            "DONE",
            "FAILED",
            "CANCELLED"
          ]
        },
        "assigned_worker_id": {
          "type": ["string", "null"],
          "default": null
        },
        "active_execution_id": {
          "type": ["string", "null"],
          "default": null
        },
        "accepted_artifact_ids": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "created_at": { "type": "string", "format": "date-time" },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

4. executions.json

{
  "$id": "schemas/executions.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "executions.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/execution" }
    }
  },
  "$defs": {
    "workerResult": {
      "type": ["object", "null"],
      "default": null,
      "additionalProperties": false,
      "required": [
        "execution_id",
        "worker_id",
        "worker_status",
        "compressed_history",
        "produced_artifacts"
      ],
      "properties": {
        "execution_id": { "type": "string" },
        "worker_id": { "type": "string" },
        "worker_status": {
          "type": "string",
          "enum": ["DONE", "BLOCKED", "FAILED", "NEED_HELP", "PARTIAL"]
        },
        "claimed_outcome": {
          "type": ["string", "null"],
          "default": null
        },
        "compressed_history": { "type": "string", "minLength": 1 },
        "produced_artifacts": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "blocker_reason": {
          "type": ["object", "null"],
          "default": null,
          "additionalProperties": false,
          "required": ["code", "message"],
          "properties": {
            "code": { "type": "string", "minLength": 1 },
            "message": { "type": "string", "minLength": 1 }
          }
        },
        "suggested_next_step": {
          "type": ["string", "null"],
          "default": null
        },
        "budget_used": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "steps": { "type": "integer", "minimum": 0 },
            "duration_ms": { "type": "integer", "minimum": 0 },
            "estimated_cost_usd": { "type": "number", "minimum": 0 }
          },
          "default": {}
        },
        "received_at": { "type": "string", "format": "date-time" }
      }
    },
    "verificationResult": {
      "type": ["object", "null"],
      "default": null,
      "additionalProperties": false,
      "required": [
        "execution_id",
        "subgoal_id",
        "verified_status",
        "accepted_artifacts",
        "notes"
      ],
      "properties": {
        "execution_id": { "type": "string" },
        "subgoal_id": { "type": "string" },
        "verified_status": {
          "type": "string",
          "enum": ["VERIFIED_DONE", "PARTIAL", "FAILED", "UNVERIFIABLE"]
        },
        "accepted_artifacts": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "notes": { "type": "string", "default": "" },
        "verified_at": { "type": "string", "format": "date-time" }
      }
    },
    "execution": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "execution_id",
        "demand_id",
        "subgoal_id",
        "worker_id",
        "state",
        "dispatch_packet_version",
        "created_at",
        "updated_at"
      ],
      "properties": {
        "execution_id": { "type": "string", "minLength": 1 },
        "demand_id": { "type": "string", "minLength": 1 },
        "subgoal_id": { "type": "string", "minLength": 1 },
        "worker_id": { "type": "string", "minLength": 1 },
        "state": {
          "type": "string",
          "enum": [
            "QUEUED",
            "RUNNING",
            "WAITING_RESULT",
            "VERIFYING",
            "DONE",
            "FAILED",
            "INTERRUPTED",
            "TIMEOUT",
            "CANCELLED"
          ]
        },
        "dispatch_packet_version": {
          "type": "string",
          "const": "v1"
        },
        "dispatch_packet": {
          "type": ["object", "null"],
          "default": null
        },
        "worker_result": {
          "$ref": "#/$defs/workerResult"
        },
        "verification_result": {
          "$ref": "#/$defs/verificationResult"
        },
        "retry_count": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "started_at": {
          "type": ["string", "null"],
          "format": "date-time",
          "default": null
        },
        "finished_at": {
          "type": ["string", "null"],
          "format": "date-time",
          "default": null
        },
        "last_heartbeat_at": {
          "type": ["string", "null"],
          "format": "date-time",
          "default": null
        },
        "created_at": { "type": "string", "format": "date-time" },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

5. workers.json

{
  "$id": "schemas/workers.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "workers.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/worker" }
    }
  },
  "$defs": {
    "worker": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "worker_id",
        "name",
        "adapter_type",
        "runtime_type",
        "status",
        "max_concurrency",
        "capabilities",
        "install_policy",
        "config",
        "created_at",
        "updated_at"
      ],
      "properties": {
        "worker_id": { "type": "string", "minLength": 1 },
        "name": { "type": "string", "minLength": 1 },
        "adapter_type": {
          "type": "string",
          "enum": ["claude_code", "opencode", "openclaw", "custom"]
        },
        "runtime_type": {
          "type": "string",
          "enum": ["local_command", "http", "websocket"]
        },
        "status": {
          "type": "string",
          "enum": ["idle", "busy", "offline", "error", "disabled"]
        },
        "max_concurrency": {
          "type": "integer",
          "minimum": 1
        },
        "capabilities": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "available_skills": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "install_policy": {
          "type": "string",
          "enum": ["none", "allowed_with_review"]
        },
        "config": {
          "type": "object",
          "additionalProperties": true,
          "default": {}
        },
        "current_execution_ids": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "last_seen_at": {
          "type": ["string", "null"],
          "format": "date-time",
          "default": null
        },
        "last_error": {
          "type": ["string", "null"],
          "default": null
        },
        "is_enabled": {
          "type": "boolean",
          "default": true
        },
        "created_at": { "type": "string", "format": "date-time" },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

6. decisions.json

{
  "$id": "schemas/decisions.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "decisions.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/decision" }
    }
  },
  "$defs": {
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "decision_id",
        "demand_id",
        "source",
        "reason_code",
        "prompt",
        "options",
        "status",
        "created_at",
        "updated_at"
      ],
      "properties": {
        "decision_id": { "type": "string", "minLength": 1 },
        "demand_id": { "type": "string", "minLength": 1 },
        "subgoal_id": {
          "type": ["string", "null"],
          "default": null
        },
        "execution_id": {
          "type": ["string", "null"],
          "default": null
        },
        "source": {
          "type": "string",
          "enum": ["scheduler", "worker", "verifier", "ops"]
        },
        "reason_code": {
          "type": "string",
          "enum": [
            "MISSING_INFO",
            "MISSING_PERMISSION",
            "INSTALL_REQUIRES_REVIEW",
            "PLAN_CONFLICT",
            "UNVERIFIABLE_RESULT",
            "HIGH_RISK_ACTION",
            "BLOCKED",
            "OPS_ALERT"
          ]
        },
        "prompt": { "type": "string", "minLength": 1 },
        "options": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "Approve",
              "Reject",
              "ProvideInfo",
              "Pause",
              "Stop",
              "CancelDemand"
            ]
          },
          "minItems": 1
        },
        "status": {
          "type": "string",
          "enum": ["OPEN", "RESOLVED", "EXPIRED", "CANCELLED"]
        },
        "response": {
          "type": ["object", "null"],
          "default": null,
          "additionalProperties": false,
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "Approve",
                "Reject",
                "ProvideInfo",
                "Pause",
                "Stop",
                "CancelDemand"
              ]
            },
            "note": {
              "type": ["string", "null"],
              "default": null
            },
            "payload": {
              "type": "object",
              "default": {}
            },
            "responded_at": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        "created_at": { "type": "string", "format": "date-time" },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

7. events.json

这个是最关键的。

{
  "$id": "schemas/events.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "events.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/event" }
    }
  },
  "$defs": {
    "eventType": {
      "type": "string",
      "enum": [
        "USER_INPUT_RECEIVED",
        "DEMAND_CLARIFICATION_COMPLETED",
        "PLAN_GENERATED",
        "SUBGOAL_CREATED",
        "SUBGOAL_MARKED_READY",
        "EXECUTION_CREATED",
        "EXECUTION_DISPATCHED",
        "WORKER_HEARTBEAT_RECEIVED",
        "WORKER_RESULT_RECEIVED",
        "EXECUTION_TIMEOUT_DETECTED",
        "VERIFICATION_COMPLETED",
        "RECONCILIATION_COMPLETED",
        "DECISION_REQUEST_CREATED",
        "DECISION_RESPONSE_RECEIVED",
        "USER_PAUSE_REQUESTED",
        "USER_RESUME_REQUESTED",
        "USER_STOP_EXECUTION_REQUESTED",
        "USER_CANCEL_DEMAND_REQUESTED",
        "USER_STOP_WORKER_REQUESTED",
        "OPS_ALERT_RECEIVED",
        "REPLAN_REQUESTED",
        "MISSION_COMPLETED"
      ]
    },
    "event": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "event_id",
        "event_type",
        "created_at",
        "payload"
      ],
      "properties": {
        "event_id": { "type": "string", "minLength": 1 },
        "event_type": { "$ref": "#/$defs/eventType" },
        "demand_id": {
          "type": ["string", "null"],
          "default": null
        },
        "subgoal_id": {
          "type": ["string", "null"],
          "default": null
        },
        "execution_id": {
          "type": ["string", "null"],
          "default": null
        },
        "decision_id": {
          "type": ["string", "null"],
          "default": null
        },
        "worker_id": {
          "type": ["string", "null"],
          "default": null
        },
        "payload": {
          "type": "object",
          "additionalProperties": true,
          "default": {}
        },
        "created_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  }
}


⸻

8. memory.json

这里按 demand_id 存三层记忆最稳。

{
  "$id": "schemas/memory.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "memory.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "updated_at", "items"],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/memoryRecord" }
    }
  },
  "$defs": {
    "memoryRecord": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "demand_id",
        "mission_state",
        "episodic_trace",
        "lessons_or_policy",
        "updated_at"
      ],
      "properties": {
        "demand_id": { "type": "string", "minLength": 1 },
        "mission_state": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "current_phase",
            "dependency_graph",
            "active_subgoals",
            "completed_subgoals",
            "failed_subgoals",
            "blocked_subgoals",
            "accepted_artifacts",
            "global_risks",
            "termination_conditions"
          ],
          "properties": {
            "current_phase": {
              "type": "string",
              "enum": [
                "ALIGNMENT",
                "PLANNING",
                "EXECUTION",
                "REVIEW",
                "COMPLETED",
                "FAILED",
                "CANCELLED"
              ]
            },
            "dependency_graph": {
              "type": "object",
              "additionalProperties": true,
              "default": {}
            },
            "active_subgoals": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "completed_subgoals": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "failed_subgoals": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "blocked_subgoals": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "accepted_artifacts": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "global_risks": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "termination_conditions": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            }
          }
        },
        "episodic_trace": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "recent_events",
            "recent_worker_summaries",
            "latest_verifier_notes"
          ],
          "properties": {
            "recent_events": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "recent_worker_summaries": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["worker_id", "subgoal_id", "summary"],
                "properties": {
                  "worker_id": { "type": "string" },
                  "subgoal_id": { "type": "string" },
                  "summary": { "type": "string" }
                }
              },
              "default": []
            },
            "latest_verifier_notes": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            }
          }
        },
        "lessons_or_policy": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "reusable_skills",
            "routing_hints",
            "failure_patterns",
            "strategy_notes"
          ],
          "properties": {
            "reusable_skills": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "routing_hints": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "failure_patterns": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "strategy_notes": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            }
          }
        },
        "updated_at": { "type": "string", "format": "date-time" }
      }
    }
  }
}


⸻

9. settings.json

{
  "$id": "schemas/settings.schema.json",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "settings.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version",
    "updated_at",
    "models",
    "workspace_root",
    "runtime",
    "worker_policy",
    "default_permissions"
  ],
  "properties": {
    "version": { "const": "v1" },
    "updated_at": { "type": "string", "format": "date-time" },

    "models": {
      "type": "object",
      "additionalProperties": false,
      "required": ["primary", "planner", "verifier", "ops_backup"],
      "properties": {
        "primary": { "$ref": "#/$defs/modelConfig" },
        "planner": { "$ref": "#/$defs/modelConfig" },
        "verifier": { "$ref": "#/$defs/modelConfig" },
        "ops_backup": { "$ref": "#/$defs/modelConfig" }
      }
    },

    "workspace_root": {
      "type": "string",
      "minLength": 1
    },

    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "heartbeat_interval_seconds",
        "execution_timeout_seconds",
        "max_retry_count"
      ],
      "properties": {
        "heartbeat_interval_seconds": {
          "type": "integer",
          "minimum": 1,
          "default": 30
        },
        "execution_timeout_seconds": {
          "type": "integer",
          "minimum": 1,
          "default": 120
        },
        "auto_retry_transient_errors": {
          "type": "boolean",
          "default": true
        },
        "max_retry_count": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        }
      }
    },

    "worker_policy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["skill_install_scope"],
      "properties": {
        "skill_install_scope": {
          "type": "string",
          "enum": ["workspace_only"],
          "default": "workspace_only"
        }
      }
    },

    "default_autonomy_level": {
      "type": "string",
      "enum": ["L0", "L1", "L2", "L3", "L4"],
      "default": "L2"
    },

    "default_permissions": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "can_modify_files",
        "can_run_commands",
        "can_install_dependencies",
        "can_open_pr"
      ],
      "properties": {
        "can_modify_files": { "type": "boolean" },
        "can_run_commands": { "type": "boolean" },
        "can_install_dependencies": { "type": "boolean" },
        "can_open_pr": { "type": "boolean" }
      }
    }
  },

  "$defs": {
    "modelConfig": {
      "type": "object",
      "additionalProperties": false,
      "required": ["provider", "model", "base_url", "enabled"],
      "properties": {
        "provider": { "type": "string" },
        "model": { "type": "string" },
        "base_url": { "type": "string" },
        "api_key": {
          "type": ["string", "null"],
          "default": null
        },
        "enabled": { "type": "boolean" }
      }
    }
  }
}