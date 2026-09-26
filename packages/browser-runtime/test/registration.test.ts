import { expect, test } from "bun:test"
import { registerBrowser, disposeBrowser } from "../src/register"
import { BrowserRuntime } from "../src/runtime"
import { BrowserStorage } from "../src/storage"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
const runtime = await testRuntime()

test("Browser registration creates suspended owner state and disposes without launching Chromium", () =>
  runtime.run(async () => {
    registerBrowser()
    registerBrowser()
    expect(MigrationRegistry.list().has("browser")).toBe(true)
    expect(ToolRegistry.toolProviderIDs().filter((id) => id === "browser")).toHaveLength(1)
    const stored = await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({}) })
    const owner = {
      mode: "session" as const,
      scopeID: stored.scope.id,
      sessionID: stored.id,
      directory: null,
    }
    await BrowserStorage.save(owner, {
      status: "suspended",
      page: { id: "page-registration", url: "https://example.com/", title: "Research" },
      timestamp: Date.now(),
    })
    const session = await BrowserRuntime.getOrCreateSession(owner)
    expect(session.status).toBe("suspended")
    expect(session.page).toBeNull()
    expect(BrowserRuntime.resourceStats()).toMatchObject({ ownerCount: 1, activePageCount: 0, processCount: 0 })
    await disposeBrowser()
    await disposeBrowser()
    expect(BrowserRuntime.resourceStats()).toMatchObject({ ownerCount: 0, activePageCount: 0, processCount: 0 })
    expect((await BrowserStorage.load(owner))?.page?.title).toBe("Research")
  }))

afterRuntimeTests(() => runtime.close())
