#!/usr/bin/env bun
import { runCli } from "@ericsanchezok/synergy-cli/main"
import { standaloneCommands } from "./cli-adapter"
import { registerSessionSchema } from "./session-schema"

await runCli({
  name: "synergy-org-runtime",
  commandsOnly: true,
  register: registerSessionSchema,
  commands: await standaloneCommands(),
  runtimeFactory: async () => {
    throw new Error("Machine commands own their enrolled Runtime lifecycle")
  },
})
