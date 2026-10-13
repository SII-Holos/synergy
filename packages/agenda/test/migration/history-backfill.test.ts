import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { migrations } from "../../src/agenda/migration"
import { testRuntime } from "../support/runtime"

async function migrate(id: string) {
  const migration = migrations.find((entry) => entry.id === id)
  if (!migration) throw new Error(`Missing Agenda migration ${id}`)
  await migration.up(() => {})
}

test("retained task and delivery records upgrade without losing future owner fields", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const old = {
      title: "Retained schedule",
      task: {
        prompt: "Run task",
        agent: "custom-agent",
        model: { providerID: "test", modelID: "test" },
        sessionRefs: ["ses_ref"],
        timeout: 3000,
      },
      delivery: { target: "silent" },
      futureOwner: { retained: true },
    }
    const current = { prompt: "Current", wake: false, futureOwner: { retained: true } }
    await Storage.write(["agenda", "items", "home", "old"], old)
    await Storage.write(["agenda", "items", "home", "default"], { title: "Use title", delivery: { target: "session" } })
    await Storage.write(["agenda", "items", "home", "current"], current)
    await migrate("20260420-agenda-flatten-task-delivery")
    await migrate("20260420-agenda-flatten-task-delivery")
    expect(await Storage.read<unknown>(["agenda", "items", "home", "old"])).toEqual({
      title: old.title,
      ...old.task,
      wake: false,
      silent: true,
      global: false,
      futureOwner: old.futureOwner,
    })
    expect(await Storage.read<unknown>(["agenda", "items", "home", "default"])).toEqual({
      title: "Use title",
      prompt: "Use title",
      wake: true,
      silent: false,
      global: false,
    })
    expect(await Storage.read<unknown>(["agenda", "items", "home", "current"])).toEqual(current)
  })
})

test("retained run history rebuilds indexes and preserves existing session ownership", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Storage.write(["agenda", "items", "home", "old"], { id: "old" })
    for (const [id, started, sessionID] of [
      ["run_old", 1, "ses_old"],
      ["run_new", 3, "ses_new"],
      ["run_missing", 2, "ses_missing"],
    ] as const) {
      await Storage.write(["agenda", "runs", "home", "old", id], { id, itemID: "old", sessionID, time: { started } })
    }
    for (const sessionID of ["ses_old", "ses_new"]) {
      await Storage.write(["session_index", sessionID], { sessionID, scopeID: "home" })
      await Storage.write(["sessions", "home", sessionID, "info"], {
        id: sessionID,
        ...(sessionID === "ses_new" ? { agenda: { itemID: "existing-owner" } } : {}),
      })
    }
    await migrate("20260322-agenda-session-index")
    await migrate("20260423-agenda-run-index")
    await migrate("20260322-agenda-session-index")
    await migrate("20260423-agenda-run-index")
    expect(await Storage.read<unknown>(["agenda", "run_index", "home"])).toEqual({
      entries: [
        { id: "run_new", itemID: "old", started: 3 },
        { id: "run_missing", itemID: "old", started: 2 },
        { id: "run_old", itemID: "old", started: 1 },
      ],
    })
    expect(await Storage.read<unknown>(["agenda", "sessions", "old", "ses_old"])).toEqual({
      sessionID: "ses_old",
      scopeID: "home",
    })
    expect(await Storage.read<unknown>(["sessions", "home", "ses_old", "info"])).toEqual({
      id: "ses_old",
      agenda: { itemID: "old" },
    })
    expect(await Storage.read<unknown>(["sessions", "home", "ses_new", "info"])).toEqual({
      id: "ses_new",
      agenda: { itemID: "existing-owner" },
    })
    expect(await Storage.list(["agenda", "sessions", "old"])).toHaveLength(2)
  })
})
