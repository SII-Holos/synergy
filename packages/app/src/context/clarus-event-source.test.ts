import { describe, expect, test } from "bun:test"
import type { Event } from "@ericsanchezok/synergy-sdk/client"
import { listenForClarusNavigationUpdates } from "./clarus"
import { HOME_SCOPE_KEY } from "@/utils/scope"

describe("Clarus navigation event source", () => {
  test("listens on the Home Scope channel and forwards only navigation updates", () => {
    let subscribedDirectory: string | undefined
    let listener: ((event: Event) => void) | undefined
    let calls = 0
    const dispose = listenForClarusNavigationUpdates(
      {
        on(directory: string, handler: (event: Event) => void) {
          subscribedDirectory = directory
          listener = handler
          return () => {}
        },
      },
      () => {
        calls++
      },
    )

    expect(subscribedDirectory).toBe(HOME_SCOPE_KEY)
    listener?.({ type: "session.updated", properties: {} } as Event)
    expect(calls).toBe(0)
    listener?.({ type: "clarus.navigation.updated", properties: {} } as Event)
    expect(calls).toBe(1)
    dispose()
  })
})
