import fs from "node:fs/promises"
import path from "node:path"
import { MemberLaunchRequest } from "@ericsanchezok/synergy-organization-runtime/launch"
import { runtimeStartupLine } from "@ericsanchezok/synergy-util/runtime-startup"

if (process.argv[2] !== "member-runtime") throw new Error("Expected the member Runtime command")
const input = MemberLaunchRequest.parse(JSON.parse(await Bun.stdin.text()))
process.stdout.write(runtimeStartupLine({ phase: "runtime", state: "opening", stage: "initializing" }))
const home = process.env.SYNERGY_HOME!
const root = process.env.SYNERGY_RUNTIME_ROOT!
await fs.appendFile(path.join(root, "fixture-starts"), String(process.pid) + "\n")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: input.port,
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer " + input.token)
      return new Response("Unauthorized", { status: 401 })
    if (new URL(request.url).pathname === "/native")
      return new Response(null, {
        status:
          input.desktop && request.headers.get("x-fixture-browser-token") === input.desktop.browserToken ? 200 : 403,
      })
    if (new URL(request.url).pathname === "/probe")
      return Response.json({
        pid: process.pid,
        home,
        root,
        cwd: process.cwd(),
        identity: input.identity,
        userHome: process.env.HOME,
        args: process.argv.slice(2),
        privateValue: process.env.MEMBER_TEST_PERSONAL_SECRET ?? null,
        loaderValue: process.env.MEMBER_TEST_DOTENV ?? null,
        inheritedPin: process.env.SYNERGY_INSTALLATION_PIN ?? null,
        parent: process.env.SYNERGY_DESKTOP_PARENT_PID,
        desktop: !!input.desktop,
        ambientBrowserToken: process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET ?? null,
      })
    return Response.json({ healthy: true })
  },
})
process.stdout.write(runtimeStartupLine({ phase: "runtime", state: "ready" }))
await new Promise<void>((resolve) => process.once("SIGTERM", resolve))
await server.stop(true)
