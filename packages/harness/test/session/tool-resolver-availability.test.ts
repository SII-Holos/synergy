import { describe, expect, mock, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../support/fixture"

const allowAllAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "full_access",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

const ephemeralTool: ToolResolver.EphemeralTool = {
  id: "ephemeral_probe",
  description: "Inspect a value",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
  async execute() {
    return { title: "probe", output: "ok" }
  },
}

function processor() {
  return {
    message: { id: "msg_availability", rootID: "msg_availability_root", parentID: "msg_availability_root" },
    partFromToolCall: () => undefined,
    beginExecution: () => undefined,
    executeOnce: (_callID: string, execute: () => Promise<unknown>) => execute(),
  } as any
}

describe("ToolResolver availability reuse", () => {
  test("collects tool definitions once when the caller supplies the availability it already resolved", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalTools = ToolRegistry.tools
    let collections = 0

    try {
      ;(ToolRegistry.tools as any) = mock(async () => {
        collections++
        return []
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const input = {
            agent: allowAllAgent,
            model,
            sessionID: "ses_availability_once",
            ephemeralTools: [ephemeralTool],
            userTools: { ephemeral_probe: true },
            includeMCP: false,
          }

          const availability = await ToolResolver.availability(input)
          expect(collections).toBe(1)
          expect(availability.visible.map((item) => item.id)).toEqual(["ephemeral_probe"])
          expect(availability.autoExpandable.size).toBe(0)

          const resolved = await ToolResolver.resolveWithAvailability(
            { ...input, processor: processor() },
            availability,
          )

          expect(collections).toBe(1)
          expect(resolved.definitions.map((item) => item.id)).toEqual(["ephemeral_probe"])
          expect(resolved.activeToolIDs).toEqual(["ephemeral_probe"])
          expect(Object.keys(resolved.executionTools)).toEqual(["ephemeral_probe"])
          expect(resolved.executorKinds).toEqual({ ephemeral_probe: "control_plane" })
          expect(resolved.autoExpandable).toBe(availability.autoExpandable)
        },
      })
    } finally {
      ;(ToolRegistry.tools as any) = originalTools
    }
  })

  test("collects its own definitions when no availability is supplied", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalTools = ToolRegistry.tools
    let collections = 0

    try {
      ;(ToolRegistry.tools as any) = mock(async () => {
        collections++
        return []
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: allowAllAgent,
            model,
            sessionID: "ses_availability_self",
            processor: processor(),
            ephemeralTools: [ephemeralTool],
            userTools: { ephemeral_probe: true },
            includeMCP: false,
          })

          expect(collections).toBe(1)
          expect(resolved.definitions.map((item) => item.id)).toEqual(["ephemeral_probe"])
        },
      })
    } finally {
      ;(ToolRegistry.tools as any) = originalTools
    }
  })
})
