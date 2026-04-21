import { Global } from "../../global"
import { InspireAPI } from "./api"
import { InspireAuth } from "./auth"
import { Log } from "../../util/log"

const TTL_MS = 5 * 60 * 1000

export namespace InspireCache {
  const log = Log.create({ service: "inspire.cache" })

  interface SpecCache {
    specId: string
    gpuCount: number
    cpuCount: number
    memGi: number
    gpuType: string
    resolvedAt: number
  }

  interface CacheData {
    projects: any[]
    workspaceInfo: Record<string, { clusterInfo?: any }>
    specCache: Record<string, SpecCache>
    updatedAt: number
  }

  let memory: CacheData | undefined

  function isStale(): boolean {
    return !memory || Date.now() - memory.updatedAt > TTL_MS
  }

  function specCacheKey(workspaceId: string, computeGroupId: string): string {
    return `${workspaceId}:${computeGroupId}`
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

  export function getCachedSpecId(workspaceId: string, computeGroupId: string): string | undefined {
    const key = specCacheKey(workspaceId, computeGroupId)
    return memory?.specCache[key]?.specId
  }

  export function setCachedSpecId(
    workspaceId: string,
    computeGroupId: string,
    specId: string,
    info?: { gpuCount?: number; cpuCount?: number; memGi?: number; gpuType?: string },
  ): void {
    if (!memory) memory = { projects: [], workspaceInfo: {}, specCache: {}, updatedAt: Date.now() }
    const key = specCacheKey(workspaceId, computeGroupId)
    memory.specCache[key] = {
      specId,
      gpuCount: info?.gpuCount ?? 0,
      cpuCount: info?.cpuCount ?? 0,
      memGi: info?.memGi ?? 0,
      gpuType: info?.gpuType ?? "",
      resolvedAt: Date.now(),
    }
  }

  export async function resolveSpecId(workspaceId: string, computeGroupId: string): Promise<string | undefined> {
    const cached = getCachedSpecId(workspaceId, computeGroupId)
    if (cached) return cached

    try {
      const { jobs } = await InspireAuth.withCookieRetry((cookie) =>
        InspireAPI.listJobsWithCookie(cookie, workspaceId, { pageSize: 50 }),
      )
      for (const job of jobs) {
        const specId = InspireAPI.extractSpecId(job)
        if (specId) {
          const gpuInfo = InspireAPI.extractGpuInfo(job)
          setCachedSpecId(workspaceId, computeGroupId, specId, {
            gpuCount: gpuInfo.gpu_count,
            gpuType: "",
          })
          return specId
        }
      }
    } catch (err) {
      log.warn("failed to resolve spec_id from job list", { workspaceId, error: String(err) })
    }

    return undefined
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
        workspaceInfo[wsId] = { clusterInfo }
      } catch (err) {
        log.warn("failed to fetch cluster info", { workspaceId: wsId, error: String(err) })
        workspaceInfo[wsId] = {}
      }
    }

    const prevSpecCache = memory?.specCache ?? {}
    memory = { projects, workspaceInfo, specCache: prevSpecCache, updatedAt: Date.now() }

    try {
      const filepath = Global.Path.cacheInspireResources
      await Bun.write(filepath, JSON.stringify(memory, null, 2))
    } catch {}
  }

  export function clear(): void {
    memory = undefined
  }
}
