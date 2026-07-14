import type { PluginTaskHandle, PluginTaskSnapshot } from "@ericsanchezok/synergy-plugin"
import { CortexTypes } from "./types"
import type { CortexDelegationInfo } from "../session/types"

type DurablePluginTask = Pick<
  CortexTypes.Task,
  | "status"
  | "owner"
  | "agent"
  | "model"
  | "startedAt"
  | "completedAt"
  | "timeoutMs"
  | "outputConfig"
  | "output"
  | "usage"
  | "error"
>

function snapshot(handle: PluginTaskHandle, task: DurablePluginTask): PluginTaskSnapshot | undefined {
  const owner = CortexTypes.PluginTaskOwner.safeParse(task.owner)
  if (!owner.success) return undefined
  return {
    ...handle,
    status: task.status,
    owner: owner.data,
    agent: task.agent,
    startedAt: task.startedAt,
    ...(task.model ? { model: task.model } : {}),
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    ...(task.outputConfig ? { outputConfig: task.outputConfig } : {}),
    ...(task.output ? { output: task.output } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(task.error ? { error: task.error } : {}),
  }
}

export function pluginTaskSnapshotFromTask(task: CortexTypes.Task): PluginTaskSnapshot | undefined {
  return snapshot({ taskId: task.id, sessionId: task.sessionID }, task)
}

export function pluginTaskSnapshotFromSession(
  handle: PluginTaskHandle,
  task: CortexDelegationInfo,
): PluginTaskSnapshot | undefined {
  return snapshot(handle, task)
}
