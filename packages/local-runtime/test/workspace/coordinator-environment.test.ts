import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

function request(root: string) {
  return { id: crypto.randomUUID(), owner: crypto.randomUUID(), ancestors: [], kind: "task" as const, roots: [root] }
}

test("independent processes retain host write exclusion with different temporary-directory environments", async () => {
  await using tmp = await tmpdir()
  const alternate = path.join(tmp.path, "temporary")
  await fs.mkdir(alternate)
  const module = path.resolve(import.meta.dir, "../../src/workspace/coordinator.ts")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { WorkspaceCoordinator } from ${JSON.stringify(module)};
    const lease = await new WorkspaceCoordinator().acquire(${JSON.stringify(request(tmp.path))});
    console.log("ready");
    await new Promise(resolve => process.stdin.once("data", resolve));
    await lease.release();
  `,
    ],
    {
      env: { ...process.env, TMPDIR: alternate, TEMP: alternate, TMP: alternate },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const coordinator = new WorkspaceCoordinator()
  const reader = child.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready")
    const result = await coordinator.acquire({ ...request(tmp.path), timeoutMs: 200 }).then(
      async (lease) => {
        await lease.release()
        return "admitted"
      },
      (error: unknown) => error,
    )
    expect(result).toBeInstanceOf(WorkspaceAccess.BusyError)
    child.stdin.write("release\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)
    const admitted = await coordinator.acquire({ ...request(tmp.path), timeoutMs: 1000 })
    await admitted.release()
  } finally {
    reader.releaseLock()
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}, 10_000)
