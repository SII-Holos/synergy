import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

for (const managed of [undefined, "1"]) {
  test(`ACP startup keeps migrations silent with Desktop progress ${managed ?? "unset"}`, async () => {
    await using tmp = await tmpdir()
    for (const state of ["fresh", "up-to-date"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--conditions=browser",
          "src/index.ts",
          "acp",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
          "--cwd",
          tmp.path,
        ],
        {
          cwd: import.meta.dir + "/../..",
          env: {
            ...process.env,
            SYNERGY_HOME: `${tmp.path}/home`,
            SYNERGY_CWD: tmp.path,
            SYNERGY_DESKTOP_STARTUP_PROGRESS: managed,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stderr = new Response(child.stderr).text()
      const timeout = setTimeout(() => child.kill(), 20_000)
      try {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + "\n",
        )
        await child.stdin.flush()
        const reader = child.stdout.getReader()
        let output = ""
        while (!output.includes("\n")) {
          const { value, done } = await reader.read()
          if (done) break
          output += new TextDecoder().decode(value)
        }
        const firstLine = output.split("\n")[0]!
        expect(firstLine, state).toStartWith("{")
        expect(JSON.parse(firstLine)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }
      expect(await stderr, state).not.toMatch(/up.to.date|Starting \[|SYNERGY_STARTUP_V1/)
    }
  }, 60_000)
}
