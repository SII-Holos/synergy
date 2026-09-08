#!/usr/bin/env bun
import path from "node:path"
import { withInstalledPackages, type PackedArchive } from "./package-install-check"

export async function checkRuntimeCompositions(
  archiveDirectory: string,
  modes = ["core", "browser", "library", "note", "computer", "full"],
) {
  const archives: PackedArchive[] = []
  for await (const file of new Bun.Glob("*.tgz").scan(archiveDirectory)) {
    const archive = path.join(archiveDirectory, file)
    const process = Bun.spawn(["tar", "-xOf", archive, "package/package.json"], { stdout: "pipe", stderr: "inherit" })
    const manifest = JSON.parse(await new Response(process.stdout).text())
    if (await process.exited) throw new Error(`Cannot inspect ${archive}`)
    archives.push({ name: manifest.name, version: manifest.version, archive, manifest })
  }
  const fixture = await Bun.file(path.resolve(import.meta.dir, "../test/package/fixture/runtime-composition.ts")).text()
  for (const mode of modes) {
    if (!["core", "browser", "library", "note", "computer", "full"].includes(mode))
      throw new Error(`Unknown runtime composition: ${mode}`)
    const owners: Record<string, string> = {
      browser: "browser-runtime",
      library: "library",
      note: "note",
      computer: "computer-runtime",
      full: "product-runtime",
    }
    const owner = owners[mode]
    const entries =
      mode === "computer"
        ? ["@ericsanchezok/synergy-computer-runtime"]
        : ["@ericsanchezok/synergy-cli", ...(owner ? [`@ericsanchezok/synergy-${owner}`] : [])]
    await withInstalledPackages(archives, entries, async (directory) => {
      const entry = path.join(directory, "composition.ts")
      await Bun.write(
        path.join(directory, "package-boundary.ts"),
        await Bun.file(path.resolve(import.meta.dir, "../test/package/fixture/package-boundary.ts")).text(),
      )
      await Bun.write(
        entry,
        mode === "computer"
          ? await Bun.file(path.resolve(import.meta.dir, "../test/package/fixture/computer-runtime.ts")).text()
          : fixture,
      )
      const env: Record<string, string | undefined> = {
        ...process.env,
        SYNERGY_HOME: path.join(directory, "home"),
        SYNERGY_LINK_HOME: path.join(directory, "link"),
        SYNERGY_TEST_HOME: path.join(directory, "home"),
        SYNERGY_TEST_ROOT: directory,
        SYNERGY_OBSERVABILITY_INLINE: "1",
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          execution: { agentWorkerMinIdle: 0 },
          ...(mode === "full" ? { pluginMarketplace: { enabled: false }, boss: { enabled: false } } : {}),
          ...(mode === "full" || mode === "library"
            ? {
                library: {
                  memory: { enabled: false },
                  experience: { retrieve: false, encode: false },
                  autonomy: false,
                },
              }
            : {}),
        }),
      }
      delete env.NODE_PATH
      delete env.NODE_OPTIONS
      delete env.MODELS_DEV_API_JSON
      if (mode === "core") {
        const cli = Bun.spawn([process.execPath, path.join(directory, "node_modules/.bin/synergy"), "--help"], {
          cwd: directory,
          env,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, help, error] = await Promise.all([
          cli.exited,
          new Response(cli.stdout).text(),
          new Response(cli.stderr).text(),
        ])
        if (code || !help.includes("send")) throw new Error(`Installed CLI help failed: ${error}`)
      }
      const child = Bun.spawn([process.execPath, entry, mode], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
      const timeout = setTimeout(() => child.kill(), 45_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(`${mode} installed runtime failed (${code})\n${stdout}\n${stderr}`)
        const lines = stdout.trim().split("\n")
        const result = JSON.parse(lines.at(-1)!)
        const boundary = lines
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return undefined
            }
          })
          .find((line) => line?.installedClosure)
        if (!boundary?.privateExportsRejected || boundary.publicEntries !== 8)
          throw new Error(`${mode} did not verify installed public boundaries`)
        console.log(JSON.stringify({ mode, ...boundary }))
        if (!result.executed || !result.closed || result.mode !== mode)
          throw new Error(`${mode} did not complete its lifecycle`)
        console.log(
          `PASS installed ${mode}: operation persisted, resources closed, process exited${mode === "full" ? "" : ", unrelated capabilities absent"}`,
        )
      } finally {
        clearTimeout(timeout)
      }
    })
  }
}

if (import.meta.main)
  await checkRuntimeCompositions(
    path.resolve(process.argv[2] ?? ".artifacts/packages"),
    process.argv.length > 3 ? process.argv.slice(3) : undefined,
  )
