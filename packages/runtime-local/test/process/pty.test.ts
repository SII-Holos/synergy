import { expect, test } from "bun:test"
import { Pty } from "../../src/process/pty"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"

test.skipIf(process.platform === "win32")(
  "local PTY accepts input, emits native output and releases its session",
  async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      async fn() {
        const info = await Pty.create({ command: "/bin/cat", cwd: directory.path })
        let output = ""
        let resolveOutput!: () => void
        let closed = false
        const received = new Promise<void>((resolve) => {
          resolveOutput = resolve
        })
        try {
          Pty.connect(info.id, {
            readyState: 1,
            send(data) {
              output += data
              if (output.includes("local-pty-owned")) resolveOutput()
            },
            close() {
              closed = true
            },
          })
          await Pty.update(info.id, { title: "Research terminal", size: { cols: 100, rows: 40 } })
          expect(Pty.get(info.id)?.title).toBe("Research terminal")
          Pty.write(info.id, "local-pty-owned\n")
          await received
          expect(output).toContain("local-pty-owned")
        } finally {
          await Pty.remove(info.id)
        }
        expect(closed).toBe(true)
        expect(Pty.get(info.id)).toBeUndefined()
      },
    })
  },
  30_000,
)
