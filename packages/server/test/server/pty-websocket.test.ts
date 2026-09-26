import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Server } from "../../src/server/server"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

test.skipIf(process.platform === "win32")(
  "real PTY WebSockets retain the request Scope and selected Workspace across native callbacks",
  () =>
    runtime.run(async () => {
      await using owner = await tmpdir(),
        selected = await tmpdir(),
        unrelated = await tmpdir()
      const scope = await owner.scope()
      const other = await unrelated.scope()
      const session = await ScopeContext.provide({
        scope,
        async fn() {
          const workspace = await WorkspaceBinding.register(scope.id, selected.path)
          return Session.create({ workspaceID: workspace.id })
        },
      })
      const server = Server.listen({ hostname: "127.0.0.1", port: 0, preferDefaultPort: false })
      const query = new URLSearchParams({ scopeID: scope.id })
      let socket: WebSocket | undefined
      let ptyID: string | undefined
      try {
        const response = await fetch(new URL(`/pty?${query}`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, command: "/bin/cat" }),
        })
        const payload = await response.json()
        expect(response.status, JSON.stringify(payload)).toBe(200)
        const pty = payload as { id: string; workspaceID: string; cwd: string }
        ptyID = pty.id
        expect(pty.workspaceID).toBe(session.workspaceID!)
        expect(pty.cwd).toBe(session.workspace!.path)
        const received = Promise.withResolvers<string>()
        const timer = setTimeout(() => received.reject(new Error("PTY output did not arrive")), 5000)
        try {
          const url = new URL(`/pty/${pty.id}/connect?${query}`, server.url)
          url.protocol = "ws:"
          socket = new WebSocket(url)
          let output = ""
          socket.onopen = () => socket!.send("selected-workspace-中文🙂\n")
          socket.onmessage = (event) => {
            output += String(event.data)
            if (output.includes("selected-workspace-中文🙂")) received.resolve(output)
          }
          socket.onerror = () => received.reject(new Error("PTY WebSocket failed"))
          socket.onclose = () => received.reject(new Error("PTY WebSocket closed before output"))
          const [receivedOutput, unrelatedResponse] = await Promise.all([
            received.promise,
            fetch(new URL(`/pty?scopeID=${other.id}`, server.url)),
          ])
          expect(unrelatedResponse.status).toBe(200)
          expect(receivedOutput).toContain("selected-workspace-中文🙂")
        } finally {
          clearTimeout(timer)
        }
      } finally {
        socket?.close()
        if (ptyID) await fetch(new URL(`/pty/${ptyID}?${query}`, server.url), { method: "DELETE" })
        await server.stop(true)
      }
    }),
  30_000,
)

afterAll(() => runtime.close())
