#!/usr/bin/env bun

import { fileURLToPath } from "url"
const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $, file } from "bun"
import path from "path"
import { writeFile } from "fs/promises"

import { createClient } from "@hey-api/openapi-ts"

type OpenApiDocument = {
  paths?: Record<string, Record<string, { operationId?: string }>>
}

async function prepareSdkOpenApi() {
  const openApiPath = path.join(dir, "openapi.json")
  const spec = (await file(openApiPath).json()) as OpenApiDocument
  const performanceConfig = spec.paths?.["/global/performance/config"]
  if (!performanceConfig?.get || !performanceConfig.patch) {
    throw new Error("Missing performance config routes in generated OpenAPI document.")
  }
  performanceConfig.get.operationId = "performance.performanceConfig.get"
  performanceConfig.patch.operationId = "performance.performanceConfig.update"
  await writeFile(openApiPath, JSON.stringify(spec))
}

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../synergy"))
await prepareSdkOpenApi()

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "SynergyClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
