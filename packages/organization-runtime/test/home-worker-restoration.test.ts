import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import * as Native from "@ericsanchezok/synergy-harness/lifecycle/home-restoration-file"
import { workerPlan } from "@ericsanchezok/synergy-agent-runtime/workers"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { version } from "../package.json" with { type: "json" }
import { prepareHostedHome, readHostedHome } from "../src/home"

for (const role of ["agent", "policy"] as const)
  test(`the actual ${role} worker selects its completed native Home3 and rejects invalid restoration ownership`, async () => {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "restored-worker-home-"))
    try {
      const home = await prepareHostedHome({
        baseDirectory: directory,
        identity: { orgID: "organization", hostID: "restored-worker" },
        origin: "https://organization.example",
      })
      const ownerFile = path.join(home.root, "home-ownership.json")
      const original = HomeOwnershipFile.FencedInfo.parse(JSON.parse(await fs.readFile(ownerFile, "utf8")))
      const restoration = HomeOwnershipFile.RestorationInfo.parse({
        ...original,
        schemaVersion: 3,
        installationID: crypto.randomUUID(),
        incarnation: crypto.randomUUID(),
      })
      const base = Native.StagingDisk.parse({
        schemaVersion: 1,
        phase: "staging",
        restoreID: "native-worker",
        owner: "organization-runtime",
        sourceHash: "a".repeat(64),
        requestHash: "b".repeat(64),
        installationID: restoration.installationID,
        incarnation: restoration.incarnation,
        target: {
          home: await fs.realpath(home.home),
          root: await fs.realpath(home.root),
          homeIdentity: await Native.physical(home.home),
          rootIdentity: await Native.physical(home.root),
          storageHash: "c".repeat(64),
          artifacts: {
            kind: "future",
            directory: path.join(home.root, "artifacts"),
            parent: home.root,
            parentIdentity: await Native.physical(home.root),
          },
        },
      })
      const staged = JSON.stringify(base) + "\n"
      const completed = staged + Native.completion(base, "d".repeat(64))
      await fs.writeFile(ownerFile, JSON.stringify(restoration) + "\n")
      await fs.writeFile(Native.filename(home.root), completed)
      const selected = await readHostedHome(home.home, home.identity)
      expect(selected.restoration).toEqual(restoration)
      const component = {
        id: "organization-runtime",
        version,
        apiVersion: 1 as const,
        register() {
          throw new Error("Worker-only composition")
        },
        workers: {
          agent: new URL("../src/worker.ts", import.meta.url),
          policy: new URL("../src/worker.ts", import.meta.url),
        },
      }
      const plan = workerPlan([component], FeatureSelection.resolve([component]))
      async function worker(identity = selected.identity) {
        let ready = false
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "run",
            "--no-env-file",
            `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
            new URL(`../../agent-runtime/src/${role}-worker.ts`, import.meta.url).pathname,
          ],
          cwd: selected.root,
          env: {
            ...process.env,
            SYNERGY_HOME: selected.home,
            SYNERGY_RUNTIME_ROOT: selected.root,
            SYNERGY_MEMBER_IDENTITY: JSON.stringify(identity),
            SYNERGY_WORKER_COMPONENTS: JSON.stringify(plan),
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
        try {
          const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
          return { code, ready, error }
        } finally {
          if (child.exitCode === null) child.kill()
          await child.exited
        }
      }
      const positive = await worker()
      expect(positive.code, positive.error).toBe(0)
      expect(positive.ready).toBe(true)
      const credentialFile = path.join(home.root, "auth", "organization-runtime.json")
      const credentials = await fs.readFile(credentialFile)
      const denied = async (identity = selected.identity) => {
        const owner = await fs.readFile(ownerFile),
          intent = await fs.readFile(Native.filename(home.root))
        const result = await worker(identity)
        expect(result.code).not.toBe(0)
        expect(result.ready).toBe(false)
        expect(await fs.readFile(ownerFile)).toEqual(owner)
        expect(await fs.readFile(Native.filename(home.root))).toEqual(intent)
        expect(await fs.readFile(credentialFile)).toEqual(credentials)
      }
      await fs.writeFile(Native.filename(home.root), staged)
      await denied()
      await fs.writeFile(Native.filename(home.root), completed)
      await fs.writeFile(ownerFile, JSON.stringify({ ...restoration, installationID: crypto.randomUUID() }))
      await denied()
      await fs.writeFile(ownerFile, JSON.stringify(restoration))
      await denied({ ...selected.identity, hostID: "foreign-worker" })
      await fs.writeFile(ownerFile, JSON.stringify({ ...restoration, readerContract: "future-native-reader" }))
      await denied()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 30000)
