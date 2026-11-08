import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { version } from "../package.json" with { type: "json" }

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url))

test("core workers register their Home owner before initialization and reject a different owner", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "core-worker-owner-"))
  const worker = path.join(directory, "worker.ts")
  const ownership = pathToFileURL(
    Bun.resolveSync("@ericsanchezok/synergy-harness/lifecycle/home-ownership", import.meta.dir),
  ).href
  await Bun.write(
    worker,
    `
import { HomeOwnership } from ${JSON.stringify(ownership)}
export const metadata = { id: "fixture-owner", version: ${JSON.stringify(version)}, apiVersion: 1 }
export function registerWorker() {
  HomeOwnership.select({ owner: "fixture-owner", identity: "a".repeat(64) })
}
`,
  )
  const component = { id: "fixture-owner", version, features: { kind: "foundation" as const, definitions: [] } }
  const selection = { id: component.id, version, entry: pathToFileURL(worker).href }
  const plan = {
    apiVersion: 2,
    agent: [selection],
    policy: [selection],
    features: FeatureSelection.resolve([component]),
  }
  try {
    for (const role of ["agent", "policy"] as const) {
      for (const matches of [true, false]) {
        const home = path.join(directory, role + "-" + matches)
        const root = path.join(home, ".synergy")
        const context = RuntimeContext.create(createLocalHost({ home, root }))
        try {
          await context.run(async () => {
            HomeOwnership.select({ owner: component.id, identity: (matches ? "a" : "b").repeat(64) })
            await HomeOwnership.persist()
          })
        } finally {
          context.dispose()
        }
        const ready = Promise.withResolvers<number>()
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "--no-bunfig",
            entry,
            role === "agent" ? "__agent-turn-runner" : "__policy-worker-runner",
          ],
          {
            cwd: home,
            env: {
              ...process.env,
              SYNERGY_HOME: home,
              SYNERGY_RUNTIME_ROOT: root,
              SYNERGY_INSTALLATION_ROOT: undefined,
              SYNERGY_INSTALLATION_PIN: undefined,
              SYNERGY_LAUNCHER_COMMAND: undefined,
              SYNERGY_WORKER_COMPONENTS: JSON.stringify(plan),
              SYNERGY_AGENT_PARENT_PID: String(process.pid),
              SYNERGY_POLICY_PARENT_PID: String(process.pid),
            },
            ipc(message: unknown) {
              if (
                message &&
                typeof message === "object" &&
                "type" in message &&
                message.type === "ready" &&
                "pid" in message
              )
                ready.resolve(Number(message.pid))
            },
            stdout: "ignore",
            stderr: "pipe",
            timeout: 8000,
          },
        )
        const errors = new Response(child.stderr).text()
        try {
          if (matches) {
            const result = await Promise.race([
              ready.promise,
              child.exited.then(async () => {
                throw new Error(await errors)
              }),
            ])
            expect(result).toBe(child.pid)
            child.send({ type: "shutdown" })
            expect(await child.exited).toBe(0)
          } else {
            expect(await child.exited).toBe(1)
            expect(await errors).toContain("Home owner")
            expect(
              await fs.access(path.join(root, "config")).then(
                () => true,
                () => false,
              ),
            ).toBe(false)
          }
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
          await errors
        }
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20000)
