import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { AgendaStore } from "../../src/agenda"
import { AgendaScheduleTool } from "../../src/agenda/tools/agenda-schedule"
import { AgendaUpdateTool } from "../../src/agenda/tools/agenda-update"
import { AgendaListTool } from "../../src/agenda/tools/agenda-list"
import { AgendaCancelTool } from "../../src/agenda/tools/agenda-cancel"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("agenda agent fields remain consistent through create update list and cancel without changing entity storage", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: "message",
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        const created = await (
          await AgendaScheduleTool.init()
        ).execute(
          {
            agendaTitle: "Check evidence",
            agendaDescription: "Inspect the read-only result",
            executionInstructions: "Read README.md",
            trigger: { type: "delay", delay: "30d" },
            tags: ["contract-fixture"],
            timeoutSeconds: 30,
            wake: false,
            silent: true,
          },
          ctx,
        )
        const item = JSON.parse(created.output)
        const agendaItemId: string = item.agendaItemId
        expect(item).toMatchObject({
          agendaItemId: expect.any(String),
          agendaTitle: "Check evidence",
          agendaDescription: "Inspect the read-only result",
          executionInstructions: "Read README.md",
          timeoutSeconds: 30,
          wake: false,
          silent: true,
        })
        const stored = await AgendaStore.findInScope(ScopeContext.current.scope.id, agendaItemId)
        expect(stored.item).toMatchObject({
          id: agendaItemId,
          title: item.agendaTitle,
          description: item.agendaDescription,
          prompt: item.executionInstructions,
          timeout: 30000,
        })
        const updated = await (
          await AgendaUpdateTool.init()
        ).execute(
          {
            agendaItemId: agendaItemId,
            agendaTitle: "Check captured evidence",
            agendaDescription: "",
            executionInstructions: "Read the captured README",
            timeoutSeconds: 45,
          },
          ctx,
        )
        expect(JSON.parse(updated.output)).toMatchObject({
          agendaItemId: agendaItemId,
          agendaTitle: "Check captured evidence",
          agendaDescription: "",
          executionInstructions: "Read the captured README",
          timeoutSeconds: 45,
        })
        const list = await (await AgendaListTool.init()).execute({ tag: "contract-fixture" }, ctx)
        expect(JSON.parse(list.output)).toMatchObject([
          { agendaItemId: agendaItemId, agendaTitle: "Check captured evidence" },
        ])
        const cancelled = await (await AgendaCancelTool.init()).execute({ agendaItemId: agendaItemId }, ctx)
        expect(JSON.parse(cancelled.output)).toMatchObject({ agendaItemId: agendaItemId, status: "cancelled" })
      },
    })
  }))
