import { afterAll, expect, test } from "bun:test"
import { migrations } from "../../src/storage/migration"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

test("retiring Link removes targets and their permission rule without touching Holos or history", () =>
  runtime.run(async () => {
    await Storage.write(["synergy_link", "targets", "target_old"], { id: "target_old", name: "Old host" })
    await Storage.write(["holos", "accounts", "default"], { agentId: "agent_existing" })
    await Storage.write(["sessions", "scope_existing", "session_existing", "parts", "part_existing"], {
      tool: "connect",
      output: "Connected to old host",
    })
    await Storage.write(
      ["permission-rules"],
      [
        { permission: "shell_remote_execute", pattern: "*", action: "allow", scope: "user" },
        { permission: "shell", pattern: "*", action: "ask", scope: "user" },
      ],
    )

    const migration = migrations.find((entry) => entry.id === "20260929-retire-synergy-link")
    expect(migration).toBeDefined()
    await migration!.up(() => {})
    await migration!.up(() => {})

    expect(await Storage.scan(["synergy_link"])).toEqual([])
    expect(await Storage.read<{ agentId: string }>(["holos", "accounts", "default"])).toEqual({
      agentId: "agent_existing",
    })
    expect(
      await Storage.read<{ tool: string; output: string }>([
        "sessions",
        "scope_existing",
        "session_existing",
        "parts",
        "part_existing",
      ]),
    ).toEqual({
      tool: "connect",
      output: "Connected to old host",
    })
    expect(
      await Storage.read<Array<{ permission: string; pattern: string; action: string; scope: string }>>([
        "permission-rules",
      ]),
    ).toEqual([{ permission: "shell", pattern: "*", action: "ask", scope: "user" }])
  }))

afterAll(() => runtime.close())
