import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createMemo, createRoot, onCleanup } from "solid-js"
import { firstBy, uniqueBy } from "remeda"
import type {
  ProviderListResponse,
  WorkspaceFileNode,
  WorkspaceFileReadResult,
  WorkspaceFileStatusSummary,
} from "@ericsanchezok/synergy-sdk"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createModelVariantSession } from "./model-variant"
import * as ComposerIntent from "./composer-intent"

export type LocalFile = WorkspaceFileNode &
  Partial<{
    loaded: boolean
    pinned: boolean
    expanded: boolean
    content: WorkspaceFileReadResult
    selection: { startLine: number; startChar: number; endLine: number; endChar: number }
    scrollTop: number
    view: "raw" | "diff-unified" | "diff-split"
    folded: string[]
    selectedChange: number
    status: WorkspaceFileStatusSummary["files"][number]
  }>
export type TextSelection = LocalFile["selection"]
export type View = LocalFile["view"]

type ProviderListItem = ProviderListResponse["all"][number]
type ProviderListModel = ProviderListItem["models"][string]

export type LocalModel = Omit<ProviderListModel, "provider"> & {
  provider: ProviderListItem
  latest: boolean
}
export type ModelKey = { providerID: string; modelID: string }

export type FileContext = { type: "file"; path: string; selection?: TextSelection }
export type ContextItem = FileContext

const WORKSPACE_KEY = "__workspace__"
const MAX_MODEL_VARIANT_SESSIONS = 20

type ModelVariantSession = ReturnType<typeof createModelVariantSession>

type ModelVariantCacheEntry = {
  value: ModelVariantSession
  dispose: VoidFunction
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const params = useParams()
    const sync = useSync()
    const providers = useProviders()

    function isModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return (
        !!provider?.models[model.modelID] &&
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.providerID)
      )
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    // Composer intent is scoped per session visit; a not-yet-created session
    // (new-session composer) uses a stable sentinel key so a selection made
    // before the session exists still applies to the first prompt.
    const NEW_SESSION_INTENT_KEY = "__new__"
    const intentKey = () => params.id ?? NEW_SESSION_INTENT_KEY

    const agent = (() => {
      const list = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      // draft: explicit per-session user choice; global: last choice, used for the
      // new-session composer. History (sessionDefault) is a read-only derivation
      // and is never written back here — that is the #318 fix.
      const [store, setStore] = createStore<{
        global?: string
        draft: Record<string, string>
      }>({
        global: undefined,
        draft: {},
      })
      const sessionDefault = createMemo(() =>
        ComposerIntent.sessionDefaultAgent(params.id ? sync.data.message[params.id] : undefined),
      )
      const isSelectable = (name: string) => list().some((x) => x.name === name)
      const currentName = createMemo(() => {
        const available = list()
        if (available.length === 0) return undefined
        return (
          ComposerIntent.resolveAgent([store.draft[intentKey()], sessionDefault(), store.global], isSelectable) ??
          available[0].name
        )
      })
      return {
        list,
        current() {
          const available = list()
          if (available.length === 0) return undefined
          const name = currentName()
          return available.find((x) => x.name === name) ?? available[0]
        },
        set(name: string | undefined) {
          const available = list()
          if (available.length === 0) return
          const target = name && isSelectable(name) ? name : available[0].name
          setStore("draft", intentKey(), target)
          setStore("global", target)
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) return
          let next = available.findIndex((x) => x.name === currentName()) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("draft", intentKey(), value.name)
          setStore("global", value.name)
          if (value.model)
            model.set({
              providerID: value.model.providerID,
              modelID: value.model.modelID,
            })
        },
      }
    })()

    const model = (() => {
      function migrateModelStore(value: unknown) {
        if (!value || typeof value !== "object") return value

        const record = value as Record<string, unknown>
        const recent = Array.isArray(record.recent) ? (record.recent as ModelKey[]) : []
        const quickSwitcher = Array.isArray(record.quickSwitcher)
          ? (record.quickSwitcher as (ModelKey & { state: "add" | "remove" })[])
          : Array.isArray(record.user)
            ? record.user.flatMap((item) => {
                if (!item || typeof item !== "object") return []
                const entry = item as Record<string, unknown>
                if (typeof entry.providerID !== "string" || typeof entry.modelID !== "string") return []
                const state = entry.visibility === "hide" ? "remove" : "add"
                return [{ providerID: entry.providerID, modelID: entry.modelID, state: state as "add" | "remove" }]
              })
            : []

        return {
          quickSwitcher,
          recent,
        }
      }

      const [store, setStore, _, modelReady] = persisted(
        {
          ...Persist.global("model", ["model.v1"]),
          migrate: migrateModelStore,
        },
        createStore<{
          quickSwitcher: (ModelKey & { state: "add" | "remove" })[]
          recent: ModelKey[]
        }>({
          quickSwitcher: [],
          recent: [],
        }),
      )

      // Session-scoped draft of the user's explicit model choice (keyed by
      // session id, or the new-session sentinel). Replaces the old agent-scoped
      // ephemeral store, which leaked model choices across sessions sharing an
      // agent and could not distinguish user intent from history (#318).
      const [draft, setDraft] = createStore<{
        model: Record<string, ModelKey>
      }>({
        model: {},
      })

      const variantCache = new Map<string, ModelVariantCacheEntry>()

      const disposeVariantCache = () => {
        for (const entry of variantCache.values()) {
          entry.dispose()
        }
        variantCache.clear()
      }

      onCleanup(disposeVariantCache)

      const pruneVariantCache = () => {
        while (variantCache.size > MAX_MODEL_VARIANT_SESSIONS) {
          const first = variantCache.keys().next().value
          if (!first) return
          const entry = variantCache.get(first)
          entry?.dispose()
          variantCache.delete(first)
        }
      }

      const loadVariantSession = (dir: string, id: string | undefined) => {
        const key = `${dir}:${id ?? WORKSPACE_KEY}`
        const existing = variantCache.get(key)
        if (existing) {
          variantCache.delete(key)
          variantCache.set(key, existing)
          return existing.value
        }

        const entry = createRoot((dispose) => ({
          value: createModelVariantSession(dir, id),
          dispose,
        }))

        variantCache.set(key, entry)
        pruneVariantCache()
        return entry.value
      }

      const variantSession = createMemo(() => loadVariantSession(sdk.scopeKey, params.id))

      const keyOf = (model: ModelKey) => `${model.providerID}:${model.modelID}`
      const keyOfLocalModel = (model: LocalModel) => keyOf({ providerID: model.provider.id, modelID: model.id })

      const available = createMemo(() =>
        providers.connected().flatMap((p) =>
          Object.values(p.models).map((m) => ({
            ...m,
            provider: p,
          })),
        ),
      )

      const all = createMemo(() =>
        available().map((m) => ({
          ...m,
          name: m.name.replace("(latest)", "").trim(),
          latest: m.name.includes("(latest)"),
        })),
      )

      const find = (key: ModelKey | undefined) => {
        if (!key) return undefined
        return all().find((m) => m.id === key.modelID && m.provider.id === key.providerID)
      }

      const recommended = createMemo(() => {
        const result: ModelKey[] = []
        const push = (model: LocalModel | undefined) => {
          if (!model) return
          const entry = { providerID: model.provider.id, modelID: model.id }
          if (!result.some((item) => item.providerID === entry.providerID && item.modelID === entry.modelID)) {
            result.push(entry)
          }
        }
        const newest = (models: LocalModel[]) => firstBy(models, [(x) => x.release_date, "desc"])

        for (const provider of providers.connected()) {
          const providerModels = all().filter((model) => model.provider.id === provider.id)
          if (providerModels.length === 0) continue

          const defaultModelID = providers.default()[provider.id]
          push(find(defaultModelID ? { providerID: provider.id, modelID: defaultModelID } : undefined))
          push(newest(providerModels.filter((model) => model.reasoning)))
          push(
            newest(providerModels.filter((model) => (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0)),
          )
          push(
            newest(
              providerModels.filter(
                (model) =>
                  model.modalities?.input?.includes("image") ||
                  model.modalities?.input?.includes("pdf") ||
                  model.modalities?.input?.includes("video"),
              ),
            ),
          )
        }

        return uniqueBy(result, keyOf)
      })

      const recommendedSet = createMemo(() => new Set(recommended().map(keyOf)))

      const quickSwitcherPreferences = createMemo(() => sync.data.config.quick_switcher?.models ?? [])

      const quickSwitcherPreferenceMap = createMemo(() => {
        const map = new Map<string, "add" | "remove">()
        for (const item of quickSwitcherPreferences()) {
          map.set(keyOf(item), item.state)
        }
        return map
      })

      const fallbackModel = createMemo((): ModelKey | undefined => {
        if (sync.data.config.model) {
          const [providerID, modelID] = sync.data.config.model.split("/")
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of store.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        for (const p of providers.connected()) {
          if (p.id in providers.default()) {
            return {
              providerID: p.id,
              modelID: providers.default()[p.id],
            }
          }
        }

        // No model available yet (e.g. user is still configuring providers, or
        // the connected provider has no default model mapping). Returning
        // undefined lets the current() memo resolve gracefully instead of
        // throwing when model settings open with no valid model configured.
        return undefined
      })

      // Layer 2: the session's default model — server modelOverride, else the
      // model inherited from the last root user message. Read-only derivation;
      // never written back, so it cannot clobber the user's draft (#318).
      const sessionDefaultModel = createMemo((): ModelKey | undefined => {
        const id = params.id
        if (!id) return undefined
        return ComposerIntent.sessionDefaultModel(sync.session.get(id)?.modelOverride, sync.data.message[id])
      })

      const current = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        const key = getFirstValidModel(
          () => draft.model[intentKey()],
          () => sessionDefaultModel(),
          () => a.model,
          fallbackModel,
        )
        if (!key) return undefined
        return find(key)
      })

      const sessionDefaultVariant = createMemo((): string | undefined => {
        const id = params.id
        const m = current()
        if (!id || !m) return undefined
        return ComposerIntent.sessionDefaultVariant({ providerID: m.provider.id, modelID: m.id }, sync.data.message[id])
      })

      const recent = createMemo(() => store.recent.map(find).filter((model): model is LocalModel => !!model))

      function inQuickSwitcher(model: ModelKey) {
        const key = keyOf(model)
        const preference = quickSwitcherPreferenceMap().get(key)
        if (preference === "remove") return false
        if (preference === "add") return true
        return recommendedSet().has(key)
      }

      const quickSwitcherOnly = createMemo(() =>
        all().filter((item) => inQuickSwitcher({ providerID: item.provider.id, modelID: item.id })),
      )

      const quickSwitcher = createMemo(() => uniqueBy([...recent(), ...quickSwitcherOnly()], keyOfLocalModel))

      const cycle = (direction: 1 | -1) => {
        const recentList = recent()
        const currentModel = current()
        if (!currentModel) return

        const index = recentList.findIndex(
          (x) => x?.provider.id === currentModel.provider.id && x?.id === currentModel.id,
        )
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = recentList.length - 1
        if (next >= recentList.length) next = 0

        const val = recentList[next]
        if (!val) return

        model.set({
          providerID: val.provider.id,
          modelID: val.id,
        })
      }

      return {
        ready: modelReady,
        current,
        recent,
        all,
        quickSwitcher,
        quickSwitcherPreferences,
        cycle,
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          batch(() => {
            // Explicit user choice → session-scoped draft (layer 1). Falling back
            // to fallbackModel() keeps a concrete value when the caller clears.
            const resolved = model ?? fallbackModel()
            if (resolved) setDraft("model", intentKey(), resolved)
            if (options?.recent && model) {
              const uniq = uniqueBy([model, ...store.recent], (x) => x.providerID + x.modelID)
              if (uniq.length > 5) uniq.pop()
              setStore("recent", uniq)
            }
          })
          // A genuine selector pick (recent) persists as the session's
          // modelOverride (layer 2), so the choice survives reload and matches
          // the channel /model command. Fire-and-forget; the draft already
          // reflects it locally. Skipped for the new-session composer.
          if (options?.recent && model && params.id) {
            void sdk.client.session
              .update({ sessionID: params.id, modelOverride: { providerID: model.providerID, modelID: model.modelID } })
              .catch(() => {})
          }
        },
        inQuickSwitcher,
        isRecommended(model: ModelKey) {
          return recommendedSet().has(keyOf(model))
        },
        variant: {
          current() {
            const m = current()
            if (!m) return undefined
            const modelKey = { providerID: m.provider.id, modelID: m.id }
            const session = variantSession()
            if (session.has(modelKey)) return session.get(modelKey)
            return sessionDefaultVariant()
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined, target?: ModelKey) {
            const m = current()
            const modelKey = target ?? (m ? { providerID: m.provider.id, modelID: m.id } : undefined)
            if (!modelKey) return
            variantSession().set(modelKey, value)
          },
          setForSession(sessionID: string, value: string | undefined, target?: ModelKey, scopeKey = sdk.scopeKey) {
            const m = current()
            const modelKey = target ?? (m ? { providerID: m.provider.id, modelID: m.id } : undefined)
            if (!modelKey) return
            loadVariantSession(scopeKey, sessionID).set(modelKey, value)
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const currentVariant = this.current()
            if (!currentVariant) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(currentVariant)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })()

    const file = (() => {
      const [store, setStore] = createStore<{
        node: Record<string, LocalFile>
        children: Record<string, string[]>
      }>({
        node: {}, //  Object.fromEntries(sync.data.node.map((x) => [x.path, x])),
        children: {},
      })

      const relative = (input: string) => {
        const root = sync.data.path.directory
        const prefix = root.endsWith("/") ? root : root + "/"
        if (input === root) return ""
        if (input.startsWith(prefix)) return input.slice(prefix.length)
        if (input.startsWith("./")) return input.slice(2)
        if (input.startsWith("/")) return input.slice(1)
        return input
      }

      const load = async (path: string) => {
        const relativePath = relative(path)
        await sdk.client.workspace.files
          .read({ path: relativePath })
          .then((x) => {
            if (!store.node[relativePath]) return
            setStore(
              "node",
              relativePath,
              produce((draft) => {
                draft.loaded = true
                draft.content = x.data
              }),
            )
          })
          .catch((e) => {
            showToast({
              type: "error",
              title: "Failed to load file",
              description: e.message,
            })
          })
      }

      const fetch = async (path: string) => {
        const relativePath = relative(path)
        const parent = relativePath.split("/").slice(0, -1).join("/")
        if (parent) {
          await list(parent)
        }
      }

      const isDirectChild = (parent: string, child: string) => {
        if (!parent) return !!child && !child.includes("/")
        if (!child.startsWith(parent + "/")) return false
        const rest = child.slice(parent.length + 1)
        return !!rest && !rest.includes("/")
      }

      const init = async (path: string) => {
        const relativePath = relative(path)
        if (!store.node[relativePath]) await fetch(path)
        if (store.node[relativePath]?.loaded) return
        return load(relativePath)
      }

      const open = async (path: string, options?: { pinned?: boolean; view?: LocalFile["view"] }) => {
        const relativePath = relative(path)
        if (!store.node[relativePath]) await fetch(path)
        // setStore("opened", (x) => {
        //   if (x.includes(relativePath)) return x
        //   return [
        //     ...opened()
        //       .filter((x) => x.pinned)
        //       .map((x) => x.path),
        //     relativePath,
        //   ]
        // })
        // setStore("active", relativePath)
        // context.addActive()
        if (options?.pinned) setStore("node", relativePath, "pinned", true)
        if (options?.view && store.node[relativePath].view === undefined)
          setStore("node", relativePath, "view", options.view)
        if (store.node[relativePath]?.loaded) return
        return load(relativePath)
      }

      const list = async (path: string) => {
        const relativePath = relative(path)
        return sdk.client.workspace.files
          .children({ path: relativePath })
          .then((x) => {
            setStore(
              produce((draft) => {
                if (x.data?.parent) {
                  const parent = x.data.parent
                  draft.node[parent.path] = { ...draft.node[parent.path], ...parent }
                }
                const parentPath = x.data?.path ?? relativePath
                const childPaths = new Set(x.data?.children.map((node) => node.path) ?? [])
                draft.children[parentPath] = Array.from(childPaths)
                for (const key of Object.keys(draft.node)) {
                  if (isDirectChild(parentPath, key) && !childPaths.has(key)) {
                    delete draft.node[key]
                  }
                }
                x.data!.children.forEach((node) => {
                  draft.node[node.path] = { ...draft.node[node.path], ...node }
                })
              }),
            )
          })
          .catch(() => {})
      }

      const searchFiles = (query: string) =>
        sdk.client.workspace.files
          .search({ query, kind: "files" })
          .then((x) => (x.data?.items ?? []).filter((item) => item.kind === "file" && item.type === "file"))
          .then((items) => items.map((item) => item.path))
      const searchFilesAndDirectories = (query: string) =>
        sdk.client.workspace.files
          .search({ query, kind: "files" })
          .then((x) => (x.data?.items ?? []).filter((item) => item.kind === "file"))
          .then((items) => items.map((item) => item.path))

      const unsub = sdk.event.listen((e) => {
        const event = e.details
        switch (event.type) {
          case "file.watcher.updated":
            const relativePath = relative(event.properties.file)
            if (relativePath.startsWith(".git/")) return
            const parent = relative(event.properties.parent ?? relativePath.split("/").slice(0, -1).join("/"))
            const oldPath = relative(event.properties.oldPath ?? "")
            const oldParent = oldPath ? oldPath.split("/").slice(0, -1).join("/") : undefined
            if (event.properties.event === "deleted") {
              setStore(
                produce((draft) => {
                  for (const key of Object.keys(draft.node)) {
                    if (key === relativePath || key.startsWith(relativePath + "/")) {
                      delete draft.node[key]
                      delete draft.children[key]
                    }
                  }
                  draft.children[parent] = (draft.children[parent] ?? []).filter((item) => item !== relativePath)
                }),
              )
              if (store.node[parent]?.loaded) list(parent)
              return
            }
            if (event.properties.event === "renamed") {
              setStore(
                produce((draft) => {
                  if (!oldPath) return
                  for (const key of Object.keys(draft.node)) {
                    if (key === oldPath || key.startsWith(oldPath + "/")) {
                      delete draft.node[key]
                      delete draft.children[key]
                    }
                  }
                  if (oldParent !== undefined) {
                    draft.children[oldParent] = (draft.children[oldParent] ?? []).filter((item) => item !== oldPath)
                  }
                }),
              )
              if (oldParent !== undefined && store.node[oldParent]?.loaded) list(oldParent)
              if (store.node[parent]?.loaded) list(parent)
              return
            }
            if (event.properties.event === "added") {
              if (store.node[parent]?.loaded) list(parent)
              return
            }
            if (store.node[relativePath]) load(relativePath)
            if (store.node[parent]?.loaded) list(parent)
            break
        }
      })
      onCleanup(unsub)

      return {
        node: async (path: string) => {
          if (!store.node[path] || !store.node[path].loaded) {
            await init(path)
          }
          return store.node[path]
        },
        update: (path: string, node: LocalFile) => setStore("node", path, reconcile(node)),
        open,
        load,
        init,
        expand(path: string) {
          setStore("node", path, "expanded", true)
          if (store.node[path]?.loaded) return
          setStore("node", path, "loaded", true)
          list(path)
        },
        collapse(path: string) {
          setStore("node", path, "expanded", false)
        },
        select(path: string, selection: TextSelection | undefined) {
          setStore("node", path, "selection", selection)
        },
        scroll(path: string, scrollTop: number) {
          setStore("node", path, "scrollTop", scrollTop)
        },
        view(path: string): View {
          const n = store.node[path]
          return n && n.view ? n.view : "raw"
        },
        setView(path: string, view: View) {
          setStore("node", path, "view", view)
        },
        unfold(path: string, key: string) {
          setStore("node", path, "folded", (xs) => {
            const a = xs ?? []
            if (a.includes(key)) return a
            return [...a, key]
          })
        },
        fold(path: string, key: string) {
          setStore("node", path, "folded", (xs) => (xs ?? []).filter((k) => k !== key))
        },
        folded(path: string) {
          const n = store.node[path]
          return n && n.folded ? n.folded : []
        },
        changeIndex(path: string) {
          return store.node[path]?.selectedChange
        },
        setChangeIndex(path: string, index: number | undefined) {
          setStore("node", path, "selectedChange", index)
        },
        // changes,
        // changed,
        children(path: string) {
          const parent = relative(path)
          return (store.children[parent] ?? [])
            .map((childPath) => store.node[childPath])
            .filter((node): node is LocalFile => !!node)
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : b.type === "directory" ? 1 : 0
              return a.name.localeCompare(b.name)
            })
        },
        searchFiles,
        searchFilesAndDirectories,
        relative,
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.scopeKey)),
      model,
      agent,
      file,
    }
    return result
  },
})
