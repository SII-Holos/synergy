import { expect, test } from "bun:test"
import path from "node:path"
import type { Config } from "@ericsanchezok/synergy-harness/config/config"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
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

test.each([
  { name: "unconfigured", settings: undefined },
  { name: "disabled", settings: { automatic: false, model: null } },
  { name: "enabled", settings: { automatic: true, model: null } },
  {
    name: "explicit prediction model",
    settings: { automatic: true, model: { providerID: "fixture", modelID: "prediction" } },
  },
])("core bootstrap preserves Digital Twin preferences: $name", async ({ settings }) => {
  await using runtime = await compositionFixture({
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ digitalTwin: settings }) },
  })
  await runtime.run(async () => {
    await using project = await tmpdir()
    const scope = await project.scope()
    const app = Server.App()
    for (const scopeID of ["home", scope.id]) {
      const configuration = await app.request(`/config?scopeID=${scopeID}`)
      expect(configuration.status).toBe(200)
      const config = (await configuration.json()) as Config.Info
      expect(config.digitalTwin).toEqual(settings)

      const response = await app.request(`/scope/bootstrap-core?scopeID=${scopeID}`)
      expect(response.status).toBe(200)
      const data = (await response.json()) as { config: Config.Info }
      expect(data.config.digitalTwin).toEqual(config.digitalTwin)
      expect(data.config.digitalTwin?.automatic === true).toBe(settings?.automatic === true)
    }
  })
})
