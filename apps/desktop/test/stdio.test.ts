import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installDesktopStdioHandlers } from "../src/stdio"

async function closedPipe(stream: "stdout" | "stderr", electron = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-desktop-stdio-"))
  try {
    const build = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../src/stdio.ts")],
      outdir: directory,
      target: "node",
    })
    expect(build.success).toBe(true)
    const script = path.join(directory, "fixture.mjs")
    await Bun.write(
      script,
      `
      ${electron ? 'import { app } from "electron";' : ""}
      import { installDesktopStdioHandlers } from ${JSON.stringify(path.join(directory, "stdio.js"))};
      installDesktopStdioHandlers();
      ${electron ? `app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});` : ""}
      const run = () => process.stdin.once("data", () => {
        process.${stream}.write("first log");
        setTimeout(() => {
          console.${stream === "stdout" ? "log" : "error"}("second log");
          process.emitWarning("fixture warning");
          setTimeout(() => ${electron ? "app.exit(0)" : "process.exit(0)"}, 20);
        }, 20);
      });
      ${electron ? "void app.whenReady().then(run);" : "run();"}
    `,
    )
    const executable = electron
      ? (process.env.SYNERGY_DESKTOP_ELECTRON_BIN ??
        path.join(
          import.meta.dir,
          "../node_modules/electron/dist",
          (await Bun.file(path.join(import.meta.dir, "../node_modules/electron/path.txt")).text()).trim(),
        ))
      : "node"
    const child = Bun.spawn(
      [executable, ...(electron && process.platform === "linux" ? ["--no-sandbox"] : []), script],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    try {
      await child[stream].cancel()
      child.stdin.write("write")
      child.stdin.end()
      const output = new Response(stream === "stdout" ? child.stderr : child.stdout).text()
      const timeout = setTimeout(() => child.kill(), 10_000)
      const exitCode = await child.exited
      clearTimeout(timeout)
      const text = await output
      expect({ exitCode, failure: exitCode ? text : "" }).toEqual({ exitCode: 0, failure: "" })
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test.each(["stdout", "stderr"] as const)("Desktop survives a closed %s pipe and repeated logging", (stream) =>
  closedPipe(stream),
)

const runtimeTest = process.env.SYNERGY_DESKTOP_RUNTIME_TEST === "1" ? test : test.skip
for (const stream of ["stdout", "stderr"] as const)
  runtimeTest(`Electron survives a closed ${stream} pipe and process warnings`, () => closedPipe(stream, true), 15_000)

test("Desktop ignores only broken output pipes", () => {
  const streams = [process.stdout, process.stderr]
  const previous = streams.map((stream) => new Set(stream.listeners("error")))
  installDesktopStdioHandlers()
  try {
    for (const stream of streams) {
      expect(() => stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).not.toThrow()
      const failure = Object.assign(new Error("fixture output failure"), { code: "EIO" })
      expect(() => stream.emit("error", failure)).toThrow(failure)
    }
  } finally {
    for (const [index, stream] of streams.entries())
      for (const listener of stream.listeners("error"))
        if (!previous[index]!.has(listener)) stream.removeListener("error", listener)
  }
})
