import { definePlugin } from "@ericsanchezok/synergy-plugin"

function activationState() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    events: [] as string[],
    server: undefined as Bun.Server<undefined> | undefined,
  }
}

let activation = activationState()

export function prepareActivation() {
  activation = activationState()
  return activation
}

export default definePlugin({
  id: "startup-fixture",
  version: "1.0.0",
  description: "Trusted startup lifecycle fixture",
  contributions: [],
  async activate() {
    activation.events.push("activate:entered")
    activation.entered.resolve()
    await activation.release.promise
    activation.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("active"),
    })
    activation.events.push("activate:allocated")
  },
  async deactivate() {
    activation.events.push("deactivate")
    await activation.server?.stop(true)
    activation.server = undefined
  },
})
