import { describe, expect, test } from "bun:test"
import {
  canUseNativeProjectDirectoryPicker,
  normalizePickedDirectories,
  normalizeServerBrowserDirectoryResult,
  pickProjectDirectoriesWithRuntime,
  type ProjectDirectoryPickerRuntime,
} from "./project-directory-picker-model"
import type { DesktopServerStatus, Platform } from "@/context/platform"

const managedRunningStatus: DesktopServerStatus = {
  mode: "managed",
  state: "running",
  url: "http://127.0.0.1:3000",
  port: 3000,
  pid: 123,
  lastError: null,
  logFile: null,
}

function platform(overrides: Partial<Platform> = {}): Platform {
  return {
    platform: "desktop",
    openLink() {},
    restart: async () => {},
    notify: async () => {},
    openDirectoryPickerDialog: async () => null,
    ...overrides,
  }
}

function runtime(
  overrides: {
    platform?: Partial<Platform>
    pending?: boolean
  } = {},
) {
  let pending = overrides.pending ?? false
  let serverBrowserOpenCount = 0
  const toasts: unknown[] = []
  return {
    runtime: {
      platform: platform(overrides.platform),
      pickServer: async () => {
        serverBrowserOpenCount++
        return null
      },
      showErrorToast(toast: unknown) {
        toasts.push(toast)
      },
      isPending() {
        return pending
      },
      setPending(next: boolean) {
        pending = next
      },
    } as ProjectDirectoryPickerRuntime,
    toasts,
    serverBrowserOpenCount: () => serverBrowserOpenCount,
    pending: () => pending,
  }
}

describe("project directory picker", () => {
  test("uses native picker only for desktop managed running status with picker bridge", () => {
    expect(canUseNativeProjectDirectoryPicker(platform(), managedRunningStatus)).toBe(true)
    expect(
      canUseNativeProjectDirectoryPicker(platform(), {
        ...managedRunningStatus,
        mode: "external",
        state: "external",
      }),
    ).toBe(false)
    expect(canUseNativeProjectDirectoryPicker(platform(), { ...managedRunningStatus, state: "starting" })).toBe(false)
    expect(
      canUseNativeProjectDirectoryPicker(platform({ openDirectoryPickerDialog: undefined }), managedRunningStatus),
    ).toBe(false)
    expect(canUseNativeProjectDirectoryPicker(platform({ platform: "web" }), managedRunningStatus)).toBe(false)
    expect(canUseNativeProjectDirectoryPicker(platform(), null)).toBe(false)
  })

  test("normalizes native picker selections", () => {
    expect(normalizePickedDirectories(null)).toBeNull()
    expect(normalizePickedDirectories("/repo")).toEqual(["/repo"])
    expect(normalizePickedDirectories(["/repo-a", "/repo-b"])).toEqual(["/repo-a", "/repo-b"])
    expect(normalizePickedDirectories([])).toBeNull()
  })

  test("normalizes server browser selections", () => {
    expect(normalizeServerBrowserDirectoryResult(null)).toBeNull()
    expect(normalizeServerBrowserDirectoryResult({ directory: "/repo" })).toEqual(["/repo"])
    expect(normalizeServerBrowserDirectoryResult({ directory: ["/repo-a", "/repo-b"] })).toEqual(["/repo-a", "/repo-b"])
    expect(normalizeServerBrowserDirectoryResult({ directory: [] })).toBeNull()
  })

  test("native routing returns cancel, single, and multiple selections", async () => {
    const canceled = runtime({
      platform: {
        desktopServer: { status: async () => managedRunningStatus, restart: async () => managedRunningStatus },
        openDirectoryPickerDialog: async () => null,
      },
    })
    await expect(
      pickProjectDirectoriesWithRuntime(canceled.runtime, { title: "Open project", multiple: false }),
    ).resolves.toBeNull()

    const single = runtime({
      platform: {
        desktopServer: { status: async () => managedRunningStatus, restart: async () => managedRunningStatus },
        openDirectoryPickerDialog: async () => "/repo",
      },
    })
    await expect(
      pickProjectDirectoriesWithRuntime(single.runtime, { title: "Open project", multiple: false }),
    ).resolves.toEqual({
      directoryPaths: ["/repo"],
      source: "native-local",
    })

    const multiple = runtime({
      platform: {
        desktopServer: { status: async () => managedRunningStatus, restart: async () => managedRunningStatus },
        openDirectoryPickerDialog: async () => ["/repo-a", "/repo-b"],
      },
    })
    await expect(
      pickProjectDirectoriesWithRuntime(multiple.runtime, { title: "Open project", multiple: true }),
    ).resolves.toEqual({
      directoryPaths: ["/repo-a", "/repo-b"],
      source: "native-local",
    })
  })

  test("native rejection shows error without opening server browser", async () => {
    const context = runtime({
      platform: {
        desktopServer: { status: async () => managedRunningStatus, restart: async () => managedRunningStatus },
        openDirectoryPickerDialog: async () => {
          throw new Error("boom")
        },
      },
    })
    await expect(
      pickProjectDirectoriesWithRuntime(context.runtime, { title: "Open project", multiple: true }),
    ).resolves.toBeNull()
    expect(context.toasts).toHaveLength(1)
    expect(context.serverBrowserOpenCount()).toBe(0)
  })

  test("server browser routing and pending guard stop native usage", async () => {
    const external = runtime({
      platform: {
        desktopServer: {
          status: async () => ({ ...managedRunningStatus, mode: "external", state: "external" }),
          restart: async () => ({ ...managedRunningStatus, mode: "external", state: "external" }),
        },
      },
    })
    await expect(
      pickProjectDirectoriesWithRuntime(external.runtime, { title: "Add project", multiple: true }),
    ).resolves.toBeNull()
    expect(external.serverBrowserOpenCount()).toBe(1)

    const pending = runtime({ pending: true })
    await expect(
      pickProjectDirectoriesWithRuntime(pending.runtime, { title: "Add project", multiple: true }),
    ).resolves.toBeNull()
    expect(pending.serverBrowserOpenCount()).toBe(0)
    expect(pending.pending()).toBe(true)
  })
})
