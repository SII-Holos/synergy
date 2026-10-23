import { expect, test } from "bun:test"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RUNTIME_STARTUP_PREFIX, RuntimeStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

test("managed CLI upgrades retained owners without scanning cold history and waits for complete readiness", async () => {
  await using tmp = await tmpdir()
  await using home = await runtimeHome({ home: `${tmp.path}/home` })
  await Bun.write(
    `${home.host.root}/config/synergy.d/140-features.jsonc`,
    JSON.stringify({ features: { optIn: ["lattice"] } }),
  )
  const sessions: Array<{ id: string; kind: "plan" | "lightloop" | "lattice" }> = []
  {
    await using runtime = await PresetRuntimeHandle.openTask({ host: home.host, mode: "oneshot", environment: false })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          for (const owner of [
            {
              domain: "blueprint-session",
              migration: "20261012-blueprint-session-owner",
              kind: "plan",
              value: { planMode: true },
            },
            {
              domain: "light-loop-session",
              migration: "20261012-light-loop-session-owner",
              kind: "lightloop",
              value: { lightLoop: { active: true, taskDescription: "retained" } },
            },
            {
              domain: "lattice-session",
              migration: "20261012-lattice-session-owner",
              kind: "lattice",
              value: { lattice: { runID: "retained", mode: "auto" } },
            },
          ] as const) {
            const session = await Session.create({ title: "Retained workflow startup" })
            sessions.push({ id: session.id, kind: owner.kind })
            const root = ["sessions", "home", session.id]
            await Storage.transaction(async () => {
              await Storage.write([...root, "info"], { ...session, ...owner.value })
              await Storage.remove([...root, "migrations", owner.domain, owner.migration])
              const logKey = ["meta", "migration", `log-${owner.domain}`]
              const [receipt] = await Storage.readMany<Record<string, number>>([logKey])
              const retained = { ...receipt }
              delete retained[owner.migration]
              await Storage.write(logKey, retained)
              const messageID = Identifier.ascending("message")
              await Storage.write([...root, "messages", messageID, "info"], {
                id: messageID,
                sessionID: session.id,
                role: "user",
                agent: "general",
                model: { providerID: "fixture", modelID: "fixture" },
                time: { created: 1 },
                origin: { type: "user" },
                isRoot: true,
                metadata: { workflowMode: owner.kind },
              })
              for (let index = 0; index < 180; index++) {
                const id = Identifier.ascending("part")
                await Storage.write([...root, "messages", messageID, "parts", id], {
                  id,
                  messageID,
                  sessionID: session.id,
                  type: "text",
                  text: "Cold retained content ".repeat(100),
                })
              }
            })
          }
        },
      }),
    )
  }
  await Bun.write(
    `${home.host.root}/data/session_nav_v2/home.json`,
    JSON.stringify({ version: 1, scopeID: "home", updatedAt: 1, entries: [] }),
  )
  for (const state of ["fresh", "restart"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "test/cli/fixture/managed-readiness.ts",
        "server",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        "--non-interactive",
        "--no-banner",
      ],
      {
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          SYNERGY_HOME: `${tmp.path}/home`,
          SYNERGY_CWD: tmp.path,
          SYNERGY_DESKTOP_STARTUP_PROGRESS: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stderr = new Response(child.stderr).text()
    const timeout = setTimeout(() => child.kill(), 20_000)
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    const readUntil = async (predicate: (output: string) => boolean) => {
      while (!predicate(output)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`CLI closed before readiness: ${await stderr}`)
        output += decoder.decode(value, { stream: true })
      }
    }
    const events = () =>
      output
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.startsWith(RUNTIME_STARTUP_PREFIX))
        .map((line) => RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))))
    try {
      await readUntil((text) => /\{"fixture":"runtime-open","port":\d+\}\n/.test(text))
      const opened = output.split("\n").find((line) => line.startsWith('{"fixture":"runtime-open"'))!
      const { port } = JSON.parse(opened) as { port: number }
      const client = createSynergyClient({ baseUrl: `http://127.0.0.1:${port}` })
      const health = await client.global.health({ throwOnError: true })
      expect(health.data, state).toMatchObject({ healthy: true, storage: { readerReady: true, writerReady: true } })
      expect(output, state).toContain('"coldHistoryTraversals":0')
      expect(
        events().some((event) => event.phase === "runtime" && event.state === "ready"),
        state,
      ).toBe(false)
      child.stdin.end()
      await readUntil(() => events().some((event) => event.phase === "runtime" && event.state === "ready"))
      expect(output.indexOf('"state":"ready"')).toBeGreaterThan(output.indexOf("fixture-factory-returning"))
      expect(events().filter((event) => event.phase === "runtime" && event.state === "ready")).toHaveLength(1)
      const navigation = await client.session.index({ scopeID: "home" }, { throwOnError: true })
      expect(navigation.response.status, state).toBe(200)
      for (const session of sessions) {
        const result = await client.session.get({ scopeID: "home", sessionID: session.id }, { throwOnError: true })
        expect(result.data?.workflow?.kind, state).toBe(session.kind)
      }
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
      reader.releaseLock()
    }
  }
}, 60_000)
