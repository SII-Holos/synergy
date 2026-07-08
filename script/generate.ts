#!/usr/bin/env bun

import { $ } from "bun"
import { writeFile } from "fs/promises"

await $`bun ./packages/sdk/js/script/build.ts`

await writeFile("packages/sdk/openapi.json", await $`bun dev generate`.cwd("packages/synergy").text())

await $`bun run ./script/format.ts`
