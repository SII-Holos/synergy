import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/global/installation"

const context = {
  platform: "linux" as const,
  execPath: "/home/user/.synergy/bin/synergy",
  realExecPath: "/home/user/.synergy/bin/synergy",
  home: "/home/user",
  env: { HOME: "/home/user", PATH: "/home/user/.synergy/bin:/usr/local/bin" },
}

describe("installation channel discovery", () => {
  test("discovers standalone and package-manager installations together", async () => {
    const inspection = await Installation.inspect({
      context,
      dependencies: {
        exists: async (candidate: string) => candidate === "/home/user/.synergy/bin/synergy",
        run: async (command: string[]) => {
          if (command[0] === "/home/user/.synergy/bin/synergy") {
            return { exitCode: 0, stdout: "3.0.10\n", stderr: "" }
          }
          if (command[0] === "npm") {
            return { exitCode: 0, stdout: "└── @ericsanchezok/synergy@3.0.9\n", stderr: "" }
          }
          return { exitCode: 1, stdout: "", stderr: "not installed" }
        },
        pathCandidates: async () => [
          { path: "/home/user/.synergy/bin/synergy", realPath: context.realExecPath, isCurrent: true },
          {
            path: "/usr/local/bin/synergy",
            realPath: "/usr/local/lib/node_modules/synergy/bin/synergy",
            isCurrent: false,
          },
        ],
      },
    })

    expect(inspection.current).toBe("standalone")
    expect(inspection.conflict).toBe(true)
    expect(inspection.installations).toEqual([
      {
        method: "standalone",
        executable: "/home/user/.synergy/bin/synergy",
        version: "3.0.10",
        status: "ok",
        current: true,
        pathFirst: true,
      },
      {
        method: "npm",
        executable: null,
        version: "3.0.9",
        status: "ok",
        current: false,
        pathFirst: false,
      },
    ])
  })

  test("discovers pnpm's space-separated global-list output", async () => {
    const pnpmContext = {
      ...context,
      execPath: "/home/user/.local/share/pnpm/synergy",
      realExecPath: "/home/user/.local/share/pnpm/global/5/node_modules/@ericsanchezok/synergy/bin/synergy",
    }
    const inspection = await Installation.inspect({
      context: pnpmContext,
      dependencies: {
        exists: async () => false,
        run: async (command: string[]) =>
          command[0] === "pnpm"
            ? { exitCode: 0, stdout: "dependencies:\n@ericsanchezok/synergy 3.0.9\n", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "not installed" },
        pathCandidates: async () => [
          { path: pnpmContext.execPath, realPath: pnpmContext.realExecPath, isCurrent: true },
        ],
      },
    })

    expect(inspection.current).toBe("pnpm")
    expect(inspection.installations).toEqual([
      {
        method: "pnpm",
        executable: null,
        version: "3.0.9",
        status: "ok",
        current: true,
        pathFirst: true,
      },
    ])
    expect(Installation.resolveUpgradeMethod(inspection)).toBe("pnpm")
    expect(Installation.resolveRemovalMethod(inspection)).toBe("pnpm")
  })

  test("requires an explicit installed method when multiple channels coexist", async () => {
    const inspection: Installation.Inspection = {
      current: "standalone",
      conflict: true,
      path: [],
      installations: [
        {
          method: "standalone",
          executable: "/home/user/.synergy/bin/synergy",
          version: "3.0.10",
          status: "ok",
          current: true,
          pathFirst: true,
        },
        {
          method: "npm",
          executable: null,
          version: "3.0.9",
          status: "ok",
          current: false,
          pathFirst: false,
        },
      ],
    }

    expect(() => Installation.resolveUpgradeMethod(inspection)).toThrow(Installation.MultipleInstallationsError)
    expect(Installation.resolveUpgradeMethod(inspection, "npm")).toBe("npm")
    expect(() => Installation.resolveUpgradeMethod(inspection, "bun")).toThrow(
      Installation.InstallationMethodNotFoundError,
    )
    expect(() => Installation.resolveRemovalMethod(inspection)).toThrow(Installation.MultipleInstallationsError)
    expect(Installation.resolveRemovalMethod(inspection, "npm")).toBe("npm")
    expect(() => Installation.resolveRemovalMethod(inspection, "bun")).toThrow(
      Installation.InstallationMethodNotFoundError,
    )
  })

  test("fails closed when the selected installation probe failed", () => {
    const inspection: Installation.Inspection = {
      current: "npm",
      conflict: false,
      path: [],
      installations: [
        {
          method: "npm",
          executable: "/usr/local/bin/synergy",
          version: null,
          status: "failed",
          current: true,
          pathFirst: true,
        },
      ],
    }

    expect(() => Installation.resolveUpgradeMethod(inspection)).toThrow(Installation.InstallationProbeFailedError)
  })
})
