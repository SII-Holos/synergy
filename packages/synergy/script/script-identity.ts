#!/usr/bin/env bun

import { $ } from "bun"
import {
  computeDevVersion,
  computeStableVersion,
  npmVersionExists,
  retry,
} from "../../../script/release/shared/runtime"

const env = {
  SYNERGY_CHANNEL: process.env["SYNERGY_CHANNEL"],
  SYNERGY_BUMP: process.env["SYNERGY_BUMP"],
  SYNERGY_VERSION: process.env["SYNERGY_VERSION"],
}
const CHANNEL = await (async () => {
  if (env.SYNERGY_CHANNEL) return env.SYNERGY_CHANNEL
  if (env.SYNERGY_BUMP) return "latest"
  if (env.SYNERGY_VERSION && !env.SYNERGY_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim().replace(/\//g, "-"))
})()
const IS_PREVIEW = CHANNEL !== "latest"

// Version derivation lives in script/release/shared/runtime.ts (canonical
// release path); importing it also enforces the root-pinned Bun version.
const VERSION = await (async () => {
  if (env.SYNERGY_VERSION) return env.SYNERGY_VERSION
  if (IS_PREVIEW) return computeDevVersion(CHANNEL)
  return computeStableVersion(env.SYNERGY_BUMP?.toLowerCase() ?? "patch")
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  npmVersionExists,
  retry,
}
console.log(`synergy script`, JSON.stringify(Script, null, 2))
