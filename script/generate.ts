#!/usr/bin/env bun

import { $ } from "bun"
import { writeFile } from "fs/promises"
import { generateOpenApi } from "./generate-openapi"

await $`bun ./packages/sdk/js/script/build.ts`

await writeFile("packages/sdk/openapi.json", await generateOpenApi())

await $`bun prettier --cache --cache-strategy content --write packages/sdk/openapi.json`
