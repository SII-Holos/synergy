import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/global/installation"
import { StandaloneInstallation } from "../../src/global/standalone-installation"

const env = {}

describe("Installation desktop detection", () => {
  test("detects macOS app bundle runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "darwin",
        execPath: "/usr/local/bin/synergy",
        realExecPath: "/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy",
        env,
      }),
    ).toBe(true)
  })

  test("detects Windows installed runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "win32",
        execPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\bin\\synergy.cmd",
        realExecPath: "C:\\Users\\Eric\\AppData\\Local\\Programs\\Synergy\\resources\\synergy\\bin\\synergy.exe",
        env,
      }),
    ).toBe(true)
  })

  test("detects Linux deb runtime paths", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "linux",
        execPath: "/usr/bin/synergy",
        realExecPath: "/opt/Synergy/resources/synergy/bin/synergy",
        env,
      }),
    ).toBe(true)
  })

  test("does not claim package-manager or unknown binaries", () => {
    expect(
      Installation.detectDesktopInstall({
        platform: "darwin",
        execPath: "/opt/homebrew/bin/synergy",
        realExecPath: "/opt/homebrew/bin/synergy",
        env,
      }),
    ).toBe(false)
    expect(
      Installation.detectDesktopInstall({
        platform: "linux",
        execPath: "/home/eric/.bun/bin/synergy",
        realExecPath: "/home/eric/.bun/install/global/node_modules/@ericsanchezok/synergy/bin/synergy",
        env,
      }),
    ).toBe(false)
  })

  test("desktop upgrades are delegated to the Desktop app", async () => {
    const err = await Installation.upgrade("desktop", "999.0.0").catch((error) => error)
    expect(err).toBeInstanceOf(Installation.DesktopManagedUpdateError)
    expect(err.data.message).toContain("Desktop updates are managed from the Synergy app")
  })
})

describe("standalone installation", () => {
  test("detects curl-installed runtime paths", () => {
    expect(
      StandaloneInstallation.detectStandaloneInstall({
        platform: "linux",
        execPath: "/root/.synergy/bin/synergy",
        realExecPath: "/root/.synergy/bin/synergy",
        env,
      }),
    ).toBe(true)

    expect(
      StandaloneInstallation.detectStandaloneInstall({
        platform: "linux",
        execPath: "/usr/local/bin/synergy",
        realExecPath: "/opt/synergy/bin/synergy",
        env,
      }),
    ).toBe(false)
  })

  test("reports curl-installed executables as standalone", async () => {
    const originalExecPath = process.execPath
    Object.defineProperty(process, "execPath", { value: "/root/.synergy/bin/synergy" })
    try {
      expect(await Installation.method()).toBe("standalone")
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath })
    }
  })

  test("runs the current installer against the requested standalone version and home", async () => {
    const fetched: string[] = []
    const invocations: StandaloneInstallation.InstallerInvocation[] = []

    const result = await StandaloneInstallation.upgrade(
      {
        target: "3.0.9",
        context: {
          platform: "linux",
          execPath: "/root/.synergy/bin/synergy",
          realExecPath: "/root/.synergy/bin/synergy",
          env: { PATH: "/usr/bin" },
        },
      },
      {
        fetch: async (url) => {
          fetched.push(String(url))
          return new Response("#!/usr/bin/env bash\n")
        },
        run: async (invocation) => {
          invocations.push(invocation)
          return { exitCode: 0, stdout: "installed", stderr: "" }
        },
      },
    )

    expect(fetched).toEqual(["https://raw.githubusercontent.com/SII-Holos/synergy/main/install"])
    expect(invocations).toEqual([
      {
        command: ["bash", "-s", "--", "--version", "3.0.9", "--no-modify-path"],
        env: { PATH: "/usr/bin", HOME: "/root" },
        stdin: "#!/usr/bin/env bash\n",
      },
    ])
    expect(result).toEqual({ exitCode: 0, stdout: "installed", stderr: "" })
  })
})
