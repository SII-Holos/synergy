import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("the session-export adapter preserves task HOME and XDG paths while isolating Synergy data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-task-environment-"))
  let child: Bun.Subprocess | undefined
  try {
    const logs = path.join(root, "logs")
    const taskHome = path.join(root, "task-home")
    const marker = path.join(root, "started.json")
    const observed = path.join(root, "environment.json")
    const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SYNERGY_HOME"]
    const inherited = {
      HOME: taskHome,
      XDG_CONFIG_HOME: path.join(taskHome, "config"),
      XDG_DATA_HOME: path.join(taskHome, "data"),
      XDG_CACHE_HOME: path.join(taskHome, "cache"),
    }
    await mkdir(taskHome)
    await writeFile(
      path.join(root, "native.mjs"),
      `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({started_at:Date.now()}));
await Bun.write(${JSON.stringify(observed)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))));
console.log(JSON.stringify({type:"step_finish",part:{reason:"stop"}}));`,
    )
    await writeFile(
      path.join(root, "options.json"),
      JSON.stringify({
        harness: "synergy",
        runtime_protocol: "synergy-session-v1",
        native: {
          argv: [process.execPath, path.join(root, "native.mjs")],
          files: {},
          env: { SYNERGY_HOME: path.join(logs, "home"), BENCH_GATEWAY_BASE: "http://127.0.0.1:9/v1" },
        },
        execution_marker: marker,
        startup_timeout_seconds: 5,
        timeout_seconds: 2,
        cleanup_seconds: 1,
        export_timeout_seconds: 5,
      }),
    )
    await writeFile(path.join(root, "instruction.md"), "Inspect the task environment")
    await writeFile(path.join(root, "credentials.json"), "{}", { mode: 0o600 })
    const running = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../runtime/external.mjs"),
        path.join(root, "options.json"),
        path.join(root, "instruction.md"),
        logs,
        path.join(root, "credentials.json"),
      ],
      { env: { ...process.env, ...inherited }, stdout: "pipe", stderr: "pipe" },
    )
    child = running
    const [code, stdout, stderr] = await Promise.all([
      running.exited,
      new Response(running.stdout).text(),
      new Response(running.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual({
      ...inherited,
      SYNERGY_HOME: path.join(logs, "home"),
    })
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGTERM")
      await child.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
