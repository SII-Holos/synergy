#!/usr/bin/env bun

import { fileURLToPath } from "url"
const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $, file } from "bun"
import path from "path"
import { writeFile } from "fs/promises"

import { createClient } from "@hey-api/openapi-ts"

type OpenApiSchema = Record<string, unknown>

type OpenApiParameter = {
  in: "query" | "path" | "header" | "cookie"
  name: string
  required?: boolean
  schema: OpenApiSchema
}

type OpenApiParameterRef = { $ref: string }

type OpenApiOperation = {
  operationId?: string
  parameters?: Array<OpenApiParameter | OpenApiParameterRef>
}

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: { parameters?: Record<string, OpenApiParameter | OpenApiParameterRef> }
}

const performanceQueryParameters: Record<string, OpenApiParameter[]> = {
  PerformanceSummaryQuery: [
    query("windowMs", { type: "integer", minimum: 1000, maximum: 86400000 }),
    query("includeInactive", { type: "boolean", default: false }),
    query("scopeID", { type: "string" }),
  ],
  PerfTimelineQuery: [
    query("from", { type: "string" }),
    query("to", { type: "string" }),
    query("bucketMs", { type: "integer", minimum: 1000, maximum: 3600000 }),
    query("metric", { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }),
    query("scopeID", { type: "string" }),
    query("sessionID", { type: "string" }),
    query("tool", { type: "string" }),
    query("providerID", { type: "string" }),
    query("module", { $ref: "#/components/schemas/PerfModule" }),
    query("windowMs", { type: "integer", minimum: 1 }),
  ],
  PerfTraceListQuery: [
    query("from", { type: "string" }),
    query("to", { type: "string" }),
    query("limit", { type: "integer", minimum: 1, maximum: 200 }),
    query("cursor", { type: "string" }),
    query("kind", {
      enum: ["request", "session", "agent", "tool", "provider", "runtime", "storage", "frontend"],
      type: "string",
    }),
    query("status", { $ref: "#/components/schemas/PerfSpanStatus" }),
    query("minDurationMs", { type: "number", minimum: 0 }),
    query("scopeID", { type: "string" }),
    query("sessionID", { type: "string" }),
  ],
  PerformanceTraceDetailQuery: [
    query("includeEvents", { type: "boolean", default: true }),
    query("includeAttributes", { type: "boolean", default: true }),
    query("maxEvents", { type: "integer", minimum: 1, maximum: 2000 }),
  ],
  PerformanceIssuesQuery: [
    query("status", { $ref: "#/components/schemas/PerfIssueStatus", default: "open" }),
    query("severity", { $ref: "#/components/schemas/PerfIssueSeverity" }),
    query("module", { $ref: "#/components/schemas/PerfModule" }),
    query("limit", { type: "integer", minimum: 1, maximum: 200 }),
  ],
}

function query(name: string, schema: OpenApiSchema): OpenApiParameter {
  return { in: "query", name, schema }
}

async function prepareSdkOpenApi() {
  const openApiPath = path.join(dir, "openapi.json")
  const spec = (await file(openApiPath).json()) as OpenApiDocument
  expandPerformanceQueryParameters(spec)
  removeExpandedPerformanceParameterComponents(spec)
  const performanceConfig = spec.paths?.["/global/performance/config"]
  if (!performanceConfig?.get || !performanceConfig.patch) {
    throw new Error("Missing performance config routes in generated OpenAPI document.")
  }
  performanceConfig.get.operationId = "performance.performanceConfig.get"
  performanceConfig.patch.operationId = "performance.performanceConfig.update"
  await writeFile(openApiPath, JSON.stringify(spec))
}

function expandPerformanceQueryParameters(spec: OpenApiDocument) {
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      operation.parameters = operation.parameters?.flatMap(
        (parameter): Array<OpenApiParameter | OpenApiParameterRef> => {
          if (!("$ref" in parameter)) return [parameter]
          const name = parameter.$ref.split("/").at(-1)
          if (!name) return [parameter]
          return performanceQueryParameters[name] ?? [parameter]
        },
      )
    }
  }
}

function removeExpandedPerformanceParameterComponents(spec: OpenApiDocument) {
  for (const name of Object.keys(performanceQueryParameters)) delete spec.components?.parameters?.[name]
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
