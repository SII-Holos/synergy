import { RuntimeContext } from "../lifecycle/context"

export interface WorkspaceLocationSource {
  hostID(): Promise<string>
  identify(directory: string, allowMissing?: boolean): Promise<{ path: string; physicalID?: string }>
}

export namespace WorkspaceLocation {
  export function source(): WorkspaceLocationSource {
    const source = RuntimeContext.current().host.workspaceLocation
    if (!source) throw new Error("The Runtime host does not provide local workspace locations")
    return source
  }
}
