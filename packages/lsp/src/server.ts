import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { ProcessHandle } from "@ericsanchezok/synergy-harness/process/handle"
import { LSPProcess } from "./process"
import path from "path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { BunProc } from "@ericsanchezok/synergy-harness/util/bun"
import fs from "fs/promises"
import { Filesystem } from "@ericsanchezok/synergy-harness/util/filesystem"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"

export namespace LSPServer {
  const log = Log.create({ service: "lsp.server" })
  const pathExists = async (p: string) =>
    fs
      .stat(p)
      .then(() => true)
      .catch(() => false)

  export interface Handle {
    process: ProcessHandle & {
      stdin: import("node:stream").Writable
      stdout: import("node:stream").Readable
      stderr: import("node:stream").Readable
    }
    initialization?: Record<string, unknown>
  }

  export interface Launch {
    command: LSPProcess.Command
    initialization?: Record<string, unknown>
  }

  type RootFunction = (file: string) => Promise<string | undefined>

  const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
    return async (file) => {
      if (excludePatterns) {
        const excludedFiles = Filesystem.up({
          targets: excludePatterns,
          start: path.dirname(file),
          stop: ScopeContext.current.directory,
        })
        const excluded = await excludedFiles.next()
        await excludedFiles.return()
        if (excluded.value) return undefined
      }
      const files = Filesystem.up({
        targets: includePatterns,
        start: path.dirname(file),
        stop: ScopeContext.current.directory,
      })
      const first = await files.next()
      await files.return()
      if (!first.value) return ScopeContext.current.directory
      return path.dirname(first.value)
    }
  }

  export interface Info {
    id: string
    extensions: string[]
    global?: boolean
    root: RootFunction
    resolve(root: string): Promise<Launch | undefined>
  }

  export const Deno: Info = {
    id: "deno",
    root: async (file) => {
      const files = Filesystem.up({
        targets: ["deno.json", "deno.jsonc"],
        start: path.dirname(file),
        stop: ScopeContext.current.directory,
      })
      const first = await files.next()
      await files.return()
      if (!first.value) return undefined
      return path.dirname(first.value)
    },
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    async resolve(root) {
      const deno = Bun.which("deno")
      if (!deno) {
        log.info("deno not found, please install deno first")
        return
      }
      return {
        command: { command: deno, args: ["lsp"], cwd: root },
      }
    },
  }

  export const Typescript: Info = {
    id: "typescript",
    root: NearestRoot(
      ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
      ["deno.json", "deno.jsonc"],
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    async resolve(root) {
      const tsserver = await Bun.resolve("typescript/lib/tsserver.js", ScopeContext.current.directory).catch(() => {})
      log.info("typescript server", { tsserver })
      if (!tsserver) return
      const proc = {
        command: BunProc.which(),
        args: ["x", "typescript-language-server", "--stdio"],
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization: {
          tsserver: {
            path: tsserver,
          },
        },
      }
    },
  }

  export const Vue: Info = {
    id: "vue",
    extensions: [".vue"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async resolve(root) {
      let binary = Bun.which("vue-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(
          Global.Path.bin,
          "node_modules",
          "@vue",
          "language-server",
          "bin",
          "vue-language-server.js",
        )
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "@vue/language-server"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization: {
          // Leave empty; the server will auto-detect workspace TypeScript.
        },
      }
    },
  }

  export const ESLint: Info = {
    id: "eslint",
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"],
    async resolve(root) {
      const eslint = await Bun.resolve("eslint", ScopeContext.current.directory).catch(() => {})
      if (!eslint) return
      log.info("spawning eslint server")
      const serverPath = path.join(Global.Path.bin, "vscode-eslint", "server", "out", "eslintServer.js")
      if (!(await Bun.file(serverPath).exists())) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading and building VS Code ESLint server")
        const response = await fetch("https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip", {
          signal: LSPProcess.signal(),
        })
        if (!response.ok) return

        const zipPath = path.join(Global.Path.bin, "vscode-eslint.zip")
        await LSPProcess.mutate(() => Bun.file(zipPath).write(response))

        const ok = await LSPProcess.extractZip(zipPath, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract vscode-eslint archive", { error })
            return false
          })
        if (!ok) return
        await LSPProcess.mutate(() => fs.rm(zipPath, { force: true }))

        const extractedPath = path.join(Global.Path.bin, "vscode-eslint-main")
        const finalPath = path.join(Global.Path.bin, "vscode-eslint")

        const stats = await fs.stat(finalPath).catch(() => undefined)
        if (stats) {
          log.info("removing old eslint installation", { path: finalPath })
          await LSPProcess.mutate(() => fs.rm(finalPath, { force: true, recursive: true }))
        }
        await LSPProcess.mutate(() => fs.rename(extractedPath, finalPath))

        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
        await LSPProcess.run({ command: [npmCmd, "install"], cwd: finalPath })
        await LSPProcess.run({ command: [npmCmd, "run", "compile"], cwd: finalPath })

        log.info("installed VS Code ESLint server", { serverPath })
      }

      const proc = {
        command: BunProc.which(),
        args: [serverPath, "--stdio"],
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }

      return {
        command: proc,
      }
    },
  }

  export const Oxlint: Info = {
    id: "oxlint",
    root: NearestRoot([
      ".oxlintrc.json",
      "package-lock.json",
      "bun.lockb",
      "bun.lock",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package.json",
    ]),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"],
    async resolve(root) {
      const ext = process.platform === "win32" ? ".cmd" : ""

      const serverTarget = path.join("node_modules", ".bin", "oxc_language_server" + ext)
      const lintTarget = path.join("node_modules", ".bin", "oxlint" + ext)

      const resolveBin = async (target: string) => {
        const localBin = path.join(root, target)
        if (await Bun.file(localBin).exists()) return localBin

        const candidates = Filesystem.up({
          targets: [target],
          start: root,
          stop: ScopeContext.current.directory,
        })
        const first = await candidates.next()
        await candidates.return()
        if (first.value) return first.value

        return undefined
      }

      let lintBin = await resolveBin(lintTarget)
      if (!lintBin) {
        const found = Bun.which("oxlint")
        if (found) lintBin = found
      }

      if (lintBin) {
        const proc = await LSPProcess.run({ command: [lintBin, "--help"] })
        const help = proc.stdout.toString()
        if (help.includes("--lsp")) {
          return {
            command: { command: lintBin, args: ["--lsp"], cwd: root },
          }
        }
      }

      let serverBin = await resolveBin(serverTarget)
      if (!serverBin) {
        const found = Bun.which("oxc_language_server")
        if (found) serverBin = found
      }
      if (serverBin) {
        return {
          command: { command: serverBin, args: [], cwd: root },
        }
      }

      log.info("oxlint not found, please install oxlint")
      return
    },
  }

  export const Biome: Info = {
    id: "biome",
    root: NearestRoot([
      "biome.json",
      "biome.jsonc",
      "package-lock.json",
      "bun.lockb",
      "bun.lock",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]),
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".vue",
      ".astro",
      ".svelte",
      ".css",
      ".graphql",
      ".gql",
      ".html",
    ],
    async resolve(root) {
      const localBin = path.join(root, "node_modules", ".bin", "biome")
      let bin: string | undefined
      if (await Bun.file(localBin).exists()) bin = localBin
      if (!bin) {
        const found = Bun.which("biome")
        if (found) bin = found
      }

      let args = ["lsp-proxy", "--stdio"]

      if (!bin) {
        const resolved = await Bun.resolve("biome", root).catch(() => undefined)
        if (!resolved) return
        bin = BunProc.which()
        args = ["x", "biome", "lsp-proxy", "--stdio"]
      }

      const proc = {
        command: bin,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }

      return {
        command: proc,
      }
    },
  }

  export const Gopls: Info = {
    id: "gopls",
    root: async (file) => {
      const work = await NearestRoot(["go.work"])(file)
      if (work) return work
      return NearestRoot(["go.mod", "go.sum"])(file)
    },
    extensions: [".go"],
    async resolve(root) {
      let bin = Bun.which("gopls", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!Bun.which("go")) return
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return

        log.info("installing gopls")
        const proc = await LSPProcess.run({
          command: ["go", "install", "golang.org/x/tools/gopls@latest"],
          env: { ...RuntimeContext.current().host.env, GOBIN: Global.Path.bin },
        })
        const exit = proc.exitCode
        if (exit !== 0) {
          log.error("Failed to install gopls")
          return
        }
        bin = path.join(Global.Path.bin, "gopls" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed gopls`, {
          bin,
        })
      }
      return {
        command: { command: bin!, args: [], cwd: root },
      }
    },
  }

  export const Rubocop: Info = {
    id: "ruby-lsp",
    root: NearestRoot(["Gemfile"]),
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    async resolve(root) {
      let bin = Bun.which("rubocop", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        const ruby = Bun.which("ruby")
        const gem = Bun.which("gem")
        if (!ruby || !gem) {
          log.info("Ruby not found, please install Ruby first")
          return
        }
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("installing rubocop")
        const proc = await LSPProcess.run({ command: ["gem", "install", "rubocop", "--bindir", Global.Path.bin] })
        const exit = proc.exitCode
        if (exit !== 0) {
          log.error("Failed to install rubocop")
          return
        }
        bin = path.join(Global.Path.bin, "rubocop" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed rubocop`, {
          bin,
        })
      }
      return {
        command: { command: bin!, args: ["--lsp"], cwd: root },
      }
    },
  }

  export const Ty: Info = {
    id: "ty",
    extensions: [".py", ".pyi"],
    root: NearestRoot([
      "pyproject.toml",
      "ty.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
    ]),
    async resolve(root) {
      let binary = Bun.which("ty")

      const initialization: Record<string, string> = {}

      const potentialVenvPaths = [
        RuntimeContext.current().host.env["VIRTUAL_ENV"],
        path.join(root, ".venv"),
        path.join(root, "venv"),
      ].filter((p): p is string => p !== undefined)
      for (const venvPath of potentialVenvPaths) {
        const isWindows = process.platform === "win32"
        const potentialPythonPath = isWindows
          ? path.join(venvPath, "Scripts", "python.exe")
          : path.join(venvPath, "bin", "python")
        if (await Bun.file(potentialPythonPath).exists()) {
          initialization["pythonPath"] = potentialPythonPath
          break
        }
      }

      if (!binary) {
        for (const venvPath of potentialVenvPaths) {
          const isWindows = process.platform === "win32"
          const potentialTyPath = isWindows
            ? path.join(venvPath, "Scripts", "ty.exe")
            : path.join(venvPath, "bin", "ty")
          if (await Bun.file(potentialTyPath).exists()) {
            binary = potentialTyPath
            break
          }
        }
      }

      if (!binary) {
        log.error("ty not found, please install ty first")
        return
      }

      const proc = { command: binary, args: ["server"], cwd: root }

      return {
        command: proc,
        initialization,
      }
    },
  }

  export const Pyright: Info = {
    id: "pyright",
    extensions: [".py", ".pyi"],
    root: NearestRoot(["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
    async resolve(root) {
      let binary = Bun.which("pyright-langserver")
      const args = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "pyright", "dist", "pyright-langserver.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "pyright"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push(...["run", js])
      }
      args.push("--stdio")

      const initialization: Record<string, string> = {}

      const potentialVenvPaths = [
        RuntimeContext.current().host.env["VIRTUAL_ENV"],
        path.join(root, ".venv"),
        path.join(root, "venv"),
      ].filter((p): p is string => p !== undefined)
      for (const venvPath of potentialVenvPaths) {
        const isWindows = process.platform === "win32"
        const potentialPythonPath = isWindows
          ? path.join(venvPath, "Scripts", "python.exe")
          : path.join(venvPath, "bin", "python")
        if (await Bun.file(potentialPythonPath).exists()) {
          initialization["pythonPath"] = potentialPythonPath
          break
        }
      }

      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization,
      }
    },
  }

  export const ElixirLS: Info = {
    id: "elixir-ls",
    extensions: [".ex", ".exs"],
    root: NearestRoot(["mix.exs", "mix.lock"]),
    async resolve(root) {
      let binary = Bun.which("elixir-ls")
      if (!binary) {
        const elixirLsPath = path.join(Global.Path.bin, "elixir-ls")
        binary = path.join(
          Global.Path.bin,
          "elixir-ls-master",
          "release",
          process.platform === "win32" ? "language_server.bat" : "language_server.sh",
        )

        if (!(await Bun.file(binary).exists())) {
          const elixir = Bun.which("elixir")
          if (!elixir) {
            log.error("elixir is required to run elixir-ls")
            return
          }

          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          log.info("downloading elixir-ls from GitHub releases")

          const response = await fetch("https://github.com/elixir-lsp/elixir-ls/archive/refs/heads/master.zip", {
            signal: LSPProcess.signal(),
          })
          if (!response.ok) return
          const zipPath = path.join(Global.Path.bin, "elixir-ls.zip")
          await LSPProcess.mutate(() => Bun.file(zipPath).write(response))

          const ok = await LSPProcess.extractZip(zipPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract elixir-ls archive", { error })
              return false
            })
          if (!ok) return

          await LSPProcess.mutate(() =>
            fs.rm(zipPath, {
              force: true,
              recursive: true,
            }),
          )

          for (const args of [["deps.get"], ["compile"], ["elixir_ls.release2", "-o", "release"]])
            await LSPProcess.run({
              command: ["mix", ...args],
              cwd: path.join(Global.Path.bin, "elixir-ls-master"),
              env: { ...RuntimeContext.current().host.env, MIX_ENV: "prod" },
            })

          log.info(`installed elixir-ls`, {
            path: elixirLsPath,
          })
        }
      }

      return {
        command: { command: binary, args: [], cwd: root },
      }
    },
  }

  export const Zls: Info = {
    id: "zls",
    extensions: [".zig", ".zon"],
    root: NearestRoot(["build.zig"]),
    async resolve(root) {
      let bin = Bun.which("zls", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        const zig = Bun.which("zig")
        if (!zig) {
          log.error("Zig is required to use zls. Please install Zig first.")
          return
        }

        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading zls from GitHub releases")

        const releaseResponse = await fetch("https://api.github.com/repos/zigtools/zls/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!releaseResponse.ok) {
          log.error("Failed to fetch zls release info")
          return
        }

        const release = (await releaseResponse.json()) as any

        const platform = process.platform
        const arch = process.arch
        let assetName = ""

        let zlsArch: string = arch
        if (arch === "arm64") zlsArch = "aarch64"
        else if (arch === "x64") zlsArch = "x86_64"
        else if (arch === "ia32") zlsArch = "x86"

        let zlsPlatform: string = platform
        if (platform === "darwin") zlsPlatform = "macos"
        else if (platform === "win32") zlsPlatform = "windows"

        const ext = platform === "win32" ? "zip" : "tar.xz"

        assetName = `zls-${zlsArch}-${zlsPlatform}.${ext}`

        const supportedCombos = [
          "zls-x86_64-linux.tar.xz",
          "zls-x86_64-macos.tar.xz",
          "zls-x86_64-windows.zip",
          "zls-aarch64-linux.tar.xz",
          "zls-aarch64-macos.tar.xz",
          "zls-aarch64-windows.zip",
          "zls-x86-linux.tar.xz",
          "zls-x86-windows.zip",
        ]

        if (!supportedCombos.includes(assetName)) {
          log.error(`Platform ${platform} and architecture ${arch} is not supported by zls`)
          return
        }

        const asset = release.assets.find((a: any) => a.name === assetName)
        if (!asset) {
          log.error(`Could not find asset ${assetName} in latest zls release`)
          return
        }

        const downloadUrl = asset.browser_download_url
        const downloadResponse = await fetch(downloadUrl, { signal: LSPProcess.signal() })
        if (!downloadResponse.ok) {
          log.error("Failed to download zls")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        await LSPProcess.mutate(() => Bun.file(tempPath).write(downloadResponse))

        if (ext === "zip") {
          const ok = await LSPProcess.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract zls archive", { error })
              return false
            })
          if (!ok) return
        } else {
          await LSPProcess.run({ command: ["tar", "-xf", tempPath], cwd: Global.Path.bin })
        }

        await LSPProcess.mutate(() => fs.rm(tempPath, { force: true }))

        bin = path.join(Global.Path.bin, "zls" + (platform === "win32" ? ".exe" : ""))

        if (!(await Bun.file(bin).exists())) {
          log.error("Failed to extract zls binary")
          return
        }

        if (platform !== "win32") {
          await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
        }

        log.info(`installed zls`, { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const CSharp: Info = {
    id: "csharp",
    root: NearestRoot([".sln", ".csproj", "global.json"]),
    extensions: [".cs"],
    async resolve(root) {
      let bin = Bun.which("csharp-ls", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!Bun.which("dotnet")) {
          log.error(".NET SDK is required to install csharp-ls")
          return
        }

        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("installing csharp-ls via dotnet tool")
        const proc = await LSPProcess.run({
          command: ["dotnet", "tool", "install", "csharp-ls", "--tool-path", Global.Path.bin],
        })
        const exit = proc.exitCode
        if (exit !== 0) {
          log.error("Failed to install csharp-ls")
          return
        }

        bin = path.join(Global.Path.bin, "csharp-ls" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed csharp-ls`, { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const FSharp: Info = {
    id: "fsharp",
    root: NearestRoot([".sln", ".fsproj", "global.json"]),
    extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
    async resolve(root) {
      let bin = Bun.which("fsautocomplete", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })
      if (!bin) {
        if (!Bun.which("dotnet")) {
          log.error(".NET SDK is required to install fsautocomplete")
          return
        }

        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("installing fsautocomplete via dotnet tool")
        const proc = await LSPProcess.run({
          command: ["dotnet", "tool", "install", "fsautocomplete", "--tool-path", Global.Path.bin],
        })
        const exit = proc.exitCode
        if (exit !== 0) {
          log.error("Failed to install fsautocomplete")
          return
        }

        bin = path.join(Global.Path.bin, "fsautocomplete" + (process.platform === "win32" ? ".exe" : ""))
        log.info(`installed fsautocomplete`, { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const SourceKit: Info = {
    id: "sourcekit-lsp",
    extensions: [".swift", ".objc", "objcpp"],
    root: NearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
    async resolve(root) {
      // Check if sourcekit-lsp is available in the PATH
      // This is installed with the Swift toolchain
      const sourcekit = Bun.which("sourcekit-lsp")
      if (sourcekit) {
        return {
          command: { command: sourcekit, args: [], cwd: root },
        }
      }

      // If sourcekit-lsp not found, check if xcrun is available
      // This is specific to macOS where sourcekit-lsp is typically installed with Xcode
      if (!Bun.which("xcrun")) return

      const lspLoc = await LSPProcess.run({ command: ["xcrun", "--find", "sourcekit-lsp"], check: false })

      if (lspLoc.exitCode !== 0) return

      const bin = lspLoc.stdout.toString().trim()

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const RustAnalyzer: Info = {
    id: "rust",
    root: async (root) => {
      const crateRoot = await NearestRoot(["Cargo.toml", "Cargo.lock"])(root)
      if (crateRoot === undefined) {
        return undefined
      }
      let currentDir = crateRoot

      while (currentDir !== path.dirname(currentDir)) {
        // Stop at filesystem root
        const cargoTomlPath = path.join(currentDir, "Cargo.toml")
        try {
          const cargoTomlContent = await Bun.file(cargoTomlPath).text()
          if (cargoTomlContent.includes("[workspace]")) {
            return currentDir
          }
        } catch (err) {
          // File doesn't exist or can't be read, continue searching up
        }

        const parentDir = path.dirname(currentDir)
        if (parentDir === currentDir) break // Reached filesystem root
        currentDir = parentDir

        // Stop if we've gone above the app root
        if (!currentDir.startsWith(ScopeContext.current.directory)) break
      }

      return crateRoot
    },
    extensions: [".rs"],
    async resolve(root) {
      const bin = Bun.which("rust-analyzer")
      if (!bin) {
        log.info("rust-analyzer not found in path, please install it")
        return
      }
      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const Clangd: Info = {
    id: "clangd",
    root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"]),
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
    async resolve(root) {
      const args = ["--background-index", "--clang-tidy"]
      const fromPath = Bun.which("clangd")
      if (fromPath) {
        return {
          command: { command: fromPath, args: args, cwd: root },
        }
      }

      const ext = process.platform === "win32" ? ".exe" : ""
      const direct = path.join(Global.Path.bin, "clangd" + ext)
      if (await Bun.file(direct).exists()) {
        return {
          command: { command: direct, args: args, cwd: root },
        }
      }

      const entries = await fs.readdir(Global.Path.bin, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith("clangd_")) continue
        const candidate = path.join(Global.Path.bin, entry.name, "bin", "clangd" + ext)
        if (await Bun.file(candidate).exists()) {
          return {
            command: { command: candidate, args: args, cwd: root },
          }
        }
      }

      if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
      log.info("downloading clangd from GitHub releases")

      const releaseResponse = await fetch("https://api.github.com/repos/clangd/clangd/releases/latest", {
        signal: LSPProcess.signal(),
      })
      if (!releaseResponse.ok) {
        log.error("Failed to fetch clangd release info")
        return
      }

      const release: {
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      } = await releaseResponse.json()

      const tag = release.tag_name
      if (!tag) {
        log.error("clangd release did not include a tag name")
        return
      }
      const platform = process.platform
      const tokens: Record<string, string> = {
        darwin: "mac",
        linux: "linux",
        win32: "windows",
      }
      const token = tokens[platform]
      if (!token) {
        log.error(`Platform ${platform} is not supported by clangd auto-download`)
        return
      }

      const assets = release.assets ?? []
      const valid = (item: { name?: string; browser_download_url?: string }) => {
        if (!item.name) return false
        if (!item.browser_download_url) return false
        if (!item.name.includes(token)) return false
        return item.name.includes(tag)
      }

      const asset =
        assets.find((item) => valid(item) && item.name?.endsWith(".zip")) ??
        assets.find((item) => valid(item) && item.name?.endsWith(".tar.xz")) ??
        assets.find((item) => valid(item))
      if (!asset?.name || !asset.browser_download_url) {
        log.error("clangd could not match release asset", { tag, platform })
        return
      }

      const name = asset.name
      const downloadResponse = await fetch(asset.browser_download_url, { signal: LSPProcess.signal() })
      if (!downloadResponse.ok) {
        log.error("Failed to download clangd")
        return
      }

      const archive = path.join(Global.Path.bin, name)
      const buf = await downloadResponse.arrayBuffer()
      if (buf.byteLength === 0) {
        log.error("Failed to write clangd archive")
        return
      }
      await LSPProcess.mutate(() => Bun.write(archive, buf))

      const zip = name.endsWith(".zip")
      const tar = name.endsWith(".tar.xz")
      if (!zip && !tar) {
        log.error("clangd encountered unsupported asset", { asset: name })
        return
      }

      if (zip) {
        const ok = await LSPProcess.extractZip(archive, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract clangd archive", { error })
            return false
          })
        if (!ok) return
      }
      if (tar) {
        await LSPProcess.run({ command: ["tar", "-xf", archive], cwd: Global.Path.bin })
      }
      await LSPProcess.mutate(() => fs.rm(archive, { force: true }))

      const bin = path.join(Global.Path.bin, "clangd_" + tag, "bin", "clangd" + ext)
      if (!(await Bun.file(bin).exists())) {
        log.error("Failed to extract clangd binary")
        return
      }

      if (platform !== "win32") {
        await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
      }

      await fs.unlink(path.join(Global.Path.bin, "clangd")).catch(() => {})
      await fs.symlink(bin, path.join(Global.Path.bin, "clangd")).catch(() => {})

      log.info(`installed clangd`, { bin })

      return {
        command: { command: bin, args: args, cwd: root },
      }
    },
  }

  export const Svelte: Info = {
    id: "svelte",
    extensions: [".svelte"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async resolve(root) {
      let binary = Bun.which("svelteserver")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "svelte-language-server", "bin", "server.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "svelte-language-server"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization: {},
      }
    },
  }

  export const Astro: Info = {
    id: "astro",
    extensions: [".astro"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async resolve(root) {
      const tsserver = await Bun.resolve("typescript/lib/tsserver.js", ScopeContext.current.directory).catch(() => {})
      if (!tsserver) {
        log.info("typescript not found, required for Astro language server")
        return
      }
      const tsdk = path.dirname(tsserver)

      let binary = Bun.which("astro-ls")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "@astrojs", "language-server", "bin", "nodeServer.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "@astrojs/language-server"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization: {
          typescript: {
            tsdk,
          },
        },
      }
    },
  }

  export const JDTLS: Info = {
    id: "jdtls",
    root: NearestRoot(["pom.xml", "build.gradle", "build.gradle.kts", ".project", ".classpath"]),
    extensions: [".java"],
    async resolve(root) {
      const java = Bun.which("java")
      if (!java) {
        log.error("Java 21 or newer is required to run the JDTLS. Please install it first.")
        return
      }
      const javaMajorVersion = await LSPProcess.run({ command: [java, "-version"], check: false }).then(
        ({ stderr }) => {
          const m = /"(\d+)\.\d+\.\d+"/.exec(stderr.toString())
          return !m ? undefined : parseInt(m[1])
        },
      )
      if (javaMajorVersion == null || javaMajorVersion < 21) {
        log.error("JDTLS requires at least Java 21.")
        return
      }
      const distPath = path.join(Global.Path.bin, "jdtls")
      const launcherDir = path.join(distPath, "plugins")
      const installed = await pathExists(launcherDir)
      if (!installed) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("Downloading JDTLS LSP server.")
        await LSPProcess.mutate(() => fs.mkdir(distPath, { recursive: true }))
        const releaseURL =
          "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz"
        const archivePath = path.join(distPath, "release.tar.gz")
        await LSPProcess.run({ command: ["curl", "--fail", "-L", "-o", archivePath, releaseURL] })
        await LSPProcess.run({ command: ["tar", "-xzf", archivePath], cwd: distPath })
        await LSPProcess.mutate(() => fs.rm(archivePath, { force: true }))
      }
      const jarFileName = await fs
        .readdir(launcherDir)
        .then((files) => files.find((file) => /^org\.eclipse\.equinox\.launcher_.+\.jar$/.test(file)))
      const launcherJar = path.join(launcherDir, jarFileName ?? "missing-launcher.jar")
      if (!(await pathExists(launcherJar))) {
        log.error(`Failed to locate the JDTLS launcher module in the installed directory: ${distPath}.`)
        return
      }
      const configFile = path.join(
        distPath,
        (() => {
          switch (process.platform) {
            case "darwin":
              return "config_mac"
            case "linux":
              return "config_linux"
            case "win32":
              return "config_win"
            default:
              return "config_linux"
          }
        })(),
      )
      const dataDir = await LSPProcess.temporaryDirectory()
      return {
        command: {
          command: java,
          args: [
            "-jar",
            launcherJar,
            "-configuration",
            configFile,
            "-data",
            dataDir,
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.level=ALL",
            "--add-modules=ALL-SYSTEM",
            "--add-opens java.base/java.util=ALL-UNNAMED",
            "--add-opens java.base/java.lang=ALL-UNNAMED",
          ],
          cwd: root,
        },
      }
    },
  }

  export const KotlinLS: Info = {
    id: "kotlin-ls",
    extensions: [".kt", ".kts"],
    root: async (file) => {
      // 1) Nearest Gradle root (multi-project or included build)
      const settingsRoot = await NearestRoot(["settings.gradle.kts", "settings.gradle"])(file)
      if (settingsRoot) return settingsRoot
      // 2) Gradle wrapper (strong root signal)
      const wrapperRoot = await NearestRoot(["gradlew", "gradlew.bat"])(file)
      if (wrapperRoot) return wrapperRoot
      // 3) Single-project or module-level build
      const buildRoot = await NearestRoot(["build.gradle.kts", "build.gradle"])(file)
      if (buildRoot) return buildRoot
      // 4) Maven fallback
      return NearestRoot(["pom.xml"])(file)
    },
    async resolve(root) {
      const distPath = path.join(Global.Path.bin, "kotlin-ls")
      const launcherScript =
        process.platform === "win32" ? path.join(distPath, "kotlin-lsp.cmd") : path.join(distPath, "kotlin-lsp.sh")
      const installed = await Bun.file(launcherScript).exists()
      if (!installed) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("Downloading Kotlin Language Server from GitHub.")

        const releaseResponse = await fetch("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!releaseResponse.ok) {
          log.error("Failed to fetch kotlin-lsp release info")
          return
        }

        const release = await releaseResponse.json()
        const version = release.name?.replace(/^v/, "")

        if (!version) {
          log.error("Could not determine Kotlin LSP version from release")
          return
        }

        const platform = process.platform
        const arch = process.arch

        let kotlinArch: string = arch
        if (arch === "arm64") kotlinArch = "aarch64"
        else if (arch === "x64") kotlinArch = "x64"

        let kotlinPlatform: string = platform
        if (platform === "darwin") kotlinPlatform = "mac"
        else if (platform === "linux") kotlinPlatform = "linux"
        else if (platform === "win32") kotlinPlatform = "win"

        const supportedCombos = ["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]

        const combo = `${kotlinPlatform}-${kotlinArch}`

        if (!supportedCombos.includes(combo)) {
          log.error(`Platform ${platform}/${arch} is not supported by Kotlin LSP`)
          return
        }

        const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`
        const releaseURL = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`

        await LSPProcess.mutate(() => fs.mkdir(distPath, { recursive: true }))
        const archivePath = path.join(distPath, "kotlin-ls.zip")
        await LSPProcess.run({ command: ["curl", "--fail", "-L", "-o", archivePath, releaseURL] })
        const ok = await LSPProcess.extractZip(archivePath, distPath)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract Kotlin LS archive", { error })
            return false
          })
        if (!ok) return
        await LSPProcess.mutate(() => fs.rm(archivePath, { force: true }))
        if (process.platform !== "win32") {
          await LSPProcess.mutate(() => fs.chmod(launcherScript, 0o755))
        }
        log.info("Installed Kotlin Language Server", { path: launcherScript })
      }
      if (!(await Bun.file(launcherScript).exists())) {
        log.error(`Failed to locate the Kotlin LS launcher script in the installed directory: ${distPath}.`)
        return
      }
      return {
        command: { command: launcherScript, args: ["--stdio"], cwd: root },
      }
    },
  }

  export const YamlLS: Info = {
    id: "yaml-ls",
    extensions: [".yaml", ".yml"],
    root: NearestRoot(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]),
    async resolve(root) {
      let binary = Bun.which("yaml-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(
          Global.Path.bin,
          "node_modules",
          "yaml-language-server",
          "out",
          "server",
          "src",
          "server.js",
        )
        const exists = await Bun.file(js).exists()
        if (!exists) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "yaml-language-server"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
      }
    },
  }

  export const LuaLS: Info = {
    id: "lua-ls",
    root: NearestRoot([
      ".luarc.json",
      ".luarc.jsonc",
      ".luacheckrc",
      ".stylua.toml",
      "stylua.toml",
      "selene.toml",
      "selene.yml",
    ]),
    extensions: [".lua"],
    async resolve(root) {
      let bin = Bun.which("lua-language-server", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading lua-language-server from GitHub releases")

        const releaseResponse = await fetch("https://api.github.com/repos/LuaLS/lua-language-server/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!releaseResponse.ok) {
          log.error("Failed to fetch lua-language-server release info")
          return
        }

        const release = await releaseResponse.json()

        const platform = process.platform
        const arch = process.arch
        let assetName = ""

        let lualsArch: string = arch
        if (arch === "arm64") lualsArch = "arm64"
        else if (arch === "x64") lualsArch = "x64"
        else if (arch === "ia32") lualsArch = "ia32"

        let lualsPlatform: string = platform
        if (platform === "darwin") lualsPlatform = "darwin"
        else if (platform === "linux") lualsPlatform = "linux"
        else if (platform === "win32") lualsPlatform = "win32"

        const ext = platform === "win32" ? "zip" : "tar.gz"

        assetName = `lua-language-server-${release.tag_name}-${lualsPlatform}-${lualsArch}.${ext}`

        const supportedCombos = [
          "darwin-arm64.tar.gz",
          "darwin-x64.tar.gz",
          "linux-x64.tar.gz",
          "linux-arm64.tar.gz",
          "win32-x64.zip",
          "win32-ia32.zip",
        ]

        const assetSuffix = `${lualsPlatform}-${lualsArch}.${ext}`
        if (!supportedCombos.includes(assetSuffix)) {
          log.error(`Platform ${platform} and architecture ${arch} is not supported by lua-language-server`)
          return
        }

        const asset = release.assets.find((a: any) => a.name === assetName)
        if (!asset) {
          log.error(`Could not find asset ${assetName} in latest lua-language-server release`)
          return
        }

        const downloadUrl = asset.browser_download_url
        const downloadResponse = await fetch(downloadUrl, { signal: LSPProcess.signal() })
        if (!downloadResponse.ok) {
          log.error("Failed to download lua-language-server")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        await LSPProcess.mutate(() => Bun.file(tempPath).write(downloadResponse))

        // Unlike zls which is a single self-contained binary,
        // lua-language-server needs supporting files (meta/, locale/, etc.)
        // Extract entire archive to dedicated directory to preserve all files
        const installDir = path.join(Global.Path.bin, `lua-language-server-${lualsArch}-${lualsPlatform}`)

        // Remove old installation if exists
        const stats = await fs.stat(installDir).catch(() => undefined)
        if (stats) {
          await LSPProcess.mutate(() => fs.rm(installDir, { force: true, recursive: true }))
        }

        await LSPProcess.mutate(() => fs.mkdir(installDir, { recursive: true }))

        if (ext === "zip") {
          const ok = await LSPProcess.extractZip(tempPath, installDir)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract lua-language-server archive", { error })
              return false
            })
          if (!ok) return
        } else {
          const ok = await LSPProcess.run({ command: ["tar", "-xzf", tempPath, "-C", installDir] })
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract lua-language-server archive", { error })
              return false
            })
          if (!ok) return
        }

        await LSPProcess.mutate(() => fs.rm(tempPath, { force: true }))

        // Binary is located in bin/ subdirectory within the extracted archive
        bin = path.join(installDir, "bin", "lua-language-server" + (platform === "win32" ? ".exe" : ""))

        if (!(await Bun.file(bin).exists())) {
          log.error("Failed to extract lua-language-server binary")
          return
        }

        if (platform !== "win32") {
          const ok = await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
            .then(() => true)
            .catch((error) => {
              log.error("Failed to set executable permission for lua-language-server binary", {
                error,
              })
            })
          if (!ok) return
        }

        log.info(`installed lua-language-server`, { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const PHPIntelephense: Info = {
    id: "php intelephense",
    extensions: [".php"],
    root: NearestRoot(["composer.json", "composer.lock", ".php-version"]),
    async resolve(root) {
      let binary = Bun.which("intelephense")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "intelephense", "lib", "intelephense.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "intelephense"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
        initialization: {},
      }
    },
  }

  export const Prisma: Info = {
    id: "prisma",
    extensions: [".prisma"],
    root: NearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
    async resolve(root) {
      const prisma = Bun.which("prisma")
      if (!prisma) {
        log.info("prisma not found, please install prisma")
        return
      }
      return {
        command: { command: prisma, args: ["language-server"], cwd: root },
      }
    },
  }

  export const Dart: Info = {
    id: "dart",
    extensions: [".dart"],
    root: NearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
    async resolve(root) {
      const dart = Bun.which("dart")
      if (!dart) {
        log.info("dart not found, please install dart first")
        return
      }
      return {
        command: { command: dart, args: ["language-server", "--lsp"], cwd: root },
      }
    },
  }

  export const Ocaml: Info = {
    id: "ocaml-lsp",
    extensions: [".ml", ".mli"],
    root: NearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
    async resolve(root) {
      const bin = Bun.which("ocamllsp")
      if (!bin) {
        log.info("ocamllsp not found, please install ocaml-lsp-server")
        return
      }
      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }
  export const BashLS: Info = {
    id: "bash",
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    root: async () => ScopeContext.current.directory,
    async resolve(root) {
      let binary = Bun.which("bash-language-server")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "bash-language-server", "out", "cli.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "bash-language-server"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("start")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
      }
    },
  }

  export const TerraformLS: Info = {
    id: "terraform",
    extensions: [".tf", ".tfvars"],
    root: NearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
    async resolve(root) {
      let bin = Bun.which("terraform-ls", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading terraform-ls from GitHub releases")

        const releaseResponse = await fetch("https://api.github.com/repos/hashicorp/terraform-ls/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!releaseResponse.ok) {
          log.error("Failed to fetch terraform-ls release info")
          return
        }

        const release = (await releaseResponse.json()) as {
          tag_name?: string
          assets?: { name?: string; browser_download_url?: string }[]
        }
        const version = release.tag_name?.replace("v", "")
        if (!version) {
          log.error("terraform-ls release did not include a version tag")
          return
        }

        const platform = process.platform
        const arch = process.arch

        const tfArch = arch === "arm64" ? "arm64" : "amd64"
        const tfPlatform = platform === "win32" ? "windows" : platform

        const assetName = `terraform-ls_${version}_${tfPlatform}_${tfArch}.zip`

        const assets = release.assets ?? []
        const asset = assets.find((a) => a.name === assetName)
        if (!asset?.browser_download_url) {
          log.error(`Could not find asset ${assetName} in terraform-ls release`)
          return
        }

        const downloadResponse = await fetch(asset.browser_download_url, { signal: LSPProcess.signal() })
        if (!downloadResponse.ok) {
          log.error("Failed to download terraform-ls")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        await LSPProcess.mutate(() => Bun.file(tempPath).write(downloadResponse))

        const ok = await LSPProcess.extractZip(tempPath, Global.Path.bin)
          .then(() => true)
          .catch((error) => {
            log.error("Failed to extract terraform-ls archive", { error })
            return false
          })
        if (!ok) return
        await LSPProcess.mutate(() => fs.rm(tempPath, { force: true }))

        bin = path.join(Global.Path.bin, "terraform-ls" + (platform === "win32" ? ".exe" : ""))

        if (!(await Bun.file(bin).exists())) {
          log.error("Failed to extract terraform-ls binary")
          return
        }

        if (platform !== "win32") {
          await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
        }

        log.info(`installed terraform-ls`, { bin })
      }

      return {
        command: { command: bin, args: ["serve"], cwd: root },
        initialization: {
          experimentalFeatures: {
            prefillRequiredFields: true,
            validateOnSave: true,
          },
        },
      }
    },
  }

  export const TexLab: Info = {
    id: "texlab",
    extensions: [".tex", ".bib"],
    root: NearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
    async resolve(root) {
      let bin = Bun.which("texlab", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading texlab from GitHub releases")

        const response = await fetch("https://api.github.com/repos/latex-lsp/texlab/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!response.ok) {
          log.error("Failed to fetch texlab release info")
          return
        }

        const release = (await response.json()) as {
          tag_name?: string
          assets?: { name?: string; browser_download_url?: string }[]
        }
        const version = release.tag_name?.replace("v", "")
        if (!version) {
          log.error("texlab release did not include a version tag")
          return
        }

        const platform = process.platform
        const arch = process.arch

        const texArch = arch === "arm64" ? "aarch64" : "x86_64"
        const texPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"
        const ext = platform === "win32" ? "zip" : "tar.gz"
        const assetName = `texlab-${texArch}-${texPlatform}.${ext}`

        const assets = release.assets ?? []
        const asset = assets.find((a) => a.name === assetName)
        if (!asset?.browser_download_url) {
          log.error(`Could not find asset ${assetName} in texlab release`)
          return
        }

        const downloadResponse = await fetch(asset.browser_download_url, { signal: LSPProcess.signal() })
        if (!downloadResponse.ok) {
          log.error("Failed to download texlab")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        await LSPProcess.mutate(() => Bun.file(tempPath).write(downloadResponse))

        if (ext === "zip") {
          const ok = await LSPProcess.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract texlab archive", { error })
              return false
            })
          if (!ok) return
        }
        if (ext === "tar.gz") {
          await LSPProcess.run({ command: ["tar", "-xzf", tempPath], cwd: Global.Path.bin })
        }

        await LSPProcess.mutate(() => fs.rm(tempPath, { force: true }))

        bin = path.join(Global.Path.bin, "texlab" + (platform === "win32" ? ".exe" : ""))

        if (!(await Bun.file(bin).exists())) {
          log.error("Failed to extract texlab binary")
          return
        }

        if (platform !== "win32") {
          await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
        }

        log.info("installed texlab", { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const DockerfileLS: Info = {
    id: "dockerfile",
    extensions: [".dockerfile", "Dockerfile"],
    root: async () => ScopeContext.current.directory,
    async resolve(root) {
      let binary = Bun.which("docker-langserver")
      const args: string[] = []
      if (!binary) {
        const js = path.join(Global.Path.bin, "node_modules", "dockerfile-language-server-nodejs", "lib", "server.js")
        if (!(await Bun.file(js).exists())) {
          if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
          await LSPProcess.run({
            command: [BunProc.which(), "install", "dockerfile-language-server-nodejs"],
            cwd: Global.Path.bin,
            env: {
              ...RuntimeContext.current().host.env,
              BUN_BE_BUN: "1",
            },
          })
        }
        binary = BunProc.which()
        args.push("run", js)
      }
      args.push("--stdio")
      const proc = {
        command: binary,
        args: args,
        cwd: root,
        env: {
          ...RuntimeContext.current().host.env,
          BUN_BE_BUN: "1",
        },
      }
      return {
        command: proc,
      }
    },
  }

  export const Gleam: Info = {
    id: "gleam",
    extensions: [".gleam"],
    root: NearestRoot(["gleam.toml"]),
    async resolve(root) {
      const gleam = Bun.which("gleam")
      if (!gleam) {
        log.info("gleam not found, please install gleam first")
        return
      }
      return {
        command: { command: gleam, args: ["lsp"], cwd: root },
      }
    },
  }

  export const Clojure: Info = {
    id: "clojure-lsp",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    root: NearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
    async resolve(root) {
      let bin = Bun.which("clojure-lsp")
      if (!bin && process.platform === "win32") {
        bin = Bun.which("clojure-lsp.exe")
      }
      if (!bin) {
        log.info("clojure-lsp not found, please install clojure-lsp first")
        return
      }
      return {
        command: { command: bin, args: ["listen"], cwd: root },
      }
    },
  }

  export const Nixd: Info = {
    id: "nixd",
    extensions: [".nix"],
    root: async (file) => {
      // First, look for flake.nix - the most reliable Nix project root indicator
      const flakeRoot = await NearestRoot(["flake.nix"])(file)
      if (flakeRoot && flakeRoot !== ScopeContext.current.directory) return flakeRoot

      // If no flake.nix, fall back to git repository root
      if (ScopeContext.current.worktree && ScopeContext.current.worktree !== ScopeContext.current.directory)
        return ScopeContext.current.worktree

      // Finally, use the instance directory as fallback
      return ScopeContext.current.directory
    },
    async resolve(root) {
      const nixd = Bun.which("nixd")
      if (!nixd) {
        log.info("nixd not found, please install nixd first")
        return
      }
      return {
        command: {
          command: nixd,
          args: [],
          cwd: root,
          env: {
            ...RuntimeContext.current().host.env,
          },
        },
      }
    },
  }

  export const Tinymist: Info = {
    id: "tinymist",
    extensions: [".typ", ".typc"],
    root: NearestRoot(["typst.toml"]),
    async resolve(root) {
      let bin = Bun.which("tinymist", {
        PATH: RuntimeContext.current().host.env["PATH"] + path.delimiter + Global.Path.bin,
      })

      if (!bin) {
        if (Flag.SYNERGY_DISABLE_LSP_DOWNLOAD) return
        log.info("downloading tinymist from GitHub releases")

        const response = await fetch("https://api.github.com/repos/Myriad-Dreamin/tinymist/releases/latest", {
          signal: LSPProcess.signal(),
        })
        if (!response.ok) {
          log.error("Failed to fetch tinymist release info")
          return
        }

        const release = (await response.json()) as {
          tag_name?: string
          assets?: { name?: string; browser_download_url?: string }[]
        }

        const platform = process.platform
        const arch = process.arch

        const tinymistArch = arch === "arm64" ? "aarch64" : "x86_64"
        let tinymistPlatform: string
        let ext: string

        if (platform === "darwin") {
          tinymistPlatform = "apple-darwin"
          ext = "tar.gz"
        } else if (platform === "win32") {
          tinymistPlatform = "pc-windows-msvc"
          ext = "zip"
        } else {
          tinymistPlatform = "unknown-linux-gnu"
          ext = "tar.gz"
        }

        const assetName = `tinymist-${tinymistArch}-${tinymistPlatform}.${ext}`

        const assets = release.assets ?? []
        const asset = assets.find((a) => a.name === assetName)
        if (!asset?.browser_download_url) {
          log.error(`Could not find asset ${assetName} in tinymist release`)
          return
        }

        const downloadResponse = await fetch(asset.browser_download_url, { signal: LSPProcess.signal() })
        if (!downloadResponse.ok) {
          log.error("Failed to download tinymist")
          return
        }

        const tempPath = path.join(Global.Path.bin, assetName)
        await LSPProcess.mutate(() => Bun.file(tempPath).write(downloadResponse))

        if (ext === "zip") {
          const ok = await LSPProcess.extractZip(tempPath, Global.Path.bin)
            .then(() => true)
            .catch((error) => {
              log.error("Failed to extract tinymist archive", { error })
              return false
            })
          if (!ok) return
        } else {
          await LSPProcess.run({ command: ["tar", "-xzf", tempPath, "--strip-components=1"], cwd: Global.Path.bin })
        }

        await LSPProcess.mutate(() => fs.rm(tempPath, { force: true }))

        bin = path.join(Global.Path.bin, "tinymist" + (platform === "win32" ? ".exe" : ""))

        if (!(await Bun.file(bin).exists())) {
          log.error("Failed to extract tinymist binary")
          return
        }

        if (platform !== "win32") {
          await LSPProcess.mutate(() => fs.chmod(bin!, 0o755))
        }

        log.info("installed tinymist", { bin })
      }

      return {
        command: { command: bin, args: [], cwd: root },
      }
    },
  }

  export const HLS: Info = {
    id: "haskell-language-server",
    extensions: [".hs", ".lhs"],
    root: NearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
    async resolve(root) {
      const bin = Bun.which("haskell-language-server-wrapper")
      if (!bin) {
        log.info("haskell-language-server-wrapper not found, please install haskell-language-server")
        return
      }
      return {
        command: { command: bin, args: ["--lsp"], cwd: root },
      }
    },
  }
}
