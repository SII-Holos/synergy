import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test("public compositions and CLI setup import without opening a Runtime or starting background work", async () => {
  await using fixture = await runtimeHome()
  const before = (await fs.readdir(fixture.host.home, { recursive: true })).toSorted()
  const root = path.resolve(import.meta.dir, "../../../..")
  const entries = [
    "packages/harness/src/index.ts",
    "packages/local-runtime/src/index.ts",
    "packages/server/src/server/server.ts",
    "packages/presets/src/index.ts",
    "packages/presets/src/daemon-entry.ts",
    "packages/presets/src/registration.ts",
    "packages/presets/src/server/routes.ts",
    "packages/cli/src/main.ts",
    "packages/cli/src/setup/config.ts",
  ].map((entry) => path.join(root, entry))
  const source = `
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error("Unexpected import-time network request"); };
    for (const entry of ${JSON.stringify(entries)}) await import(entry);
    if (requests) throw new Error("Import started network requests");
    const after = process.eventNames().map(name => [name, process.listenerCount(name)]);
    if (JSON.stringify(after) !== JSON.stringify(listeners)) throw new Error("Import installed process listeners");
    console.log("imports are inert");
  `
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: root,
    env: { ...fixture.host.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout.trim()).toBe("imports are inert")
    expect((await fs.readdir(fixture.host.home, { recursive: true })).toSorted()).toEqual(before)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
  }
}, 20_000)
