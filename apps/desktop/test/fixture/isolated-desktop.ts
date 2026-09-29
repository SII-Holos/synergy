import { mkdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export async function prepareIsolatedDesktop(home: string, appURL: string) {
  const url = new URL(appURL)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password)
    throw new Error("Desktop acceptance requires an explicit loopback HTTP port")
  const selectedHome = await realpath(home)
  if (selectedHome === (await realpath(homedir()))) throw new Error("Desktop acceptance requires an isolated home")
  const directory = path.join(selectedHome, ".synergy", "desktop-acceptance")
  const userData = path.join(directory, "user-data")
  await mkdir(userData, { recursive: true })
  const wrapper = path.join(directory, "entry.mjs")
  await Bun.write(
    wrapper,
    [
      'import { app } from "electron"',
      'import { pathToFileURL } from "node:url"',
      `app.setPath("userData", ${JSON.stringify(userData)})`,
      "await import(pathToFileURL(process.env.SYNERGY_ACCEPTANCE_ENTRY).href)",
    ].join("\n"),
  )
  return { home: selectedHome, appURL: url.href, userData, wrapper, directory }
}

if (import.meta.main) {
  const [home, appURL] = process.argv.slice(2)
  if (!home || !appURL) throw new Error("Usage: isolated-desktop.ts <isolated-home> <app-url>")
  const options = await prepareIsolatedDesktop(home, appURL)
  const entry = path.resolve(import.meta.dir, "../../dist/main.js")
  if (!(await Bun.file(entry).exists())) throw new Error("Build Desktop before launching acceptance")
  const manifest = Bun.file(path.join(options.directory, "process.json"))
  if (await manifest.exists()) {
    const previous = (await manifest.json()) as { pid: number; running: boolean }
    if (previous.running) {
      let alive = false
      try {
        process.kill(previous.pid, 0)
        alive = true
      } catch {}
      if (alive) throw new Error("The selected Desktop acceptance home already has a running process")
    }
  }
  const log = Bun.file(path.join(options.directory, "desktop.log"))
  await Bun.write(log, "")
  const child = Bun.spawn([path.resolve(import.meta.dir, "../../node_modules/.bin/electron"), options.wrapper], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      SYNERGY_HOME: options.home,
      SYNERGY_DESKTOP_CHANNEL: "dev",
      SYNERGY_DESKTOP_SERVER_MODE: "external",
      SYNERGY_DESKTOP_APP_URL: options.appURL,
      SYNERGY_ACCEPTANCE_ENTRY: entry,
    },
    stdin: "ignore",
    stdout: log,
    stderr: log,
  })
  const close = () => child.kill("SIGTERM")
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  await Bun.write(manifest, JSON.stringify({ pid: child.pid, running: true, ...options }, null, 2))
  console.log(`Isolated Desktop PID ${child.pid}; diagnostics: ${options.directory}`)
  const code = await child.exited
  process.off("SIGINT", close)
  process.off("SIGTERM", close)
  await Bun.write(manifest, JSON.stringify({ pid: child.pid, running: false, exitCode: code, ...options }, null, 2))
  process.exitCode = code
}
