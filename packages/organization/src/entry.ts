#!/usr/bin/env bun
import { runCli } from "@ericsanchezok/synergy-cli/main"
import { standaloneCommands } from "./cli-adapter"
import { registerConfig } from "./config-schema"

await runCli({
  name: "synergy-org",
  commandsOnly: true,
  register: registerConfig,
  commands: await standaloneCommands(),
  runtimeFactory: async () => {
    throw new Error("Organization service commands own their Runtime lifecycle")
  },
})
