import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { installedProvider } from "../../../packages/presets/test/acceptance/installed-provider"
import pluginDefinition from "./upgrade-plugin-fixture"
import { expectRetainedHistory } from "./upgrade-history"

const previous = process.env.SYNERGY_UPGRADE_PREVIOUS
const candidate = process.env.SYNERGY_UPGRADE_CANDIDATE
const expectedVersion = process.env.SYNERGY_UPGRADE_VERSION ?? "3.1.0"
const messageSchema = z.object({
  info: z.object({ id: z.string(), role: z.string() }).passthrough(),
  parts: z.array(z.object({ type: z.string() }).passthrough()),
})

test.skipIf(!previous || !candidate)(
  "released 3.0.22 preserves history, plugins and assets through upgrade, restart and backup recovery",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synergy-released-upgrade-")))
    const home = path.join(root, "home")
    const workspace = path.join(root, "workspace")
    using provider = installedProvider()
    const config = {
      model: "fixture/model",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Release acceptance",
          options: { baseURL: provider.url.toString(), apiKey: "release-fixture" },
          models: {
            model: {
              name: "Release fixture",
              tool_call: true,
              attachment: true,
              limit: { context: 128000, output: 2048 },
            },
          },
        },
      },
    }
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: path.join(root, "tmp"),
      LANG: "C.UTF-8",
      SYNERGY_HOME: home,
      SYNERGY_TEST_HOME: home,
      SYNERGY_DISABLE_MODELS_FETCH: "1",
      SYNERGY_CONFIG_CONTENT: JSON.stringify(config),
    }
    await Promise.all([home, workspace, env.TMPDIR].map((directory) => fs.mkdir(directory, { recursive: true })))
    const installations = { previous: path.join(root, "previous"), candidate: path.join(root, "candidate") }
    await Promise.all([
      fs.cp(path.resolve(previous!), installations.previous, { recursive: true }),
      fs.cp(path.resolve(candidate!), installations.candidate, { recursive: true }),
    ])
    const marker = `FILE_${crypto.randomUUID().replaceAll("-", "")}\n`
    await Bun.write(path.join(workspace, "record.txt"), marker)
    const pluginDirectory = path.join(root, "plugin")
    const pluginBuild = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "upgrade-plugin-fixture.ts")],
      outdir: pluginDirectory,
      naming: "runtime.js",
      target: "bun",
    })
    if (!pluginBuild.success) throw new AggregateError(pluginBuild.logs, "Could not build the plugin fixture")
    const manifest = compilePluginManifest(pluginDefinition, {
      generation: "released-upgrade",
      runtime: {
        entry: "runtime.js",
        sha256: new Bun.CryptoHasher("sha256")
          .update(await Bun.file(path.join(pluginDirectory, "runtime.js")).arrayBuffer())
          .digest("hex"),
      },
    })
    await Bun.write(path.join(pluginDirectory, "plugin.json"), JSON.stringify(manifest))
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=",
      "base64",
    )
    const binary = (directory: string) =>
      path.join(directory, "bin", process.platform === "win32" ? "synergy.exe" : "synergy")
    async function version(directory: string) {
      const child = Bun.spawn([binary(directory), "--version"], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Installed version command failed: ${stderr}`)
      return stdout.trim()
    }
    async function start(directory: string, label: string) {
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
      const port = reservation.port!
      await reservation.stop(true)
      const child = Bun.spawn(
        [
          binary(directory),
          "server",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
          "--non-interactive",
          "--banner=false",
          "--print-logs",
        ],
        { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const url = new URL(`http://127.0.0.1:${port}`)
      async function stop() {
        if (child.exitCode === null) child.kill("SIGTERM")
        const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
        try {
          const code = await child.exited
          await Bun.write(path.join(root, `${label}.log`), (await stdout) + (await stderr))
          if (code !== 0 && code !== 143) throw new Error(`${label} shutdown failed (${code})`)
        } finally {
          clearTimeout(timeout)
        }
      }
      try {
        const deadline = Date.now() + 120000
        for (;;) {
          if (child.exitCode !== null) throw new Error(`${label} exited (${child.exitCode}): ${await stderr}`)
          const response = await fetch(new URL("/global/health", url), { signal: AbortSignal.timeout(1000) }).catch(
            () => undefined,
          )
          if (response?.ok) break
          if (Date.now() >= deadline) throw new Error(`${label} did not become ready`)
          await Bun.sleep(100)
        }
      } catch (error) {
        await stop().catch(() => {})
        throw error
      }
      async function response(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
        const endpoint = new URL(route, url)
        endpoint.searchParams.set("directory", workspace)
        const response = await fetch(endpoint, {
          method,
          headers: body instanceof FormData ? {} : { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
          signal: AbortSignal.timeout(120000),
        })
        return response
      }
      async function request(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
        const result = await response(route, body, method)
        const text = await result.text()
        if (!result.ok) {
          const diagnostics = route.startsWith("/plugin/")
            ? await (await response(`/api/plugins/${manifest.id}/runtime/logs`)).text()
            : ""
          throw new Error(`${label} ${method} ${route} returned ${result.status}: ${text}\n${diagnostics}`)
        }
        return JSON.parse(text) as unknown
      }
      return { request, response, [Symbol.asyncDispose]: stop }
    }
    const prompt = (file: string) => ({
      model: { providerID: "fixture", modelID: "model" },
      parts: [
        {
          type: "text",
          text: `Installed acceptance task\nRead record.txt and copy it exactly once.\nCOMMAND_BEGIN\ncat record.txt > ${file}; printf x >> effects.txt; cat ${file}\nCOMMAND_END`,
        },
      ],
    })
    let passed = false
    try {
      expect(await version(installations.previous)).toBe("3.0.22")
      let sessionID: string
      let before: z.infer<typeof messageSchema>[]
      let continuedHistory: z.infer<typeof messageSchema>[]
      let attachmentPartID: string
      let uploadedID: string
      async function retainedExtras(server: Awaited<ReturnType<typeof start>>) {
        expect(await server.request("/config/domains/general")).toMatchObject({ locale: "zh-CN" })
        expect(await server.request(`/api/plugins/${manifest.id}`)).toMatchObject({
          loaded: true,
          version: "1.0.0",
          generation: "released-upgrade",
        })
        expect(await server.request(`/plugin/${manifest.id}/operations/echo/invoke`, { input: { marker } })).toEqual({
          data: { marker },
        })
        const messages = z.array(messageSchema).parse(await server.request(`/session/${sessionID}/message?raw=true`))
        const attachment = z
          .object({
            id: z.literal(attachmentPartID),
            mime: z.literal("image/png"),
            filename: z.literal("upgrade.png"),
            url: z.string(),
          })
          .parse(messages.flatMap((message) => message.parts).find((part) => part.id === attachmentPartID))
        const ids = new Set([uploadedID])
        if (attachment.url.startsWith("asset://")) ids.add(attachment.url.slice("asset://".length))
        else {
          expect(attachment.url.startsWith("data:image/png;base64,")).toBe(true)
          expect(Buffer.from(attachment.url.slice("data:image/png;base64,".length), "base64")).toEqual(png)
        }
        for (const id of ids) {
          const asset = await server.response(`/asset/${id}`)
          expect(asset.status).toBe(200)
          expect(Buffer.from(await asset.arrayBuffer())).toEqual(png)
        }
      }
      {
        await using old = await start(installations.previous, "previous")
        await old.request("/config/domains/general", { config: { locale: "zh-CN" }, mode: "merge" }, "PATCH")
        await old.request("/api/registry/publish", {
          id: manifest.id,
          name: "Released upgrade fixture",
          description: manifest.description,
          author: { name: "Acceptance" },
          verified: false,
          official: false,
          keywords: [],
          trustTier: "declarative",
          runtimeMode: "process",
          featuresSummary: [],
          permissionsSummary: [],
          uiSurfaces: [],
          tools: [],
          downloads: 0,
          versions: [
            {
              version: manifest.version,
              apiVersion: manifest.apiVersion,
              manifestHash: computeManifestHash(manifest),
              permissionsHash: computePermissionsHash(manifest),
              installSpec: pathToFileURL(pluginDirectory).href,
              featuresSummary: [],
              permissionsSummary: [],
              publishedAt: 0,
            },
          ],
        })
        const install = await old.response("/api/plugins/registry/install", {
          id: manifest.id,
          version: manifest.version,
          source: "local",
        })
        const review = z
          .object({ review: z.object({ target: z.unknown(), reviewToken: z.string() }) })
          .parse(await install.json()).review
        expect(install.status).toBe(409)
        await old.request("/api/plugins/approve", review)
        const upload = new FormData()
        upload.set("file", new File([png], "upgrade.png", { type: "image/png" }))
        const asset = z.object({ id: z.string(), url: z.string() }).parse(await old.request("/asset", upload))
        uploadedID = asset.id
        const session = z
          .object({ id: z.string() })
          .parse(await old.request("/session", { title: "Released upgrade fixture", controlProfile: "full_access" }))
        sessionID = session.id
        await old.request(`/session/${sessionID}/message`, {
          noReply: true,
          model: { providerID: "fixture", modelID: "model" },
          parts: [
            { type: "text", text: "Released attachment evidence" },
            { type: "attachment", mime: "image/png", filename: "upgrade.png", url: asset.url },
          ],
        })
        await old.request(`/session/${sessionID}/message`, prompt("old-result.txt"))
        before = z.array(messageSchema).parse(await old.request(`/session/${sessionID}/message?raw=true`))
        await Bun.write(path.join(root, "before.json"), JSON.stringify(before))
        attachmentPartID = z
          .string()
          .parse(
            before
              .flatMap((message) => message.parts)
              .find((part) => part.type === "attachment" && part.filename === "upgrade.png")?.id,
          )
        expect(await Bun.file(path.join(workspace, "old-result.txt")).text()).toBe(marker)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("x")
        expect(before.some((message) => message.parts.some((part) => part.type === "tool"))).toBe(true)
        await retainedExtras(old)
      }
      await fs.cp(home, path.join(root, "pre-upgrade-backup"), { recursive: true })
      expect(await version(installations.candidate)).toBe(expectedVersion)
      {
        await using upgraded = await start(installations.candidate, "upgraded")
        const preparationRoute = `/global/storage/upgrade/sessions/${sessionID}`
        const preparationSchema = z
          .object({ state: z.enum(["pending", "preparing", "ready", "blocked", "failed"]) })
          .passthrough()
        let preparation = preparationSchema.parse(
          await upgraded.request(`${preparationRoute}/prepare`, undefined, "POST"),
        )
        const preparationDeadline = Date.now() + 120000
        while (preparation.state !== "ready") {
          if (preparation.state === "blocked" || preparation.state === "failed")
            throw new Error(`Historical Session preparation failed: ${JSON.stringify(preparation)}`)
          if (Date.now() >= preparationDeadline)
            throw new Error(`Historical Session preparation did not become ready: ${JSON.stringify(preparation)}`)
          await Bun.sleep(100)
          preparation = preparationSchema.parse(await upgraded.request(preparationRoute))
        }
        const messages = z.array(messageSchema).parse(await upgraded.request(`/session/${sessionID}/message?raw=true`))
        expect(messages.map((message) => message.info.id)).toEqual(before.map((message) => message.info.id))
        expect(
          messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        ).toEqual(
          before
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        )
        expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toEqual(
          before
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool")
            .map((part) => {
              const legacy = z
                .object({
                  state: z.object({ input: z.object({ description: z.string() }).passthrough() }).passthrough(),
                })
                .passthrough()
                .parse(part)
              const { description, ...input } = legacy.state.input
              return { ...legacy, workBrief: description, state: { ...legacy.state, input } }
            }),
        )
        await upgraded.request(`/session/${sessionID}/message`, prompt("continued-result.txt"))
        expect(await Bun.file(path.join(workspace, "continued-result.txt")).text()).toBe(marker)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("xx")
        await retainedExtras(upgraded)
        continuedHistory = z
          .array(messageSchema)
          .parse(await upgraded.request(`/session/${sessionID}/message?raw=true`))
        const oldIDs = new Set(before.map((message) => message.info.id))
        expect(
          continuedHistory.some(
            (message) =>
              !oldIDs.has(message.info.id) &&
              message.info.role === "assistant" &&
              message.parts.some((part) => part.type === "tool"),
          ),
        ).toBe(true)
        await Bun.write(path.join(root, "upgraded.json"), JSON.stringify(continuedHistory))
      }
      {
        await using restarted = await start(installations.candidate, "restarted")
        const messages = z.array(messageSchema).parse(await restarted.request(`/session/${sessionID}/message?raw=true`))
        expectRetainedHistory(continuedHistory, messages)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("xx")
        await retainedExtras(restarted)
        const fresh = z
          .object({ id: z.string() })
          .parse(await restarted.request("/session", { title: "Post-upgrade work", controlProfile: "full_access" }))
        await restarted.request(`/session/${fresh.id}/message`, prompt("fresh-result.txt"))
        expect(await Bun.file(path.join(workspace, "fresh-result.txt")).text()).toBe(marker)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("xxx")
      }
      await fs.rename(home, path.join(root, "post-upgrade-home"))
      await fs.cp(path.join(root, "pre-upgrade-backup"), home, { recursive: true })
      {
        await using restored = await start(installations.previous, "restored")
        const messages = z.array(messageSchema).parse(await restored.request(`/session/${sessionID}/message?raw=true`))
        expectRetainedHistory(before, messages)
        await retainedExtras(restored)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("xxx")
        await restored.request(`/session/${sessionID}/message`, prompt("restored-result.txt"))
        expect(await Bun.file(path.join(workspace, "restored-result.txt")).text()).toBe(marker)
        expect(await Bun.file(path.join(workspace, "effects.txt")).text()).toBe("xxxx")
      }
      passed = true
    } finally {
      const evidence = process.env.SYNERGY_UPGRADE_EVIDENCE
      if (evidence) {
        await fs.mkdir(evidence, { recursive: true })
        await fs.cp(root, path.join(evidence, path.basename(root)), {
          recursive: true,
          filter: (file) =>
            !Object.values(installations).some(
              (directory) => file === directory || file.startsWith(directory + path.sep),
            ),
        })
      }
      await fs.rm(root, { recursive: true, force: true })
      console.log(JSON.stringify({ previous: "3.0.22", candidate: expectedVersion, passed }))
    }
  },
  600000,
)
