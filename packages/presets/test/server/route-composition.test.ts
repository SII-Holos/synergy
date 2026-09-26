import { expect, test } from "bun:test"
import path from "node:path"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { webApp } from "@ericsanchezok/synergy-server/web-app"
import { compositionFixture } from "../support/composition"
import { registerFullRoutes } from "../../src/server/routes"

test("full route composition leaves application assets with the embedding host", async () => {
  await using runtime = await compositionFixture()
  const directory = path.join(runtime.host.root, "web")
  await Bun.write(path.join(directory, "index.html"), "<html><body>Company agent shell</body></html>")
  await runtime.run(async () => {
    registerFullRoutes()
    webApp({ directory }).register()
    Server.mountApp()
    const response = await Server.App().request("http://localhost/")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Company agent shell")
  })
})
