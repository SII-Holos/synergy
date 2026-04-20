import { InspireCache } from "./cache"
import { Log } from "../../util/log"

export namespace InspireResolve {
  const log = Log.create({ service: "inspire.resolve" })

  export async function workspace(input: string): Promise<{ id: string; name: string } | undefined> {
    if (input.startsWith("ws-")) return { id: input, name: input }
    const projects = await InspireCache.getProjects()
    for (const proj of projects) {
      for (const space of proj.space_list ?? []) {
        if (space.name === input || space.name.includes(input)) {
          return { id: space.id, name: space.name }
        }
      }
    }
    return undefined
  }

  export async function project(
    input: string,
    workspaceId?: string,
  ): Promise<{ id: string; name: string; en_name: string } | undefined> {
    if (input.startsWith("project-")) {
      const projects = await InspireCache.getProjects()
      const proj = projects.find((p: any) => p.id === input)
      return proj ? { id: proj.id, name: proj.name, en_name: proj.en_name } : { id: input, name: input, en_name: "" }
    }
    const projects = await InspireCache.getProjects()
    for (const proj of projects) {
      if (proj.name === input || proj.name.includes(input) || proj.en_name === input) {
        if (workspaceId) {
          const inSpace = (proj.space_list ?? []).some((s: any) => s.id === workspaceId)
          if (!inSpace) continue
        }
        return { id: proj.id, name: proj.name, en_name: proj.en_name }
      }
    }
    return undefined
  }

  export async function computeGroup(
    input: string,
    workspaceId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    if (input.startsWith("lcg-")) return { id: input, name: input }
    const info = await InspireCache.getClusterInfo(workspaceId)
    if (!info) return undefined
    for (const cg of info.compute_groups ?? []) {
      for (const lcg of cg.logic_compute_groups ?? []) {
        const name = lcg.logic_compute_group_name ?? ""
        const id = lcg.logic_compute_group_id ?? ""
        if (name === input || name.includes(input)) {
          return { id, name }
        }
      }
    }
    return undefined
  }

  export async function firstProject(
    workspaceId?: string,
  ): Promise<{ id: string; name: string; en_name: string } | undefined> {
    const projects = await InspireCache.getProjects()
    if (workspaceId) {
      for (const proj of projects) {
        const inSpace = (proj.space_list ?? []).some((s: any) => s.id === workspaceId)
        if (inSpace && proj.en_name !== "project-public" && proj.en_name !== "publiclow") {
          return { id: proj.id, name: proj.name, en_name: proj.en_name }
        }
      }
    }
    const nonPublic = projects.find((p: any) => p.en_name !== "project-public" && p.en_name !== "publiclow")
    return nonPublic ? { id: nonPublic.id, name: nonPublic.name, en_name: nonPublic.en_name } : undefined
  }

  export async function firstComputeGroup(workspaceId: string): Promise<{ id: string; name: string } | undefined> {
    const info = await InspireCache.getClusterInfo(workspaceId)
    if (!info) return undefined
    for (const cg of info.compute_groups ?? []) {
      for (const lcg of cg.logic_compute_groups ?? []) {
        if (lcg.logic_compute_group_id) {
          return { id: lcg.logic_compute_group_id, name: lcg.logic_compute_group_name ?? lcg.logic_compute_group_id }
        }
      }
    }
    return undefined
  }
}
