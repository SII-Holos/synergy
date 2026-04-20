import { Global } from "../../global"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { Log } from "../../util/log"
import type { InspireTypes } from "./types"

const TTL_MS = 5 * 60 * 1000

export namespace InspireCache {
  const log = Log.create({ service: "inspire.cache" })

  interface CacheData {
    projects: any[]
    workspaceInfo: Record<string, { clusterInfo?: any; specs: Record<string, any[]> }>
    updatedAt: number
  }

  let memory: CacheData | undefined

  function isStale(): boolean {
    return !memory || Date.now() - memory.updatedAt > TTL_MS
  }

  export async function getProjects(forceRefresh?: boolean): Promise<any[]> {
    if (!forceRefresh && !isStale() && memory) return memory.projects
    await refresh()
    return memory!.projects
  }

  export async function getClusterInfo(workspaceId: string, forceRefresh?: boolean): Promise<any> {
    if (!forceRefresh && !isStale() && memory?.workspaceInfo[workspaceId]?.clusterInfo) {
      return memory.workspaceInfo[workspaceId].clusterInfo
    }
    await refresh()
    return memory?.workspaceInfo[workspaceId]?.clusterInfo
  }

  export async function getSpecs(workspaceId: string, computeGroupId: string, forceRefresh?: boolean): Promise<any[]> {
    if (!forceRefresh && !isStale() && memory?.workspaceInfo[workspaceId]?.specs[computeGroupId]) {
      return memory.workspaceInfo[workspaceId].specs[computeGroupId]
    }

    let token: string
    try {
      token = await InspireAuth.requireToken()
    } catch {
      return []
    }

    try {
      const specs = await InspireAPI.listSpecs(token, computeGroupId)
      if (!memory) memory = { projects: [], workspaceInfo: {}, updatedAt: Date.now() }
      if (!memory.workspaceInfo[workspaceId]) memory.workspaceInfo[workspaceId] = { specs: {} }
      memory.workspaceInfo[workspaceId].specs[computeGroupId] = specs
      return specs
    } catch (err) {
      log.warn("failed to fetch specs", { computeGroupId, error: String(err) })
      return []
    }
  }

  export async function refresh(): Promise<void> {
    const projects = await InspireAuth.withCookieRetry((cookie) => InspireAPI.listProjects(cookie))

    const workspaceIds = new Set<string>()
    for (const proj of projects) {
      for (const space of proj.space_list ?? []) {
        workspaceIds.add(space.id)
      }
    }

    const workspaceInfo: CacheData["workspaceInfo"] = {}
    for (const wsId of workspaceIds) {
      try {
        const clusterInfo = await InspireAuth.withCookieRetry((cookie) => InspireAPI.getClusterBasicInfo(cookie, wsId))
        workspaceInfo[wsId] = { clusterInfo, specs: {} }
      } catch (err) {
        log.warn("failed to fetch cluster info", { workspaceId: wsId, error: String(err) })
        workspaceInfo[wsId] = { specs: {} }
      }
    }

    memory = { projects, workspaceInfo, updatedAt: Date.now() }

    try {
      const filepath = Global.Path.cacheInspireResources
      await Bun.write(filepath, JSON.stringify(memory, null, 2))
    } catch {}
  }

  export function clear(): void {
    memory = undefined
  }
}
