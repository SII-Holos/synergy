import { PrimaryAgentUpgrade } from "@ericsanchezok/synergy-harness/agent/primary-identity-upgrade"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
export function upgradeOwnerSession(key: string[], value: Record<string, unknown>) {
  if (key[0] !== "sessions") return
  if (key.length === 4 && key[3] === "info") {
    const legacy = record(value.lightLoop)
    if (
      legacy?.active === true &&
      typeof legacy.taskDescription === "string" &&
      !value.workflow &&
      !value.lattice &&
      !record(value.blueprint)?.loopID
    ) {
      value.workflow = { kind: "lightloop", instructions: legacy.taskDescription }
      delete value.lightLoop
    }
    const workflow = record(value.workflow)
    if (workflow?.kind === "lightloop") {
      if (typeof workflow.taskDescription === "string" && !workflow.instructions) {
        workflow.instructions = workflow.taskDescription
        delete workflow.taskDescription
      }
      PrimaryAgentUpgrade.fields(workflow, ["executionAgent", "reviewAgent"])
    }
  }
  if (key.length === 6 && key[3] === "messages" && key[5] === "info") {
    const metadata = record(value.metadata)
    if (!metadata) return
    const kind =
      metadata.workflowMode === "light_loop"
        ? "lightloop"
        : (metadata.workflowMode ?? (metadata.planModeRequest === true ? "plan" : undefined))
    if (kind !== "lightloop") return
    metadata.workflow = kind
    metadata.workflowVersion = 1
    const agent = metadata.workflowModeAgent ?? metadata.planModeAgent
    if (typeof agent === "string") metadata.workflowAgent = agent
    for (const field of [
      "planModeRequest",
      "planModeAgent",
      "planModeWrapperVersion",
      "workflowMode",
      "workflowModeAgent",
      "workflowModeVersion",
    ])
      delete metadata[field]
  }
}
async function upgradeSession(owner: { scopeID: string; sessionID: string }) {
  const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
  await Storage.transaction(async () => {
    const [value] = await Storage.readMany<Record<string, unknown>>([key])
    if (!value) return
    const before = JSON.stringify(value)
    upgradeOwnerSession(key, value)
    const workflow = record(value.workflow)
    if (
      key.length === 4 &&
      workflow?.kind === "lightloop" &&
      ["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"].includes(String(workflow.status))
    ) {
      const pluginOwner = record(workflow.pluginOwner)
      if (
        !pluginOwner ||
        (typeof pluginOwner.pluginId === "string" &&
          typeof pluginOwner.pluginGeneration === "string" &&
          typeof pluginOwner.scopeId === "string")
      ) {
        await Storage.write(["sessions", key[1], key[2], "lightloop_terminal"], {
          sessionID: key[2],
          status: workflow.status,
          instructions: typeof workflow.instructions === "string" ? workflow.instructions : "",
          ...(pluginOwner ? { pluginOwner } : {}),
          ...(typeof workflow.terminalError === "string" ? { error: workflow.terminalError } : {}),
          ...(typeof workflow.terminalHookDeliveredAt === "number"
            ? { hookDeliveredAt: workflow.terminalHookDeliveredAt }
            : {}),
          ...(typeof workflow.terminalHookError === "string" ? { hookError: workflow.terminalHookError } : {}),
          createdAt: record(value.time)?.updated ?? 0,
        })
        delete value.workflow
      }
    }
    if (before !== JSON.stringify(value)) await Storage.write(key, value)
  })
}

export const migrations: Migration[] = [
  {
    id: "20261012-light-loop-session-owner",
    description: "Upgrade retained light-loop Session state when its owner is selected",
    scope: "session",
    execution: "record",
    onAccess: true,
    upSession: upgradeSession,
    upgradeRecord: upgradeOwnerSession,
    async up(progress) {
      let count = 0
      for await (const { key } of Storage.records({ kind: "session" })) {
        await upgradeSession({ scopeID: key[1]!, sessionID: key[2]! })
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
]
export function registerSessionMigrations() {
  MigrationRegistry.register("light-loop-session", migrations)
}
