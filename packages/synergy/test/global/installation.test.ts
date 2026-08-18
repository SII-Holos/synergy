import { describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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

describe("Installation update channels", () => {
  test("maps the stable runtime channel to the promoted npm dist-tag", () => {
    expect(Installation.npmDistTagForChannel("stable")).toBe("latest")
    expect(Installation.npmDistTagForChannel("next")).toBe("next")
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

  test("upgrades the selected standalone executable instead of the current CLI", async () => {
    const selectedExecutable =
      process.platform === "win32"
        ? "C:\\srv\\synergy-user\\.synergy\\bin\\synergy.exe"
        : "/srv/synergy-user/.synergy/bin/synergy"
    const originalFetch = globalThis.fetch
    const fetchMock = mock(async () => new Response("", { status: 404, statusText: "Not Found" }))
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true })

    try {
      const error = await Installation.upgrade("standalone", "3.0.9", selectedExecutable).catch((cause) => cause)

      expect(fetchMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/SII-Holos/synergy/v3.0.9/install")
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain("Failed to download")
      expect(error.message).not.toContain("not a standalone installation")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("detects musl from Alpine or ldd output", async () => {
    expect(
      await StandaloneInstallation.detectLibc("linux", {
        alpineReleaseExists: async () => true,
        lddVersion: async () => {
          throw new Error("ldd must not run after Alpine detection")
        },
      }),
    ).toBe("musl")

    expect(
      await StandaloneInstallation.detectLibc("linux", {
        alpineReleaseExists: async () => false,
        lddVersion: async () => "musl libc (x86_64)",
      }),
    ).toBe("musl")
  })

  test("defaults Linux to glibc and leaves other platforms unspecified", async () => {
    expect(
      await StandaloneInstallation.detectLibc("linux", {
        alpineReleaseExists: async () => false,
        lddVersion: async () => "ldd (GNU libc) 2.39",
      }),
    ).toBe("glibc")

    expect(
      await StandaloneInstallation.detectLibc("darwin", {
        alpineReleaseExists: async () => {
          throw new Error("non-Linux detection must not inspect Alpine")
        },
        lddVersion: async () => {
          throw new Error("non-Linux detection must not run ldd")
        },
      }),
    ).toBeUndefined()
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
        verify: async () => true,
      },
    )

    expect(fetched).toEqual(["https://raw.githubusercontent.com/SII-Holos/synergy/v3.0.9/install"])
    expect(invocations).toEqual([
      {
        command: ["bash", "-s", "--", "--version", "3.0.9", "--no-modify-path"],
        env: { PATH: "/usr/bin", HOME: "/root" },
        stdin: "#!/usr/bin/env bash\n",
      },
    ])
    expect(result).toEqual({ exitCode: 0, stdout: "installed", stderr: "" })
  })

  test("rejects a standalone upgrade when the installer exits unsuccessfully", async () => {
    const upgrade = StandaloneInstallation.upgrade(
      {
        target: "3.0.9",
        context: {
          platform: "linux",
          execPath: "/root/.synergy/bin/synergy",
          realExecPath: "/root/.synergy/bin/synergy",
          env,
        },
      },
      {
        fetch: async () => new Response("#!/usr/bin/env bash\n"),
        run: async () => ({ exitCode: 22, stdout: "", stderr: "archive download failed" }),
        verify: async () => {
          throw new Error("verification must not run after installer failure")
        },
      },
    )

    await expect(upgrade).rejects.toThrow(/archive download failed/)
  })

  test("rejects a standalone upgrade when the installed bundle is incomplete", async () => {
    const upgrade = StandaloneInstallation.upgrade(
      {
        target: "3.0.9",
        context: {
          platform: "linux",
          execPath: "/root/.synergy/bin/synergy",
          realExecPath: "/root/.synergy/bin/synergy",
          env,
        },
      },
      {
        fetch: async () => new Response("#!/usr/bin/env bash\n"),
        run: async () => ({ exitCode: 0, stdout: "installed", stderr: "" }),
        verify: async () => false,
      },
    )

    await expect(upgrade).rejects.toThrow(/incomplete standalone installation/i)
  })

  test("verifies a complete legacy standalone installation without a manifest", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-legacy-"))
    const required = [
      "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "sandbox/synergy-sandbox-linux",
    ]
    try {
      for (const relative of required) {
        const file = path.join(home, ".synergy", relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, relative)
      }

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "linux",
          execPath: path.join(home, ".synergy", "bin", "synergy"),
          realExecPath: path.join(home, ".synergy", "bin", "synergy"),
          env,
        }),
      ).toBe(true)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects an empty manifest instead of treating it as a legacy installation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-empty-manifest-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
    ]
    try {
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, relative)
      }
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), "")

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects symbolic links in a legacy standalone installation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-legacy-link-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
    ]
    try {
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, relative)
      }
      const linkedApp = path.join(installationRoot, "linked-app.html")
      await fs.writeFile(linkedApp, "app")
      await fs.mkdir(path.join(installationRoot, "app"), { recursive: true })
      await fs.symlink(linkedApp, path.join(installationRoot, "app", "index.html"))

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects a manifest that omits a required standalone runtime entry", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-manifest-"))
    const installationRoot = path.join(home, ".synergy")
    const files = ["bin/synergy", "app/index.html"]
    try {
      const lines: string[] = []
      for (const relative of files) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data = Buffer.from(relative)
        await fs.writeFile(file, data)
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`)
      }
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects a drive-letter path in a standalone runtime manifest", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-drive-manifest-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
    ]
    try {
      const lines: string[] = []
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data = Buffer.from(relative)
        await fs.writeFile(file, data)
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`)
      }
      lines.push(`${"0".repeat(64)}  C:/outside-runtime`)
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("rejects a standalone runtime whose manifest checksum is stale", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-tamper-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
    ]
    try {
      const lines: string[] = []
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data = Buffer.from(relative)
        await fs.writeFile(file, data)
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`)
      }
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)
      await fs.writeFile(path.join(installationRoot, "app", "index.html"), "tampered")

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
  test("rejects a modern non-musl standalone runtime without native helpers", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-native-helpers-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
    ]
    try {
      const lines: string[] = []
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data = Buffer.from(relative)
        await fs.writeFile(file, data)
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`)
      }
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "darwin",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("allows a modern musl standalone runtime without native helpers", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-standalone-musl-"))
    const installationRoot = path.join(home, ".synergy")
    const required = [
      "bin/synergy",
      "sandbox/synergy-sandbox-linux",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
      "lib/holos-cli/index.js",
      "lib/holos-cli/vendor/clarus-shared/index.js",
      "lib/holos-cli/node_modules/ws/package.json",
      "lib/holos-cli/node_modules/zod/package.json",
      "watcher.node",
    ]
    try {
      const lines: string[] = []
      for (const relative of required) {
        const file = path.join(installationRoot, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data = Buffer.from(relative)
        await fs.writeFile(file, data)
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`)
      }
      await fs.writeFile(path.join(installationRoot, "runtime-manifest.sha256"), `${lines.join("\n")}\n`)

      expect(
        await StandaloneInstallation.verify(home, {
          platform: "linux",
          libc: "musl",
          execPath: path.join(installationRoot, "bin", "synergy"),
          realExecPath: path.join(installationRoot, "bin", "synergy"),
          env,
        }),
      ).toBe(true)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
