import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SandboxHost } from "@ericsanchezok/synergy-harness/sandbox/host"
import { READ_DENY_PATHS } from "@ericsanchezok/synergy-harness/sandbox/policy"
import { LinuxSandboxProfile } from "../sandbox/linux-profile"

export function executionSandbox(input: {
  home: string
  directory: string
  helper: string
  protectedRoots: string[]
}): SandboxHost.Host {
  fs.mkdirSync(input.directory, { recursive: true, mode: 0o711 })
  return {
    prepareWrapper(options) {
      if (options.sandboxMode === "none") return { command: options.command, args: options.args, sandboxed: false }
      const { profile, writableRoots } = LinuxSandboxProfile.compile(options, {
        home: input.home,
        readDenyPaths: [...READ_DENY_PATHS(input.home), ...input.protectedRoots, ...(options.dataDenyRoots ?? [])],
      })
      const filename = path.join(input.directory, `${randomUUID()}.json`)
      fs.writeFileSync(filename, JSON.stringify(profile), { mode: 0o444, flag: "wx" })
      return {
        command: input.helper,
        args: [
          "--sandbox-policy-cwd",
          options.workspace,
          "--permission-profile",
          filename,
          "--",
          options.command,
          ...options.args,
        ],
        sandboxed: true,
        tempPath: filename,
        writeFootprint: { kind: "roots", roots: [...writableRoots, path.join(options.workspace, ".synergy", "tmp")] },
      }
    },
    cleanupWrapper(wrapper) {
      if (wrapper.tempPath) fs.rmSync(wrapper.tempPath, { force: true })
    },
  }
}
