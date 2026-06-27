#!/usr/bin/env bun

import { rewriteVersions } from "./shared/versions"

const version = process.env.SYNERGY_VERSION?.trim()
if (!version) {
  throw new Error("desktop-prepare-version requires SYNERGY_VERSION")
}

await rewriteVersions(version)
