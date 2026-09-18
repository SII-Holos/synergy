import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { Config } from "@ericsanchezok/synergy-sdk/client"

test("composer uploads use current Scope limits and observe config reloads", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".attachment-config-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  const entry = path.join(directory, "main.ts")
  const stub = path.join(directory, "contexts.ts")
  try {
    await Bun.write(
      stub,
      `import { createSignal } from "solid-js"
       import { createStore, reconcile } from "solid-js/store"
       import { setupI18n } from "@lingui/core"
       const [data, setData] = createStore({ config: { attachment: { maxFiles: 1, maxFileBytes: 8, maxTotalBytes: 10 } } })
       const [parts, setParts] = createSignal([])
       export const uploaded = [], toasts = []
       export const configure = (attachment) => setData("config", reconcile({ attachment }))
       export const useSync = () => ({ data })
       export const useGlobalSync = () => ({ data: { config: { attachment: { maxFiles: 20, maxFileBytes: 100, maxTotalBytes: 1000 } } } })
       export const useSDK = () => ({ client: { asset: { upload: async ({ file }) => {
         uploaded.push(file.name)
         return { data: { url: "asset://" + file.name, size: file.size } }
       } } } })
       const draft = { current: parts, set: setParts, cursor: () => 0 }
       export const usePrompt = () => ({ ...draft, capture: () => ({ draft, release() {} }) })
       export const useParams = () => ({ dir: "project" })
       export const useDialog = () => ({ active: false })
       const i18n = setupI18n()
       i18n.loadAndActivate({ locale: "en", messages: {} })
       export const useLocale = () => ({ i18n })
       export const showToast = (toast) => toasts.push(toast)
       export const reset = () => { setParts([]); uploaded.length = 0; toasts.length = 0 }
      `,
    )
    await Bun.write(
      entry,
      `import { createRoot } from "solid-js"
       import { usePromptAttachments } from ${JSON.stringify(path.join(source, "components/prompt-input/attachments-hook.ts"))}
       import { createPendingAttachmentTracker } from ${JSON.stringify(path.join(source, "components/prompt-input/pending-attachments.ts"))}
       import * as context from ${JSON.stringify(stub)}
       export function mount() {
         return createRoot(dispose => {
           const tracker = createPendingAttachmentTracker()
           const api = usePromptAttachments({ editor: () => undefined, pendingUploads: tracker })
           return { ...context, add: api.addAttachments, reset() { tracker.clear(); context.reset() }, dispose() { tracker.clear(); dispose() } }
         })
       }`,
    )
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@": source } },
      plugins: [
        {
          name: "attachment-context-fixture",
          enforce: "pre",
          resolveId(id, importer) {
            if (!importer?.endsWith("/attachments-hook.ts")) return
            if (
              id.startsWith("@/context/") ||
              id.startsWith(source + "/context/") ||
              id === "@solidjs/router" ||
              id.startsWith("@ericsanchezok/synergy-ui/")
            )
              return stub
          },
        },
      ],
      build: {
        outDir: path.join(directory, "dist"),
        lib: { entry, formats: ["es"], fileName: "fixture" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    const fixture = (await import(pathToFileURL(path.join(directory, "dist/fixture.js")).href)) as {
      mount(): {
        add(files: File[]): Promise<void>
        configure(limits: Config["attachment"]): void
        uploaded: string[]
        toasts: { title: string }[]
        reset(): void
        dispose(): void
      }
    }
    const instance = fixture.mount()
    const file = (name: string, size: number) => new File([new Uint8Array(size)], name)
    try {
      await instance.add([file("first", 1), file("second", 1)])
      expect(instance.uploaded).toEqual([])
      expect(instance.toasts.at(-1)?.title).toBe("Too many files")
      await instance.add([file("oversized", 9)])
      expect(instance.uploaded).toEqual([])
      expect(instance.toasts.at(-1)?.title).toBe("File too large")
      await instance.add([file("accepted", 8)])
      expect(instance.uploaded).toEqual(["accepted"])
      instance.configure({ maxFiles: 3, maxFileBytes: 12, maxTotalBytes: 15 })
      await instance.add([file("over-total", 8)])
      expect(instance.uploaded).toEqual(["accepted"])
      expect(instance.toasts.at(-1)?.title).toBe("Files too large")
      instance.reset()
      await instance.add([file("after-reload", 12)])
      expect(instance.uploaded).toEqual(["after-reload"])
      instance.configure({ maxFiles: 2 })
      await instance.add([file("fallback-bytes", 101)])
      expect(instance.uploaded).toEqual(["after-reload", "fallback-bytes"])
    } finally {
      instance.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
