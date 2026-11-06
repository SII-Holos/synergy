import { describe, expect, test } from "bun:test"
import { GDBUS_PROBE_ARGS, probePortalFileAccess } from "../src/portal-probe.js"

describe("portal file access probe", () => {
  test("classifies successful portal method calls as allowed", async () => {
    const invocations: string[][] = []
    const result = await probePortalFileAccess({
      platform: "linux",
      run: async (file: string, args: string[]) => {
        invocations.push([file, ...args])
        return "({'': {'org.freedesktop.appearance': <{'color-scheme': <0>}>}},)"
      },
    })
    expect(result).toBe("allowed")
    expect(invocations).toHaveLength(1)
    expect(invocations[0]![0]).toBe("gdbus")
  })

  test("classifies AccessDenied replies as denied", async () => {
    const run = async () => {
      throw Object.assign(new Error("Command failed: gdbus call"), {
        stderr:
          "error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Portal operation not allowed: Unable to open /proc/123/root",
      })
    }
    await expect(probePortalFileAccess({ platform: "linux", run })).resolves.toBe("denied")
  })

  test("classifies denial surfaced on the error message itself", async () => {
    const run = async () => {
      throw new Error("gdbus call: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Portal operation not allowed")
    }
    await expect(probePortalFileAccess({ platform: "linux", run })).resolves.toBe("denied")
  })

  test("classifies missing tooling and unknown failures as unavailable", async () => {
    const enoent = Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" })
    await expect(probePortalFileAccess({ platform: "linux", run: () => Promise.reject(enoent) })).resolves.toBe(
      "unavailable",
    )
    await expect(
      probePortalFileAccess({ platform: "linux", run: () => Promise.reject(new Error("dbus timed out")) }),
    ).resolves.toBe("unavailable")
  })

  test("skips the probe outside linux", async () => {
    await expect(
      probePortalFileAccess({
        platform: "darwin",
        run: () => {
          throw new Error("probe must not run")
        },
      }),
    ).resolves.toBe("allowed")
  })

  test("probes the read-only portal settings method on the session bus", () => {
    expect(GDBUS_PROBE_ARGS).toContain("org.freedesktop.portal.Settings.ReadAll")
    expect(GDBUS_PROBE_ARGS).toContain("org.freedesktop.portal.Desktop")
    expect(GDBUS_PROBE_ARGS).toContain("--session")
  })
})
