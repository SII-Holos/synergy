#!/usr/bin/env bun

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
  PluginBuildCommand,
  PluginCreateCommand,
  PluginDevCommand,
  PluginEntryCommand,
  PluginPackCommand,
  PluginPublishMarketCommand,
  PluginSignCommand,
  PluginTestCommand,
  PluginValidateCommand,
} from "./commands/index.js"

function assertBunRuntime() {
  if (!process.versions.bun) {
    throw new Error("synergy-plugin requires Bun. Install Bun from https://bun.sh and retry.")
  }
}

assertBunRuntime()

await yargs(hideBin(process.argv))
  .scriptName("synergy-plugin")
  .command(PluginCreateCommand)
  .command(PluginValidateCommand)
  .command(PluginDevCommand)
  .command(PluginBuildCommand)
  .command(PluginPackCommand)
  .command(PluginSignCommand)
  .command(PluginTestCommand)
  .command(PluginPublishMarketCommand)
  .command(PluginEntryCommand)
  .demandCommand(1)
  .strict()
  .help()
  .parse()
