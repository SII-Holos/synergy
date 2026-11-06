import { describe, expect, test } from "bun:test"
import { resolvePluginScopeKey } from "../../src/plugin/scope-key"

describe("plugin route scope", () => {
  test("prefers the active directory route over a plugin-page Scope query", () => {
    expect(resolvePluginScopeKey("aG9tZQ==", "?_scope=cHJvamVjdA%3D%3D")).toBe("home")
  })

  test("uses the plugin-page Scope query when no directory route is active", () => {
    expect(resolvePluginScopeKey(undefined, "?_scope=cHJvamVjdA%3D%3D")).toBe("project")
  })

  test("falls back to the home Scope", () => {
    expect(resolvePluginScopeKey(undefined, "")).toBe("home")
  })
})
