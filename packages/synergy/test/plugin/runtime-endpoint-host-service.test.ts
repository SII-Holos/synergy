import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { capability, compilePluginManifest, definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { configureRuntimeEndpoint, peekRuntimeEndpointGeneration } from "../../src/util/runtime-endpoint"
import { tmpdir } from "../fixture/fixture"

function manifest(input: { capability?: boolean; contributionRequires?: boolean } = {}) {
  const compiled = compilePluginManifest(
    definePlugin({
      id: "endpoint-fixture",
      version: "1.0.0",
      description: "Runtime endpoint fixture",
      capabilities: [capability("runtime.endpoint.read")],
      contributions: [
        operation({
          id: "read-endpoint",
          type: "query",
          input: z.object({}),
          output: z.object({}),
          requires: input.contributionRequires === false ? [] : ["runtime.endpoint.read"],
          async handler() {
            return {}
          },
        }),
      ],
    }),
    { generation: "endpoint-generation" },
  )
  return input.capability === false ? { ...compiled, capabilities: [] } : compiled
}

async function invoke(input: {
  capability?: boolean
  contributionRequires?: boolean
  params?: Record<string, unknown>
}) {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const compiled = manifest(input)
  return executePluginHostService({
    pluginId: compiled.id,
    pluginDir: tmp.path,
    manifest: compiled,
    handlerId: "operation:read-endpoint",
    invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
    method: "runtime.endpoint.get" as never,
    params: input.params ?? {},
    signal: AbortSignal.timeout(5_000),
  })
}

describe("runtime endpoint Host Service", () => {
  afterEach(() => configureRuntimeEndpoint(undefined))

  test("requires both the capability and contribution requirement", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener-one" })
    await expect(invoke({ capability: false })).rejects.toThrow('does not declare capability "runtime.endpoint.read"')
    await expect(invoke({ contributionRequires: false })).rejects.toThrow(
      'does not require capability "runtime.endpoint.read"',
    )
  })

  test("returns only the loopback URL and opaque listener generation", async () => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 43123, generation: "listener-two" })
    await expect(invoke({})).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      generation: "listener-two",
    })
    await expect(invoke({ params: { token: "no" } })).rejects.toThrow("does not accept parameters")
  })

  test("treats wildcard binds as loopback-reachable and normalizes the URL", async () => {
    configureRuntimeEndpoint({ hostname: "0.0.0.0", port: 43123, generation: "listener-wildcard-v4" })
    await expect(invoke({})).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      generation: "listener-wildcard-v4",
    })
    configureRuntimeEndpoint({ hostname: "::", port: 43123, generation: "listener-wildcard-v6" })
    await expect(invoke({})).resolves.toEqual({
      url: "http://127.0.0.1:43123",
      generation: "listener-wildcard-v6",
    })
  })

  test("rejects unavailable and non-loopback listeners", async () => {
    configureRuntimeEndpoint(undefined)
    await expect(invoke({})).rejects.toMatchObject({ code: "PLUGIN_RUNTIME_ENDPOINT_UNAVAILABLE" })
    configureRuntimeEndpoint({ hostname: "192.168.1.5", port: 43123, generation: "listener-three" })
    expect(peekRuntimeEndpointGeneration()).toBeUndefined()
    await expect(invoke({})).rejects.toMatchObject({ code: "PLUGIN_RUNTIME_ENDPOINT_UNSAFE" })
  })
})
