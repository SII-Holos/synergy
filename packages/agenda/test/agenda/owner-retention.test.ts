import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { agenda } from "../../src/component"
import { AgendaItemOwners } from "../../src/agenda/item-owners"
import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Agenda, AgendaStore, AgendaClock, AgendaWatcher, AgendaReactor } from "../../src/agenda"

test("retained tasks belonging to absent owners neither appear nor arm or execute", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const template = await AgendaStore.create({ title: "Template", prompt: "Do work", createdBy: "user" })
        await Agenda.remove(template.id)
        for (const retained of [
          { ...template, id: "anima-daily", agent: "anima" },
          { ...template, id: "boss-briefing" },
          { ...template, id: "boss-briefing-account" },
          { ...template, id: "clarus-deadline", tags: ["clarus", "deadline"], deliveryMode: "session_guidance" },
          { ...template, id: "custom-owner-task", requiredOwners: ["missing-owner"] },
        ]) {
          const record = {
            ...retained,
            status: "active",
            triggers: [{ type: "every", interval: "1d" }],
            state: { ...retained.state, nextRunAt: Date.now() + 86_400_000 },
          }
          await Storage.write(["agenda", "items", "home", record.id], record)
          expect((await AgendaStore.get("home", record.id)) as unknown).toEqual(record)
          await expect(Agenda.trigger(record.id)).rejects.toThrow()
          await AgendaReactor.execute({ type: "manual", source: record.id, timestamp: Date.now() }, "home")
          expect(await Storage.read<unknown>(["agenda", "items", "home", record.id])).toEqual(record)
        }
        expect(await AgendaStore.listAll()).toEqual([])
        expect(await AgendaStore.loadActive()).toEqual([])
        try {
          await Agenda.start()
          expect(AgendaClock.active()).toBe(0)
          expect(AgendaWatcher.active()).toEqual({ files: 0 })
        } finally {
          Agenda.stop()
        }
      },
    }),
  )
}, 20_000)

test("reinstalling explicit task owners restores retained schedules without rewriting them", async () => {
  await using home = await runtimeHome()
  const owners = ["anima", "boss", "boss-feishu", "channel-clarus", "fixture-owner"]
  let records: Array<Record<string, unknown>> = []
  for (const selected of [true, false, true]) {
    await using runtime = await harnessRuntime({
      home: home.host.home,
      composition: {
        register() {
          registerLocalRuntime()
          agenda().register()
          if (selected) for (const owner of owners) AgendaItemOwners.register(owner)
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          if (!records.length) {
            for (const [index, owner] of owners.entries())
              records.push(
                await AgendaStore.create(
                  {
                    title: owner,
                    prompt: "Retained work",
                    createdBy: "user",
                    requiredOwners: [owner],
                    triggers: [{ type: "every", interval: "1d" }],
                  },
                  `retained_${index}`,
                ),
              )
          }
          expect((await AgendaStore.listAll()).map((item) => item.id).sort()).toEqual(
            selected ? records.map((item) => String(item.id)).sort() : [],
          )
          expect((await AgendaStore.loadActive()).length).toBe(selected ? owners.length : 0)
          for (const record of records)
            expect((await AgendaStore.get("home", String(record.id))) as unknown).toEqual(record)
        },
      }),
    )
  }
}, 20_000)
