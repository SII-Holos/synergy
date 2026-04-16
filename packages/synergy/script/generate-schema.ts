#!/usr/bin/env bun

import z from "zod"
import { Config } from "../src/config/config"
import path from "path"

const schema = z.toJSONSchema(Config.Info, { unrepresentable: "any" }) as Record<string, any>

// Strip internal/unstable fields from the public schema.
// The runtime still accepts these fields for backwards compatibility, but they are not
// advertised to users via JSON Schema autocomplete.
// - keybinds: internal keyboard binding map
// - experimental: unstable feature flags, not ready for public use
const HIDDEN_FIELDS = ["keybinds", "experimental"]
if (schema.properties) {
  for (const field of HIDDEN_FIELDS) {
    delete schema.properties[field]
  }
}

const outPath = path.resolve(import.meta.dir, "../schema/config.schema.json")
await Bun.write(outPath, JSON.stringify(schema, null, 2) + "\n")
console.log(`wrote config schema to ${outPath}`)
