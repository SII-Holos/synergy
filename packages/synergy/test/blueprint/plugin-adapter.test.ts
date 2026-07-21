import { describe, expect, test } from "bun:test"
import {
  BlueprintPluginErrorCode,
  startBlueprint,
  getBlueprint,
  cancelBlueprint,
} from "../../src/blueprint/plugin-adapter"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { hash as sha256 } from "@ericsanchezok/synergy-util/encode"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("Blueprint plugin adapter (protocol 5)", () => {
  test("start creates Blueprint atomically with Note + Session + Store", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const markdown = "# Plugin Blueprint\n\nTest content."
        const digest = await sha256(markdown)

        // This will fail because no real agents are registered — but we verify
        // that validation runs before trying to create resources.
        await expect(
          startBlueprint({
            context: {
              pluginId: "research-plugin",
              pluginGeneration: "generation-one",
              scopeId: ScopeContext.current.scope.id,
              parentSessionID: "parent-session",
              parentMessageID: "parent-message",
            },
            request: {
              title: "Plugin Blueprint",
              description: "Delegated through the new atomic start",
              markdown,
              sourceDigest: digest,
              correlationId: "corr-1",
              executionAgent: "nonexistent-agent",
              auditAgent: "nonexistent-auditor",
              budget: { maxRuntimeMs: 10000, maxIterations: 5 },
            },
          }),
        ).rejects.toThrow("Unknown execution agent")
      },
    })
  })

  test("rejects invalid budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const markdown = "# Test"
        const digest = await sha256(markdown)
        await expect(
          startBlueprint({
            context: {
              pluginId: "research-plugin",
              pluginGeneration: "gen",
              scopeId: ScopeContext.current.scope.id,
              parentSessionID: "p",
              parentMessageID: "m",
            },
            request: {
              title: "Test",
              markdown,
              sourceDigest: digest,
              correlationId: "c1",
              executionAgent: "agent1",
              auditAgent: "agent2",
              budget: { maxRuntimeMs: 0, maxIterations: 5 },
            },
          }),
        ).rejects.toThrow("maxRuntimeMs must be a positive integer")
      },
    })
  })

  test("rejects digest mismatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          startBlueprint({
            context: {
              pluginId: "research-plugin",
              pluginGeneration: "gen",
              scopeId: ScopeContext.current.scope.id,
              parentSessionID: "p",
              parentMessageID: "m",
            },
            request: {
              title: "Test",
              markdown: "# Real content",
              sourceDigest: "wrong-digest",
              correlationId: "c1",
              executionAgent: "agent1",
              auditAgent: "agent2",
              budget: { maxRuntimeMs: 1000, maxIterations: 1 },
            },
          }),
        ).rejects.toMatchObject({ code: BlueprintPluginErrorCode.DIGEST_MISMATCH })
      },
    })
  })

  test("get and cancel require owner match", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // get
        await expect(
          getBlueprint({
            scopeId: ScopeContext.current.scope.id,
            loopID: "nonexistent",
            pluginId: "p",
            pluginGeneration: "g",
          }),
        ).rejects.toMatchObject({ code: BlueprintPluginErrorCode.NOT_FOUND })

        // cancel on nonexistent
        await expect(
          cancelBlueprint({
            scopeId: ScopeContext.current.scope.id,
            loopID: "nonexistent",
            pluginId: "p",
            pluginGeneration: "g",
          }),
        ).rejects.toMatchObject({ code: BlueprintPluginErrorCode.NOT_FOUND })
      },
    })
  })

  test("rejects empty title/markdown/correlationId", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const base = {
          context: {
            pluginId: "p",
            pluginGeneration: "g",
            scopeId: ScopeContext.current.scope.id,
            parentSessionID: "ps",
            parentMessageID: "pm",
          } as const,
          request: {
            title: "T",
            markdown: "# M",
            sourceDigest: "",
            correlationId: "c1",
            executionAgent: "a1",
            auditAgent: "a2",
            budget: { maxRuntimeMs: 1000, maxIterations: 1 },
          },
        }

        await expect(
          startBlueprint({
            ...base,
            request: { ...base.request, title: "" },
          }),
        ).rejects.toThrow("title")

        await expect(
          startBlueprint({
            ...base,
            request: { ...base.request, markdown: "" },
          }),
        ).rejects.toThrow("markdown")

        await expect(
          startBlueprint({
            ...base,
            request: { ...base.request, correlationId: "" },
          }),
        ).rejects.toThrow("correlationId")
      },
    })
  })
})
