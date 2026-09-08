import { expect, test } from "bun:test"
import { AnimaSchedule } from "../src/anima-schedule"

function schedule(items: AnimaSchedule.Item[]) {
  const activated: string[] = []
  const paused: string[] = []
  const agenda: AnimaSchedule.Agenda = {
    async get() {
      return undefined
    },
    async list() {
      return items
    },
    async create() {
      throw new Error("Unexpected create")
    },
    async update() {
      throw new Error("Unexpected update")
    },
    async arm() {
      throw new Error("Unexpected arm")
    },
    unarm() {
      throw new Error("Unexpected unarm")
    },
    async activate(id) {
      activated.push(id)
    },
    async pause(id) {
      paused.push(id)
    },
  }
  return { value: AnimaSchedule.create(agenda), activated, paused }
}

const items: AnimaSchedule.Item[] = [
  { id: "paused-anima", title: "Wake", agent: "anima", status: "paused", scopeID: "home" },
  { id: "active-anima", title: "Wake", agent: "anima", status: "active", scopeID: "home" },
  { id: "done-anima", title: "Wake", agent: "anima", status: "done", scopeID: "home" },
  { id: "other-agent", title: "Task", agent: "synergy", status: "paused", scopeID: "home" },
]

test("enabling Library autonomy resumes only paused Anima schedules", async () => {
  const host = schedule(items)
  await host.value.sync(true)
  expect(host.activated).toEqual(["paused-anima"])
  expect(host.paused).toEqual([])
})

test("disabling Library autonomy pauses only active Anima schedules", async () => {
  const host = schedule(items)
  await host.value.sync(false)
  expect(host.activated).toEqual([])
  expect(host.paused).toEqual(["active-anima"])
})
