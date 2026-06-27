import { describe, expect, test } from "bun:test"
import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import {
  productUpdateSurface,
  serverUpdateActionState,
  serverUpdateStatusCopy,
  webUpdateNeedsRefresh,
  webVersionStatus,
} from "./product-update-logic"

describe("General panel product update behavior", () => {
  test("uses the desktop update surface only when the bridge exists", () => {
    expect(productUpdateSurface({ desktopUpdate: {} })).toBe("desktop")
    expect(productUpdateSurface({})).toBe("web")
  })

  test("prompts Web refresh when the server version differs", () => {
    expect(webUpdateNeedsRefresh("1.2.3", "1.2.4")).toBe(true)
    expect(webUpdateNeedsRefresh("1.2.3", "1.2.3")).toBe(false)
    expect(webUpdateNeedsRefresh(undefined, "1.2.4")).toBe(false)
    expect(webVersionStatus("1.2.3", "1.2.4")).toBe("Server 1.2.4 is newer than this Web client.")
  })

  test("shows server update actions only for a managed daemon", () => {
    expect(serverUpdateActionState(status({ capability: "managed", phase: "available" }))).toBe("start")
    expect(serverUpdateActionState(status({ capability: "managed", phase: "updating" }))).toBe("reconnecting")
    expect(serverUpdateActionState(status({ capability: "not-managed", phase: "available" }))).toBe("hidden")
    expect(serverUpdateActionState(status({ capability: "remote", phase: "available" }))).toBe("hidden")
  })

  test("keeps ordinary terminal-run server copy non-actionable", () => {
    expect(serverUpdateStatusCopy(status({ capability: "not-managed", phase: "idle" }))).toBe(
      "Server runtime is managed outside this Web client.",
    )
  })
})

function status(patch: Partial<ServerUpdateStatus>): ServerUpdateStatus {
  return {
    capability: "managed",
    phase: "idle",
    currentVersion: "1.2.3",
    latestVersion: null,
    updateAvailable: false,
    message: "ok",
    error: null,
    ...patch,
  }
}
