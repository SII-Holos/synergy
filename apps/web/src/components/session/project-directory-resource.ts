import { createResource, type Accessor } from "solid-js"
import type { ProjectDirectories, SynergyClient } from "@ericsanchezok/synergy-sdk/client"

export type ProjectDirectoryOwner = { client: SynergyClient; scopeID: string }
export type ProjectDirectorySnapshot = ProjectDirectoryOwner & { data: ProjectDirectories | undefined; error: string }

export function createProjectDirectoryResource(owner: Accessor<ProjectDirectoryOwner | false>) {
  return createResource(
    owner,
    async ({ client, scopeID }): Promise<ProjectDirectorySnapshot | null> => {
      try {
        return {
          client,
          scopeID,
          data: (await client.project.directories({ scopeID }, { throwOnError: true })).data,
          error: "",
        }
      } catch (error) {
        return { client, scopeID, data: undefined, error: error instanceof Error ? error.message : String(error) }
      }
    },
    { initialValue: null },
  )
}
