import { expect, test } from "bun:test"
import { registerBrowser, disposeBrowser } from "../src/register"
import { BrowserRuntime } from "../src/runtime"
import { BrowserStorage } from "../src/storage"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"

test("Browser registration creates suspended owner state and disposes without launching Chromium", async () => {
  registerBrowser()
  registerBrowser()
  expect(MigrationRegistry.list().has("browser")).toBe(true)
  expect(ToolRegistry.toolProviderIDs().filter((id) => id === "browser")).toHaveLength(1)
  const owner = {
    mode: "session" as const,
    scopeID: "scope-registration",
    sessionID: "session-registration",
    directory: "/tmp",
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
})
