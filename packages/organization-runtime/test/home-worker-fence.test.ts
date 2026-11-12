import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { workerPlan } from "@ericsanchezok/synergy-agent-runtime/workers"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { version } from "../package.json" with { type: "json" }
import { prepareHostedHome, prepareMemberHome, runtimeIdentityDigest } from "../src/home"

for (const reader of ["legacy", "maintenance", "before-origin", "before-use"] as const) {
  test(`real pinned agent and policy workers with the previous ${reader} reader refuse the current native Home`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "native-worker-fence-"))
    try {
      const input = { baseDirectory: directory, origin: "https://organization.example" }
      const home =
        reader === "legacy"
          ? await prepareMemberHome({ ...input, identity: { orgID: "org", accountID: "member", deviceID: "device" } })
          : await prepareHostedHome({ ...input, identity: { orgID: "org", hostID: "hosted" } })
      const filename = path.join(home.root, "home-ownership.json")
      const current = await fs.readFile(filename, "utf8")
      const component = {
        id: "organization-runtime",
        version,
        apiVersion: 1 as const,
        register() {
          throw new Error("Legacy fixture can only register in a worker")
        },
        workers: {
          agent: new URL("./support/legacy-worker.ts", import.meta.url),
          policy: new URL("./support/legacy-worker.ts", import.meta.url),
        },
      }
      const plan = workerPlan([component], FeatureSelection.resolve([component]))
      async function worker(role: "agent" | "policy") {
        let ready = false
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "run",
            "--no-env-file",
            `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
            new URL(`../../agent-runtime/src/${role}-worker.ts`, import.meta.url).pathname,
          ],
          cwd: home.root,
          env: {
            ...process.env,
            SYNERGY_HOME: home.home,
            SYNERGY_RUNTIME_ROOT: home.root,
            SYNERGY_MEMBER_IDENTITY: JSON.stringify(home.identity),
            SYNERGY_WORKER_COMPONENTS: JSON.stringify(plan),
            SYNERGY_LEGACY_READER: reader,
            SYNERGY_AGENT_PARENT_PID: String(process.pid),
            SYNERGY_POLICY_PARENT_PID: String(process.pid),
          },
          ipc(message: unknown) {
            if (message && typeof message === "object" && "type" in message && message.type === "ready") {
              ready = true
              child.send({ type: "shutdown" })
            }
          },
          stdout: "ignore",
          stderr: "pipe",
          timeout: 15000,
        })
        const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
        return { code, ready, error }
      }
      for (const role of ["agent", "policy"] as const) {
        await fs.writeFile(
          filename,
          JSON.stringify({
            schemaVersion: reader === "legacy" ? 1 : 2,
            owner: "organization-runtime",
            identity: runtimeIdentityDigest(home.identity),
            ...(reader === "maintenance"
              ? { readerContract: "purpose-bound-maintenance-v1" }
              : reader === "before-origin"
                ? { readerContract: "native-organization-ownership-v1" }
                : reader === "before-use"
                  ? { readerContract: "native-organization-ownership-v2" }
                  : {}),
          }),
        )
        const before = await worker(role)
        expect(before).toMatchObject({ code: 0, ready: true })
        await fs.writeFile(filename, current)
        const after = await worker(role)
        expect(after.code).not.toBe(0)
        expect(after.ready).toBe(false)
        expect(after.error).toContain("Home owner format requires its explicit migration")
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 30000)
}
