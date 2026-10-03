import type { ProjectDirectories, SynergyClient, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"

export class ProjectDirectoryRecoveryChanged extends Error {
  override name = "ProjectDirectoryRecoveryChanged"
}

export class ProjectDirectoryRecoveryUnavailable extends Error {
  override name = "ProjectDirectoryRecoveryUnavailable"
}

export type ProjectDirectoryRecovery = {
  directories: ProjectDirectories
  targets: WorkspaceInfo[]
  restored: Record<string, { requested: string; path: string }>
}

export function sameProjectDirectories(a: ProjectDirectories, b: ProjectDirectories) {
  return (
    a.scopeID === b.scopeID &&
    a.revision === b.revision &&
    a.mainWorkspaceID === b.mainWorkspaceID &&
    JSON.stringify(a.additionalWorkspaceIDs) === JSON.stringify(b.additionalWorkspaceIDs)
  )
}

async function read(client: SynergyClient, scopeID: string, expected: ProjectDirectories, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const options = { signal, throwOnError: true as const }
  const [folders, catalog] = await Promise.all([
    client.project.directories({ scopeID }, options),
    client.workspace.list({ scopeID }, options),
  ])
  signal?.throwIfAborted()
  if (!sameProjectDirectories(expected, folders.data)) throw new ProjectDirectoryRecoveryChanged()
  return { directories: folders.data, records: catalog.data }
}

export async function loadProjectDirectoryRecovery(
  client: SynergyClient,
  scopeID: string,
  expected: ProjectDirectories,
  signal?: AbortSignal,
): Promise<ProjectDirectoryRecovery> {
  const latest = await read(client, scopeID, expected, signal)
  const targets = latest.directories.folders
    .filter((folder) => !folder.available)
    .map((folder) => {
      const record = latest.records.find((item) => item.id === folder.workspaceID && item.scopeID === scopeID)
      if (!record || record.lifecycle !== "active") throw new ProjectDirectoryRecoveryUnavailable()
      if (record.binding.generation !== folder.generation || (record.binding.path ?? "") !== folder.path)
        throw new ProjectDirectoryRecoveryChanged()
      return record
    })
  return { directories: latest.directories, targets, restored: {} }
}

export async function recoverProjectDirectories(
  client: SynergyClient,
  plan: ProjectDirectoryRecovery,
  options: {
    signal?: AbortSignal
    paths?: Record<string, string>
    onRecovered?: (workspaceID: string, path: string) => void
  } = {},
): Promise<ProjectDirectories> {
  const scopeID = plan.directories.scopeID
  const targets = new Set(plan.targets.map((item) => item.id))
  const inspect = async () => {
    const latest = await read(client, scopeID, plan.directories, options.signal)
    for (const folder of plan.directories.folders) {
      if (targets.has(folder.workspaceID)) continue
      const current = latest.directories.folders.find((item) => item.workspaceID === folder.workspaceID)
      if (!current || current.path !== folder.path || current.generation !== folder.generation)
        throw new ProjectDirectoryRecoveryChanged()
    }
    return latest
  }
  for (const target of plan.targets) {
    const latest = await inspect()
    const folder = latest.directories.folders.find((item) => item.workspaceID === target.id)
    const record = latest.records.find((item) => item.id === target.id && item.scopeID === scopeID)
    const requested = options.paths?.[target.id] ?? target.binding.path
    if (!requested || !folder || !record || record.lifecycle !== "active")
      throw new ProjectDirectoryRecoveryUnavailable()
    const receipt = plan.restored[target.id]
    const path = receipt?.requested === requested ? receipt.path : requested
    if (record.binding.generation !== folder.generation || (record.binding.path ?? "") !== folder.path)
      throw new ProjectDirectoryRecoveryChanged()
    if (folder.available && folder.path === path) {
      options.onRecovered?.(target.id, path)
      continue
    }
    if (
      record.revision !== target.revision ||
      record.binding.generation !== target.binding.generation ||
      record.binding.path !== target.binding.path
    )
      throw new ProjectDirectoryRecoveryChanged()
    try {
      const response = await client.workspace.rebind(
        { scopeID, workspaceID: target.id, expectedRevision: target.revision, path },
        { signal: options.signal, throwOnError: true },
      )
      if (response.data.id !== target.id || response.data.scopeID !== scopeID || !response.data.binding.path)
        throw new ProjectDirectoryRecoveryChanged()
      plan.restored[target.id] = { requested, path: response.data.binding.path }
    } catch (error) {
      options.signal?.throwIfAborted()
      const observed = await inspect().catch(() => undefined)
      const current = observed?.directories.folders.find((item) => item.workspaceID === target.id)
      const rebound = observed?.records.find((item) => item.id === target.id)
      if (
        !current?.available ||
        current.path !== path ||
        !rebound ||
        rebound.revision <= target.revision ||
        rebound.binding.generation <= target.binding.generation
      )
        throw error
    }
    options.signal?.throwIfAborted()
    options.onRecovered?.(target.id, plan.restored[target.id]?.path ?? path)
  }
  const result = (await inspect()).directories
  if (result.folders.some((folder) => !folder.available)) throw new ProjectDirectoryRecoveryUnavailable()
  if (
    plan.targets.some(
      (target) =>
        result.folders.find((folder) => folder.workspaceID === target.id)?.path !==
        (plan.restored[target.id]?.path ?? options.paths?.[target.id] ?? target.binding.path),
    )
  )
    throw new ProjectDirectoryRecoveryChanged()
  return result
}
