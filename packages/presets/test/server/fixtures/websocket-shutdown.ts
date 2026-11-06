import path from "node:path"
import fs from "node:fs/promises"
import { PresetRuntimeHandle } from "../../../src/server/runtime-handle"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"

const home = process.env.SYNERGY_TEST_HOME!
const workspace = path.join(home, "workspace")
await fs.mkdir(workspace, { recursive: true })
const host = createLocalHost({ home, env: { ...process.env, SYNERGY_HOME: home } })
const runtime = await PresetRuntimeHandle.open({ host, mode: "oneshot", network: { hostname: "127.0.0.1", port: 0 } })
const session = await runtime.run(() =>
  ScopeContext.provide({
    scope: Scope.home(),
    workspace: null,
    fn: async () => {
      const bound = await WorkspaceBinding.register("home", workspace)
      return Session.create({ workspaceID: bound.id })
    },
  }),
)
const client = createSynergyClient({
  baseUrl: `http://127.0.0.1:${runtime.server.port}`,
  scopeID: "home",
  throwOnError: true,
})
const terminal = (
  await client.pty.create({
    sessionID: session.id,
    command: "/bin/sh",
    args: ["-c", "read value; printf 'complete:%s\\n' \"$value\""],
  })
).data!
const socket = new WebSocket(`ws://127.0.0.1:${runtime.server.port}/pty/${terminal.id}/connect?scopeID=home`)
let output = ""
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => socket.send("shutdown-proof\n")
  socket.onmessage = (event) => {
    output += String(event.data)
  }
  socket.onerror = () => reject(new Error("PTY socket failed"))
  socket.onclose = () => resolve()
})
if (!output.includes("complete:shutdown-proof")) throw new Error("PTY closed without its complete output")
process.stdout.write("terminal-completed\n")
await runtime.close()
process.stdout.write("runtime-closed\n")
