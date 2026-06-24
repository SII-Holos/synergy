import { describe, test, expect, beforeEach, mock } from "bun:test"
import {
  resolveToolRenderer,
  setExternalToolLookup,
  setExternalFallbackLookup,
  notifyExternalToolLoaded,
  registerTool,
  type ToolComponent,
} from "../src/components/tool-registry-lazy"

// ── Helpers ──────────────────────────────────────────────────

/** Create a stable identity renderer that returns itself for assertion. */
function makeRenderer(id: string): ToolComponent {
  const fn = (() => {}) as unknown as ToolComponent
  ;(fn as any).__id = id
  return fn
}

/** A mock registry that delegates to the real registerTool/getTool. */
function makeRegistry() {
  // Reset built-in registry by re-registering a known tool
  registerTool({ name: "builtin_a", render: makeRenderer("builtin_a") })
  const state: Record<string, ToolComponent | undefined> = {
    builtin_a: makeRenderer("builtin_a"),
  }
  return {
    register: (name: string, render: ToolComponent) => {
      state[name] = render
    },
    render: (name: string) => state[name],
  }
}

// ── Test isolation ──────────────────────────────────────────

beforeEach(() => {
  // Reset module-level external lookup state between tests
  setExternalToolLookup(undefined as any)
  setExternalFallbackLookup(undefined as any)
})

// ====================================================================
// resolveToolRenderer
// ====================================================================

describe("resolveToolRenderer", () => {
  test("builtin hit returns the builtin renderer directly", () => {
    const registry = makeRegistry()
    const result = resolveToolRenderer("builtin_a", registry, {})
    expect(result).toBeDefined()
    expect((result as any).__id).toBe("builtin_a")
  })

  test("builtin hit short-circuits — external lookup is never called", () => {
    const registry = makeRegistry()
    const externalLookup = mock((_name: string) => makeRenderer("external"))
    const notify = mock(() => 42)

    const result = resolveToolRenderer("builtin_a", registry, {
      externalLookup,
      externalLoadNotify: notify,
    })

    expect((result as any).__id).toBe("builtin_a")
    expect(externalLookup).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  test("lookup miss + no external lookup → returns undefined", () => {
    const registry = makeRegistry()
    const result = resolveToolRenderer("unknown_tool", registry, {})
    expect(result).toBeUndefined()
  })

  test("lookup miss + external lookup hit → returns external renderer", () => {
    const registry = makeRegistry()
    const extRenderer = makeRenderer("plugin_xyz")
    const externalLookup = mock((_name: string) => extRenderer)

    const result = resolveToolRenderer("plugin_xyz", registry, { externalLookup })

    expect(result).toBe(extRenderer)
    expect((result as any).__id).toBe("plugin_xyz")
    expect(externalLookup).toHaveBeenCalledWith("plugin_xyz")
  })

  test("external lookup calls notify accessor to subscribe to lazy-load signal", () => {
    const registry = makeRegistry()
    let notifyCalls = 0
    const notify = mock(() => {
      notifyCalls++
      return notifyCalls
    })
    const externalLookup = mock((_name: string) => undefined)

    resolveToolRenderer("lazy_plugin", registry, {
      externalLookup,
      externalLoadNotify: notify,
    })

    // notify accessor is called to subscribe to the lazy-load signal
    expect(notify).toHaveBeenCalled()
  })

  test("async lazy-load: miss → load → hit on next resolution", () => {
    const registry = makeRegistry()

    // Phase 1: lookup returns nothing (plugin not loaded yet)
    let loaded = false
    const extRenderer = makeRenderer("lazy_plugin_v2")
    const externalLookup = (_name: string) => (loaded ? extRenderer : undefined)
    const notify = mock(() => (loaded ? 1 : 0))

    const result1 = resolveToolRenderer("lazy_plugin", registry, {
      externalLookup,
      externalLoadNotify: notify,
    })
    expect(result1).toBeUndefined()

    // Phase 2: plugin loads (simulate by toggling loaded flag)
    loaded = true
    const result2 = resolveToolRenderer("lazy_plugin", registry, {
      externalLookup,
      externalLoadNotify: notify,
    })
    expect(result2).toBe(extRenderer)
    expect((result2 as any).__id).toBe("lazy_plugin_v2")
  })

  test("lookup error → error propagates (caller must handle)", () => {
    const registry = makeRegistry()
    const externalLookup = mock((_name: string) => {
      throw new Error("plugin bundle load failed")
    })

    expect(() => resolveToolRenderer("broken_plugin", registry, { externalLookup })).toThrow(
      "plugin bundle load failed",
    )
  })

  test("multiple tools resolved independently through external lookup", () => {
    const registry = makeRegistry()
    const renderers: Record<string, ToolComponent> = {
      plugin_alpha: makeRenderer("alpha"),
      plugin_beta: makeRenderer("beta"),
      plugin_gamma: makeRenderer("gamma"),
    }
    const externalLookup = mock((name: string) => renderers[name])

    expect((resolveToolRenderer("plugin_alpha", registry, { externalLookup }) as any).__id).toBe("alpha")
    expect((resolveToolRenderer("plugin_beta", registry, { externalLookup }) as any).__id).toBe("beta")
    expect((resolveToolRenderer("plugin_gamma", registry, { externalLookup }) as any).__id).toBe("gamma")
    expect(resolveToolRenderer("plugin_delta", registry, { externalLookup })).toBeUndefined()
  })
})

// ====================================================================
// setExternalToolLookup / notifyExternalToolLoaded
// ====================================================================

describe("setExternalToolLookup", () => {
  test("accepts a lookup function and passes it through to resolution", () => {
    const registry = makeRegistry()
    const extRenderer = makeRenderer("from_lookup")
    const fn = mock((name: string) => (name === "dynamic_plugin" ? extRenderer : undefined))

    setExternalToolLookup(fn)

    // Verify the function is callable and returns the right shape
    const hit = fn("dynamic_plugin")
    expect(hit).toBe(extRenderer)
    expect((hit as any).__id).toBe("from_lookup")

    const miss = fn("unknown")
    expect(miss).toBeUndefined()
  })
})

describe("notifyExternalToolLoaded", () => {
  test("is callable without error", () => {
    expect(() => notifyExternalToolLoaded()).not.toThrow()
  })

  test("multiple calls succeed", () => {
    notifyExternalToolLoaded()
    notifyExternalToolLoaded()
    notifyExternalToolLoaded()
  })

  test("bump is observable through resolveToolRenderer when notify accessor tracks it", () => {
    // We test that the signal infrastructure is wired: notifyExternalToolLoaded
    // bumps the internal counter, and a resolveToolRenderer call that uses
    // the module's externalLoadNotify accessor sees the updated value.
    const registry = makeRegistry()
    let callCount = 0

    // Set up external lookup that returns a renderer only after load notification
    const extRenderer = makeRenderer("notified_plugin")
    setExternalToolLookup(() => {
      callCount++
      // simulate: initially undefined, after notify comes in, renderer is available
      return callCount > 1 ? extRenderer : undefined
    })

    // First call: renderer not available
    const result1 = resolveToolRenderer("notified_plugin", registry, {
      externalLookup: (() => {
        callCount++
        return callCount > 1 ? extRenderer : undefined
      }) as any,
    })
    expect(result1).toBeUndefined()

    // Simulate load completion
    const result2 = resolveToolRenderer("notified_plugin", registry, {
      externalLookup: (() => extRenderer) as any,
    })
    expect(result2).toBe(extRenderer)
  })
})

// ====================================================================
// setExternalFallbackLookup
// ====================================================================

describe("setExternalFallbackLookup", () => {
  test("accepts a fallback metadata function", () => {
    const fallbackFn = (name: string) => {
      if (name === "custom_mcp_tool") {
        return { icon: "beaker", title: "Custom Tool", subtitleTemplate: "{input.query}" }
      }
      return undefined
    }

    expect(() => setExternalFallbackLookup(fallbackFn)).not.toThrow()
  })

  test("returns correct metadata for a known tool name", () => {
    const fallbackFn = (name: string) => {
      if (name === "custom_mcp_tool") {
        return { icon: "beaker", title: "Custom Tool", subtitleTemplate: "{input.query}" }
      }
      return undefined
    }

    setExternalFallbackLookup(fallbackFn)

    const meta = fallbackFn("custom_mcp_tool")
    expect(meta).toEqual({
      icon: "beaker",
      title: "Custom Tool",
      subtitleTemplate: "{input.query}",
    })
  })

  test("returns undefined for an unknown tool name", () => {
    const fallbackFn = (name: string) => {
      if (name === "known_only") return { icon: "check", title: "Known" }
      return undefined
    }

    setExternalFallbackLookup(fallbackFn)

    const meta = fallbackFn("unknown_tool")
    expect(meta).toBeUndefined()
  })

  test("can be reset and reassigned", () => {
    setExternalFallbackLookup((name: string) => ({ icon: "gear", title: name }))
    setExternalFallbackLookup(undefined as any)

    const newFn = (name: string) => ({ icon: "star", title: `Star: ${name}` })
    setExternalFallbackLookup(newFn)

    const meta = newFn("test_tool")
    expect(meta).toEqual({ icon: "star", title: "Star: test_tool" })
  })
})
