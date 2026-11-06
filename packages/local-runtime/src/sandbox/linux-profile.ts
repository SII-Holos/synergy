import fs from "node:fs"
import type { PrepareLinuxWrapperOpts } from "@ericsanchezok/synergy-harness/sandbox/types"
import {
  DEFAULT_PROTECTED_PATHS,
  expandGitProtectedSubpaths,
  uniqueRoots,
} from "@ericsanchezok/synergy-harness/sandbox/policy"

export namespace LinuxSandboxProfile {
  export function compile(options: PrepareLinuxWrapperOpts, host: { home: string; readDenyPaths: string[] }) {
    const writableRoots =
      options.sandboxMode === "workspace_write" ? [options.workspace, ...(options.extraWritableRoots ?? [])] : []
    const protectedPaths = expandGitProtectedSubpaths(
      uniqueRoots([...DEFAULT_PROTECTED_PATHS(host.home, options.workspace), ...(options.protectedPaths ?? [])]),
    ).filter((filename) => fs.existsSync(filename))
    return {
      writableRoots,
      profile: {
        fileSystem: {
          workspace: options.workspace,
          readableRoots: ["/"],
          writableRoots,
          readOnlySubpaths: protectedPaths,
          protectedPaths,
          protectedMetadataNames: [".agents", ".codex"],
          dataDenyRoots: host.readDenyPaths,
          includePlatformDefaults: true,
        },
        network: { mode: options.networkMode ?? "restricted", allowLocalBinding: false, allowedUnixSockets: [] },
      },
    }
  }
}
