import path from "node:path"
import fs from "node:fs/promises"
import { runCli } from "@ericsanchezok/synergy-cli/main"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { standaloneCommands } from "../../src/cli-adapter"
import { registerSessionSchema } from "../../src/session-schema"

const directory = process.env.SYNERGY_TEST_CLEANUP_COORDINATOR
const root = process.env.SYNERGY_TEST_ROOT
if (!directory || !root || !path.isAbsolute(directory))
  throw new Error("Cleanup fixture requires its original private coordinator")
const [actualDirectory, actualRoot] = await Promise.all([fs.realpath(directory), fs.realpath(root)])
if (!actualDirectory.startsWith(actualRoot + path.sep))
  throw new Error("Cleanup fixture requires its original private coordinator")
const coordinator = new WorkspaceCoordinator({ directory: actualDirectory })
await runCli({
  name: "synergy-org-runtime",
  commandsOnly: true,
  register: registerSessionSchema,
  commands: await standaloneCommands({
    async cleanupRuntime(input) {
      const { openHandoffCleanup } = await import("../../src/handoff-cleanup-runtime")
      return openHandoffCleanup(input, { workspaceCoordinator: coordinator })
    },
  }),
  runtimeFactory: async () => {
    throw new Error("Cleanup must not open an ordinary Agent Runtime")
  },
})
