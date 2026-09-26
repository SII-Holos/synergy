import { describe, expect, test, beforeEach } from "bun:test"
import { Contact } from "../../../src/holos/contact"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../../support/runtime"
const runtime = await testRuntime()

describe("Contact sync update logic", () => {
  async function withScopeContext(fn: () => Promise<void>) {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn,
    })
  }

  test("add new contact", () =>
    runtime.run(async () => {
      await withScopeContext(async () => {
        const contact = await Contact.add({
          id: "peer_001",
          name: "Alice",
          addedAt: Date.now(),
        })
        expect(contact.name).toBe("Alice")

        const retrieved = await Contact.get("peer_001")
        expect(retrieved).toBeDefined()
        expect(retrieved!.name).toBe("Alice")
      })
    }))

  test("update contact name only", () =>
    runtime.run(async () => {
      await withScopeContext(async () => {
        const contact = await Contact.add({
          id: "peer_002",
          name: "Bob",
          addedAt: Date.now(),
        })

        await Contact.update({ ...contact, name: "Robert" })

        const updated = await Contact.get("peer_002")
        expect(updated!.name).toBe("Robert")
      })
    }))

  test("update preserves fields not being changed", () =>
    runtime.run(async () => {
      await withScopeContext(async () => {
        const contact = await Contact.add({
          id: "peer_005",
          name: "Eve",
          addedAt: 1000,
        })

        await Contact.update({ ...contact, name: "Evelyn" })

        const updated = await Contact.get("peer_005")
        expect(updated!.name).toBe("Evelyn")
        expect(updated!.addedAt).toBe(1000)
      })
    }))

  test("list includes added contacts", () =>
    runtime.run(async () => {
      await withScopeContext(async () => {
        await Contact.add({
          id: "peer_list_a",
          name: "ListA",
          addedAt: Date.now(),
        })
        await Contact.add({
          id: "peer_list_b",
          name: "ListB",
          addedAt: Date.now(),
        })

        const contacts = await Contact.list()
        const names = contacts.map((c) => c.name)
        expect(names).toContain("ListA")
        expect(names).toContain("ListB")
      })
    }))

  test("remove deletes contact", () =>
    runtime.run(async () => {
      await withScopeContext(async () => {
        await Contact.add({
          id: "peer_del",
          name: "ToDelete",
          addedAt: Date.now(),
        })

        await Contact.remove("peer_del")

        const result = await Contact.get("peer_del")
        expect(result).toBeUndefined()
      })
    }))
})

afterRuntimeTests(() => runtime.close())
