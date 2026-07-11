import { describe, expect, test } from "bun:test"
import { applyPluginHookResult, PluginHookDeniedError, sortPluginHookHandlers } from "../../src/plugin/lifecycle"

describe("plugin hook contract", () => {
  test("orders handlers by priority, plugin id and contribution id", () => {
    const ordered = sortPluginHookHandlers([
      { plugin: { id: "zeta" }, contribution: { id: "a", priority: 0 } },
      { plugin: { id: "alpha" }, contribution: { id: "b", priority: 0 } },
      { plugin: { id: "alpha" }, contribution: { id: "a", priority: 0 } },
      { plugin: { id: "omega" }, contribution: { id: "first", priority: -1 } },
    ])
    expect(ordered.map((item) => `${item.contribution.priority}:${item.plugin.id}:${item.contribution.id}`)).toEqual([
      "-1:omega:first",
      "0:alpha:a",
      "0:alpha:b",
      "0:zeta:a",
    ])
  })

  test("keeps observer output immutable, transforms values and propagates guard denial", () => {
    expect(applyPluginHookResult({ name: "observe", mode: "observer" }, { count: 1 }, { count: 99 })).toEqual({
      count: 1,
    })
    expect(applyPluginHookResult({ name: "transform", mode: "transform" }, 1, 2)).toBe(2)
    expect(applyPluginHookResult({ name: "guard", mode: "guard" }, "original", { allow: true, value: "allowed" })).toBe(
      "allowed",
    )
    expect(() =>
      applyPluginHookResult({ name: "guard", mode: "guard" }, "original", { allow: false, reason: "blocked" }),
    ).toThrow(PluginHookDeniedError)
  })
})
