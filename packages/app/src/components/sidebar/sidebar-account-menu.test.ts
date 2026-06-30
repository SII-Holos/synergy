import { describe, expect, test } from "bun:test"

const sidebar = await Bun.file(new URL("./sidebar.tsx", import.meta.url)).text()

describe("Sidebar account menu", () => {
  test("keeps local settings reachable when no Holos agent is connected", () => {
    const loggedInBranchStart = sidebar.indexOf("when={holos.state.identity.loggedIn}")

    expect(loggedInBranchStart).toBeGreaterThanOrEqual(0)

    const loggedInBranch = sidebar.slice(loggedInBranchStart)
    const fallback = loggedInBranch.match(/fallback=\{\s*<>\s*([\s\S]*?)\s*<\/>\s*\}\s*>\s*<button/)

    expect(fallback?.[1]).toContain("Create Agent")
    expect(fallback?.[1]).toContain("Import Agent")
    expect(fallback?.[1]).toContain('openSettings("general")')
    expect(fallback?.[1]).toContain('openSettings("providers")')
    expect(fallback?.[1]).toContain("openRepository")
  })
})
