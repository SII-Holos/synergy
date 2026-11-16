import path from "node:path"
import type { RuntimeHost } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { readExistingIdentityFile } from "@ericsanchezok/synergy-util/filesystem-identity"
import { identifyDirectory } from "./identity"

export { registerNativeWorkspaceCleanup } from "./move"

export async function createWorkspaceCleanupHost(input: {
  home: string
  root: string
  env?: Readonly<Record<string, string | undefined>>
}): Promise<RuntimeHost> {
  if (!path.isAbsolute(input.home) || !path.isAbsolute(input.root))
    throw new Error("Workspace cleanup requires its existing absolute Home")
  const identity = await readExistingIdentityFile(path.join(input.root, "workspace-host"))
  return {
    home: input.home,
    root: input.root,
    env: { ...input.env, SYNERGY_HOME: input.home, SYNERGY_RUNTIME_ROOT: input.root },
    workspaceLocation: {
      hostID: async () => identity,
      identify: identifyDirectory,
    },
  }
}
