import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { BlueprintLoopInfo, RuntimeCapabilities } from "@ericsanchezok/synergy-sdk/client"
import { createBlueprintLoopsResource } from "../../../src/components/note/blueprint-loops"

const selection = (...features: string[]): RuntimeCapabilities => ({
  apiVersion: 1,
  hostVersion: "test",
  components: [],
  features,
})
const loop = (source: BlueprintLoopInfo["source"], id: string = source): BlueprintLoopInfo => ({
  id,
  noteID: "blueprint",
  noteVersion: 1,
  scopeID: "home",
  sessionID: "session",
  title: id,
  source,
  status: "running",
  runMode: "current",
  executionAgent: "general",
  auditAgent: "reviewer",
  time: { created: 1, updated: 1 },
})

test("Note loops filter source owners in snapshots and events, clearing old epochs before accepting late replies", async () => {
  const [capabilities, setCapabilities] = createSignal<RuntimeCapabilities>()
  const [reconnect, setReconnect] = createSignal(0)
  const replies: Array<{ signal: AbortSignal; resolve: (loops: BlueprintLoopInfo[]) => void }> = []
  let dispose = () => {}
  const resource = createRoot((close) => {
    dispose = close
    return createBlueprintLoopsResource({
      scopeID: () => "home",
      capabilities,
      reconnect,
      list: (_scopeID, signal) => new Promise((resolve) => replies.push({ signal, resolve })),
    })
  })
  await Bun.sleep(0)
  expect(replies).toHaveLength(0)
  resource.update(loop("lattice"))
  expect(resource.loops()).toEqual([])

  setCapabilities(selection("blueprint", "lattice"))
  await Bun.sleep(0)
  replies[0].resolve([loop("user"), loop("lattice"), loop("plugin")])
  await Bun.sleep(0)
  expect(resource.loops().map((loop) => loop.id)).toEqual(["user", "lattice"])

  setReconnect(1)
  await Bun.sleep(0)
  expect(resource.loops()).toEqual([])
  setCapabilities(undefined)
  expect(resource.loops()).toEqual([])
  replies[1].resolve([loop("lattice", "late-lattice")])
  await Bun.sleep(0)
  expect(replies[1].signal.aborted).toBe(true)
  expect(resource.loops()).toEqual([])

  setCapabilities(selection("blueprint", "plugin-host"))
  await Bun.sleep(0)
  replies[2].resolve([loop("lattice"), loop("user")])
  await Bun.sleep(0)
  resource.update(loop("lattice", "event-lattice"))
  resource.update(loop("plugin", "event-plugin"))
  resource.update({ ...loop("user", "other-scope"), scopeID: "other" })
  expect(resource.loops().map((loop) => loop.id)).toEqual(["user"])
  resource.update(loop("user", "event-user"))
  expect(resource.loops().map((loop) => loop.id)).toEqual(["event-user", "user"])

  setCapabilities(selection("blueprint", "lattice", "plugin-host", "plugin-blueprint"))
  await Bun.sleep(0)
  replies[3].resolve([loop("lattice"), loop("plugin")])
  await Bun.sleep(0)
  expect(resource.loops().map((loop) => loop.id)).toEqual(["lattice", "plugin"])
  dispose()
  expect(replies[3].signal.aborted).toBe(true)
})
