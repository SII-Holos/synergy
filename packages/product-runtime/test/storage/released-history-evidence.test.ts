import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test.each(["text", "tool", "recovery"] as const)(
  "released 3.0.22 %s history prepares evidence before publication",
  async (kind) => {
    await using tmp = await tmpdir()
    const fixture = await Bun.file(
      new URL("../../../harness/test/storage/fixtures/v3.0.22.json", import.meta.url),
    ).json()
    const ledger = await Bun.file(new URL("./fixtures/v3.0.22-migration-ledger.json", import.meta.url)).json()
    const data = path.join(tmp.path, ".synergy", "data")
    const sessionID = fixture.records[0].value.id
    const messageID = "msg_00000000000000000000000002"
    const partID = "prt_00000000000000000000000002"
    const output = "retained historical tool output"
    if (kind === "recovery") fixture.records[0].value.working = { status: "busy" }
    if (kind !== "text") {
      fixture.records.push(
        {
          key: ["sessions", "home", sessionID, "messages", messageID, "info"],
          value: {
            id: messageID,
            sessionID,
            role: "assistant",
            parentID: fixture.records[2].value.id,
            rootID: fixture.records[2].value.id,
            agent: "synergy",
            mode: "synergy",
            modelID: "gpt-4.1",
            providerID: "openai",
            path: { cwd: tmp.path, root: tmp.path },
            time: { created: 1700000000001, completed: 1700000000002 },
            cost: 1,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
        },
        {
          key: ["sessions", "home", sessionID, "messages", messageID, "parts", partID],
          value: {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            tool: "read",
            callID: "historical-read",
            state: { status: "completed", input: {}, output, title: "read", metadata: {}, time: { start: 1, end: 2 } },
          },
        },
      )
    }
    for (const record of fixture.records) {
      const file = path.join(data, ...record.key) + ".json"
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(
        file,
        JSON.stringify(
          record.key.join("/") === "meta/migration/log"
            ? Object.fromEntries(ledger.completed.map((id: string) => [id, 1]))
            : record.value,
        ),
      )
    }
    const harness = new URL("../../../harness/src/", import.meta.url).pathname
    const registration = new URL("../../src/product-registration.ts", import.meta.url).pathname
    const script = `
    const { registerProductRuntime } = await import(${JSON.stringify(registration)});
    const { RuntimeContext } = await import(${JSON.stringify(path.join(harness, "lifecycle/context.ts"))});
    const runtime = RuntimeContext.create({ home: process.env.SYNERGY_HOME, root: ${JSON.stringify(path.join(tmp.path, ".synergy"))}, env: { ...process.env } });
    await runtime.run(async () => {
    registerProductRuntime();
    const { StorageMaintenance } = await import(${JSON.stringify(path.join(harness, "storage/maintenance.ts"))});
    const { SessionCompat } = await import(${JSON.stringify(path.join(harness, "session/compat-import.ts"))});
    const { Session } = await import(${JSON.stringify(path.join(harness, "session/index.ts"))});
    const { Scope } = await import(${JSON.stringify(path.join(harness, "scope/index.ts"))});
    const { ScopeContext } = await import(${JSON.stringify(path.join(harness, "scope/context.ts"))});
    const { Storage } = await import(${JSON.stringify(path.join(harness, "storage/storage.ts"))});
    const { SessionPreparingError } = await import(${JSON.stringify(path.join(harness, "storage/errors.ts"))});
    const { RolloutArtifact } = await import(${JSON.stringify(path.join(harness, "session/rollout/artifact.ts"))});
    await using handle = await StorageMaintenance.open();
    if (handle.manifest.phase !== "active") throw new Error("Global authority did not activate");
    if ((await SessionCompat.stats()).pending !== (restart || ${kind === "recovery"} ? 0 : 1)) throw new Error("Release upgrade waited for all history");
    await ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create({ title: "New work" }) });
    if ((await SessionCompat.stats()).pending !== (restart || ${kind === "recovery"} ? 0 : 1)) throw new Error("Creating new work imported unrelated history");
    try {
      await SessionCompat.requireImported(${JSON.stringify(fixture.records[0].value.id)});
    } catch (error) {
      if (!(error instanceof SessionPreparingError)) throw error;
      await SessionCompat.ensureImported(${JSON.stringify(fixture.records[0].value.id)});
    }
    if ((await SessionCompat.stats()).imported !== 1) throw new Error("Requested history did not converge");
    if (${kind !== "text"}) {
      const owner = { kind: "session", scopeID: "home", sessionID: ${JSON.stringify(sessionID)} };
      const part = await Storage.read(["sessions", "home", owner.sessionID, "messages", ${JSON.stringify(messageID)}, "parts", ${JSON.stringify(partID)}]);
      if (!part.state.outputArtifact) throw new Error("Tool evidence was not migrated");
      const chunks = [];
      for await (const chunk of RolloutArtifact.read(owner, part.state.outputArtifact)) chunks.push(chunk);
      if (Buffer.concat(chunks).toString() !== ${JSON.stringify(output)}) throw new Error("Historical output bytes changed");
      if ((await RolloutArtifact.list(owner)).length !== 1) throw new Error("Migration duplicated tool evidence");
    }
    if ((await handle.store.verify()).issues.length) throw new Error("Store verification failed");
    });
  `
    const env: NodeJS.ProcessEnv = { ...process.env, SYNERGY_HOME: tmp.path }
    delete env.SYNERGY_STORAGE_COMPAT_DEFER
    for (const restart of [false, true]) {
      const child = Bun.spawn([process.execPath, "-e", `const restart = ${restart};\n${script}`], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ])
      expect(code, stderr).toBe(0)
    }
  },
  30_000,
)
