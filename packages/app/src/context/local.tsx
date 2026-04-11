import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createMemo, onCleanup } from "solid-js"
import { firstBy, uniqueBy } from "remeda"
import type { FileContent, FileNode, File as FileStatus, ProviderListResponse } from "@ericsanchezok/synergy-sdk"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useProviders } from "@/hooks/use-providers"
import { DateTime } from "luxon"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

export type LocalFile = FileNode &
  Partial<{
    loaded: boolean
    pinned: boolean
    expanded: boolean
    content: FileContent
    selection: { startLine: number; startChar: number; endLine: number; endChar: number }
    scrollTop: number
    view: "raw" | "diff-unified" | "diff-split"
    folded: string[]
    selectedChange: number
    status: FileStatus
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

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
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

    const agent = (() => {
      const list = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const [store, setStore] = createStore<{
        current?: string
      }>({
        current: list()[0]?.name,
      })
      return {
        list,
        current() {
          const available = list()
          if (available.length === 0) return undefined
          return available.find((x) => x.name === store.current) ?? available[0]
        },
        set(name: string | undefined) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          if (name && available.some((x) => x.name === name)) {
            setStore("current", name)
            return
          }
          setStore("current", available[0].name)
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
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
        if (Array.isArray(record.quickSwitcher)) return record

        const recent = Array.isArray(record.recent) ? (record.recent as ModelKey[]) : []
        const variant = record.variant && typeof record.variant === "object" ? record.variant : {}
        const quickSwitcher = Array.isArray(record.user)
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
          variant,
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
          variant?: Record<string, string | undefined>
        }>({
          quickSwitcher: [],
          recent: [],
          variant: {},
        }),
      )

      const [ephemeral, setEphemeral] = createStore<{
        model: Record<string, ModelKey>
      }>({
        model: {},
      })

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

      const quickSwitcherPreferenceMap = createMemo(() => {
        const map = new Map<string, "add" | "remove">()
        for (const item of store.quickSwitcher) {
          map.set(keyOf(item), item.state)
        }
        return map
      })

      const fallbackModel = createMemo(() => {
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

        throw new Error("No default model found")
      })

      const current = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        const key = getFirstValidModel(
          () => ephemeral.model[a.name],
          () => a.model,
          fallbackModel,
        )
        if (!key) return undefined
        return find(key)
      })

      const recent = createMemo(() => store.recent.map(find).filter((model): model is LocalModel => !!model))

      function inQuickSwitcher(model: ModelKey) {
        const key = keyOf(model)
        const preference = quickSwitcherPreferenceMap().get(key)
        if (preference === "remove") return false
        if (preference === "add") return true
        return recommendedSet().has(key)
      }

      function updateQuickSwitcherPreference(model: ModelKey, included: boolean) {
        const recommendedByDefault = recommendedSet().has(keyOf(model))
        const nextState = included === recommendedByDefault ? undefined : included ? "add" : "remove"
        const index = store.quickSwitcher.findIndex(
          (item) => item.providerID === model.providerID && item.modelID === model.modelID,
        )

        if (!nextState) {
          if (index >= 0) {
            setStore("quickSwitcher", (items) => items.filter((_, itemIndex) => itemIndex !== index))
          }
          return
        }

        if (index >= 0) {
          setStore("quickSwitcher", index, { ...store.quickSwitcher[index], state: nextState })
          return
        }

        setStore("quickSwitcher", store.quickSwitcher.length, { ...model, state: nextState })
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
        cycle,
        set(model: ModelKey | undefined, options?: { recent?: boolean }) {
          batch(() => {
            const currentAgent = agent.current()
            if (currentAgent) setEphemeral("model", currentAgent.name, model ?? fallbackModel())
            if (model) updateQuickSwitcherPreference(model, true)
            if (options?.recent && model) {
              const uniq = uniqueBy([model, ...store.recent], (x) => x.providerID + x.modelID)
              if (uniq.length > 5) uniq.pop()
              setStore("recent", uniq)
            }
          })
        },
        inQuickSwitcher,
        setQuickSwitcher(model: ModelKey, included: boolean) {
          updateQuickSwitcherPreference(model, included)
        },
        isRecommended(model: ModelKey) {
          return recommendedSet().has(keyOf(model))
        },
        variant: {
          current() {
            const m = current()
            if (!m) return undefined
            const key = `${m.provider.id}/${m.id}`
            return store.variant?.[key]
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            const key = `${m.provider.id}/${m.id}`
            if (!store.variant) {
              setStore("variant", { [key]: value })
            } else {
              setStore("variant", key, value)
            }
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
      }>({
        node: {}, //  Object.fromEntries(sync.data.node.map((x) => [x.path, x])),
      })

      const relative = (path: string) => path.replace(sync.data.path.directory + "/", "")

      const load = async (path: string) => {
        const relativePath = relative(path)
        await sdk.client.file
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
              variant: "error",
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
        if (options?.pinned) setStore("node", path, "pinned", true)
        if (options?.view && store.node[relativePath].view === undefined) setStore("node", path, "view", options.view)
        if (store.node[relativePath]?.loaded) return
        return load(relativePath)
      }

      const list = async (path: string) => {
        return sdk.client.file
          .list({ path: path + "/" })
          .then((x) => {
            setStore(
              "node",
              produce((draft) => {
                x.data!.forEach((node) => {
                  if (node.path in draft) return
                  draft[node.path] = node
                })
              }),
            )
          })
          .catch(() => {})
      }

      const searchFiles = (query: string) => sdk.client.find.files({ query, dirs: "false" }).then((x) => x.data!)
      const searchFilesAndDirectories = (query: string) =>
        sdk.client.find.files({ query, dirs: "true" }).then((x) => x.data!)

      const unsub = sdk.event.listen((e) => {
        const event = e.details
        switch (event.type) {
          case "file.watcher.updated":
            const relativePath = relative(event.properties.file)
            if (relativePath.startsWith(".git/")) return
            if (store.node[relativePath]) load(relativePath)
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
          return Object.values(store.node).filter(
            (x) =>
              x.path.startsWith(path) &&
              x.path !== path &&
              !x.path.replace(new RegExp(`^${path + "/"}`), "").includes("/"),
          )
        },
        searchFiles,
        searchFilesAndDirectories,
        relative,
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      file,
    }
    return result
  },
})
