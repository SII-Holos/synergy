import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("cleanup help and rejected private requests do not provision a Home", async () => {
  const home = path.join(process.env.SYNERGY_TEST_ROOT!, `cleanup-input-${crypto.randomUUID()}`)
  async function invoke(args: string[], input: unknown = {}) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-bunfig",
        path.resolve(import.meta.dir, "../src/entry.ts"),
        "cleanup",
        ...args,
      ],
      {
        env: {
          ...process.env,
          SYNERGY_HOME: home,
          SYNERGY_TEST_HOME: home,
          SYNERGY_RUNTIME_ROOT: undefined,
          NODE_OPTIONS: undefined,
          NODE_PATH: undefined,
        },
        stdin: Buffer.from(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  const help = await invoke(["--help"])
  expect(help.code, help.stderr).toBe(0)
  for (const command of ["list", "inspect", "retire", "source-receipt"]) expect(help.stdout).toContain(command)
  const canary = "private-cleanup-input-must-not-be-printed"
  for (const [args, request] of [
    [["list", "--limit", "0"], {}],
    [
      ["list"],
      {
        version: 1,
        identity: { orgID: "org", accountID: "account", deviceID: "device" },
        deploymentIncarnation: "deployment",
        ticket: canary,
      },
    ],
    [
      ["source-receipt"],
      {
        version: 1,
        identity: { orgID: "org", accountID: "account", deviceID: "device" },
        deploymentIncarnation: "deployment",
      },
    ],
    [
      ["retire"],
      {
        version: 1,
        identity: { orgID: "org", accountID: "account", deviceID: "device" },
        deploymentIncarnation: "deployment",
      },
    ],
  ] as const) {
    const rejected = await invoke([...args], request)
    expect(rejected.code).not.toBe(0)
    expect(rejected.stdout + rejected.stderr).not.toContain(canary)
  }
  expect(await fs.stat(home).catch(() => undefined)).toBeUndefined()
})
