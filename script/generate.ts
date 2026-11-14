#!/usr/bin/env bun

import { $ } from "bun"
import { writeFile } from "fs/promises"
import { generateOpenApi, generateOrganizationOpenApi } from "./generate-openapi"

await $`bun ./packages/sdk/js/script/build.ts`

await writeFile("packages/sdk/openapi.json", await generateOpenApi())
await writeFile("packages/sdk/organization.openapi.json", await generateOrganizationOpenApi())

await $`bun prettier --cache --cache-strategy content --write packages/sdk/openapi.json`
await $`bun prettier --cache --cache-strategy content --write packages/sdk/organization.openapi.json`
