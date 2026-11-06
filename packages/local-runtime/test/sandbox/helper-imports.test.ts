import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test("embedded helper digests import without a Runtime and still reject modified helper bytes", async () => {
  await using fixture = await runtimeHome()
  const helper = path.join(fixture.host.home, "helper")
  const bytes = "packaged helper fixture"
  await Bun.write(helper, bytes)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const source = `
    const { TRUSTED_LINUX_HELPER_HASHES: linux } = await import("./src/sandbox/linux.ts");
    const { TRUSTED_WINDOWS_HELPER_HASHES: windows } = await import("./src/sandbox/windows.ts");
    const { verifyHelperHash } = await import("./src/sandbox/utils.ts");
    const helper = ${JSON.stringify(helper)};
    for (const hashes of [linux, windows]) {
      if (Object.values(hashes).join() !== ${JSON.stringify(digest)}) throw new Error("Embedded digest lost");
      if (!verifyHelperHash(helper, hashes)) throw new Error("Verified helper rejected");
    }
    await Bun.write(helper, "modified helper fixture");
    for (const hashes of [linux, windows]) {
      if (verifyHelperHash(helper, hashes)) throw new Error("Modified helper accepted");
    }
  `
  const child = Bun.spawn(
    [process.execPath, "--define", `SYNERGY_SANDBOX_HELPER_SHA256=${JSON.stringify(digest)}`, "--eval", source],
    { cwd: path.resolve(import.meta.dir, "../.."), env: fixture.host.env, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
})
