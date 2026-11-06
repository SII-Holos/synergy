import { expect, test } from "bun:test"
import { text } from "node:stream/consumers"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { OwnedProcess } from "../../src/process/owned-process"

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a host-owned worker retains its activation barrier and whole-tree release without a Workspace lease",
  async () => {
    await using directory = await tmpdir()
    let reference: OwnedProcess.Reference | undefined
    let releases = 0
    const owned = await OwnedProcess.prepare({
      command: process.execPath,
      args: ["-e", "process.stdout.write('worker-result')"],
      cwd: directory.path,
      env: {},
      ownership: {
        async bindProcess(_pid, options) {
          reference = options.reference
          expect(OwnedProcess.inspect(reference).state).toBe("active")
        },
        async release() {
          if (reference) expect(OwnedProcess.inspect(reference).state).toBe("exited")
          releases++
        },
      },
    })
    const output = text(owned.child.stdout)
    const error = text(owned.child.stderr)
    try {
      expect(reference).toBeDefined()
      expect(owned.child.pid).toBeUndefined()
      expect(releases).toBe(0)
      await owned.activate()
      owned.child.stdin.end()
      await owned.completion
      expect(await output).toBe("worker-result")
      expect(await error).toBe("")
      expect(releases).toBe(1)
    } finally {
      await owned.stop()
      await Promise.allSettled([output, error])
    }
  },
  20_000,
)
