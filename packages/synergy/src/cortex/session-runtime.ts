import { SessionCortexRuntime } from "../session/cortex-runtime"
import type { CortexDelegationInfo } from "../session/types"
import { Cortex } from "./manager"
import { pluginTaskSnapshotFromSession } from "./plugin-task"

/**
 * S9c source inversion: the L1 session domain observes cortex task state
 * (delegated execution context, running-task reminders, continuation
 * blockers, parent notification reconciliation, abort cancellation, plugin
 * task snapshots) through the SessionCortexRuntime registry instead of
 * importing the cortex product domain. Loaded through
 * src/product-registration.ts.
 */
export function registerCortexSessionRuntime() {
  SessionCortexRuntime.register({
    delegatedTask: async (sessionID) => {
      const task = Cortex.list().find((task) => task.sessionID === sessionID)
      if (!task || task.executionRole !== "delegated_subagent") return undefined
      return { parentSessionID: task.parentSessionID, dagNodeId: task.dagNodeId }
    },
    runningTaskRows: async (parentSessionID) =>
      Cortex.getRunningTasks()
        .filter((task) => task.parentSessionID === parentSessionID)
        .map((task) => {
          const described = Cortex.describe(task)
          return {
            id: task.id,
            agent: task.agent,
            description: task.description,
            startedAt: task.startedAt,
            health: described.health,
            ...(described.lastTool !== undefined ? { lastTool: described.lastTool } : {}),
            ...(described.lastToolStatus !== undefined ? { lastToolStatus: described.lastToolStatus } : {}),
          }
        }),
    activeTaskRows: async (sessionID) =>
      Cortex.getTasksForSession(sessionID)
        .filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => ({ id: task.id, description: task.description })),
    reconcileParentNotifications: (scopeID) => Cortex.reconcileParentNotifications(scopeID),
    cancelAllForParent: async (parentSessionID) => {
      await Cortex.cancelAll(parentSessionID)
    },
    pluginTaskSnapshot: (handle, delegation) =>
      pluginTaskSnapshotFromSession(handle, delegation as CortexDelegationInfo),
  })
}
