import { createContext, useContext, type ParentProps } from "solid-js"
import type { ArtifactFile } from "../components/artifact-card-utils"

export type OpenableResource =
  | {
      kind: "artifact"
      file: ArtifactFile
      serverUrl?: string
    }
  | {
      kind: "workspace-file"
      path: string
      mime?: string
      filename?: string
    }
  | {
      kind: "url"
      url: string
      mime?: string
      filename?: string
    }

export interface ResourceOpenOptions {
  prefer?: "preview" | "workspace" | "external"
}

export interface ResourceOpenController {
  open(resource: OpenableResource, options?: ResourceOpenOptions): boolean
  openArtifact(file: ArtifactFile, options?: ResourceOpenOptions & { serverUrl?: string }): boolean
}

const ResourceOpenContext = createContext<ResourceOpenController>()

export function ResourceOpenProvider(props: ParentProps<{ value: ResourceOpenController }>) {
  return <ResourceOpenContext.Provider value={props.value}>{props.children}</ResourceOpenContext.Provider>
}

export function useResourceOpen() {
  return useContext(ResourceOpenContext)
}
