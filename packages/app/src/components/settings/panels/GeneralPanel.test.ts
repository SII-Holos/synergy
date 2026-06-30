import { describe, expect, test } from "bun:test"
import type { ServerUpdateStatus } from "@ericsanchezok/synergy-sdk/client"
import type { DesktopUpdateStatus } from "@/context/platform"
import {
  productUpdateNotice,
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

  test("surfaces desktop update actions and progress", () => {
    expect(
      productUpdateNotice({
        desktopStatus: desktopStatus({ phase: "ready", availableVersion: "2.0.0" }),
        serverStatus: null,
        appVersion: "1.2.3",
        serverVersion: "1.2.3",
        busy: null,
        serverReconnecting: false,
      }),
    ).toMatchObject({
      visible: true,
      action: "install",
      actionLabel: "Restart",
      progress: 100,
      tone: "ready",
    })

    expect(
      productUpdateNotice({
        desktopStatus: desktopStatus({ phase: "downloading", percent: 42.4 }),
        serverStatus: null,
        appVersion: "1.2.3",
        serverVersion: "1.2.3",
        busy: null,
        serverReconnecting: false,
      }),
    ).toMatchObject({
      visible: true,
      action: null,
      progress: 42.4,
      tone: "active",
    })
  })

  test("surfaces Web refresh and managed daemon server update actions", () => {
    expect(
      productUpdateNotice({
        desktopStatus: null,
        serverStatus: null,
        appVersion: "1.2.3",
        serverVersion: "1.2.4",
        busy: null,
        serverReconnecting: false,
      }),
    ).toMatchObject({
      visible: true,
      action: "refresh",
      progress: 100,
      tone: "ready",
    })

    expect(
      productUpdateNotice({
        desktopStatus: null,
        serverStatus: status({
          capability: "managed",
          phase: "available",
          latestVersion: "2.0.0",
          updateAvailable: true,
          progress: 0,
        }),
        appVersion: "1.2.3",
        serverVersion: "1.2.3",
        busy: null,
        serverReconnecting: false,
      }),
    ).toMatchObject({
      visible: true,
      action: "start-server",
      progress: 0,
      tone: "ready",
    })

    expect(
      productUpdateNotice({
        desktopStatus: null,
        serverStatus: status({
          capability: "managed",
          phase: "restarting",
          latestVersion: "2.0.0",
          updateAvailable: true,
          progress: 75,
        }),
        appVersion: "1.2.3",
        serverVersion: "1.2.3",
        busy: null,
        serverReconnecting: true,
      }),
    ).toMatchObject({
      visible: true,
      action: null,
      progress: 75,
      tone: "active",
    })
  })
})

function status(patch: Partial<ServerUpdateStatus>): ServerUpdateStatus {
  return {
    capability: "managed",
    phase: "idle",
    currentVersion: "1.2.3",
    latestVersion: null,
    updateAvailable: false,
    progress: null,
    message: "ok",
    error: null,
    ...patch,
  }
}

function desktopStatus(patch: Partial<DesktopUpdateStatus>): DesktopUpdateStatus {
  return {
    channel: "stable",
    mode: "auto",
    phase: "idle",
    currentVersion: "1.2.3",
    availableVersion: null,
    percent: null,
    lastCheckedAt: null,
    error: null,
    ...patch,
  }
}
