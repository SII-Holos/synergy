import type { ProviderConnection } from "@ericsanchezok/synergy-sdk/client"
import { createStore } from "solid-js/store"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

type ProviderAccountFields = { name: string; endpoint: string; enabled?: boolean }

export type ProviderSetupDraft = {
  id: string
  name: string
  endpoint: string
  enabled?: boolean
  savedConnection?: ProviderConnection
  baseline?: ProviderAccountFields
  pending?: boolean
  apiKey: string
  targetID?: string
  credentialsSaved?: boolean
  credentialsStarted?: boolean
}

export function nextProviderAccountName(names: string[], format: (number: number) => string) {
  const occupied = new Set(names)
  let number = 2
  while (occupied.has(format(number))) number++
  return format(number)
}

export function createProviderSetupDrafts() {
  const [drafts, setDrafts] = createStore<Record<string, ProviderSetupDraft>>({})
  const [view, setView] = createStore({
    selectedID: undefined as string | undefined,
    addingSourceID: undefined as string | undefined,
    catalogOpen: false,
    addingAdditional: false,
    query: "",
    accountQuery: "",
    origin: undefined as { catalog: boolean; providerID?: string; scroll: number } | undefined,
  })
  function dirty(key: string) {
    const draft = drafts[key]
    if (!draft) return false
    const credentials = !draft.credentialsSaved && Boolean(draft.apiKey || draft.credentialsStarted)
    const metadata =
      !draft.targetID &&
      !draft.savedConnection &&
      (draft.name !== draft.baseline?.name ||
        draft.endpoint !== draft.baseline?.endpoint ||
        draft.enabled !== draft.baseline?.enabled)
    return credentials || metadata
  }
  return {
    view,
    setView,
    dirty(key?: string) {
      return key ? dirty(key) : Object.keys(drafts).some(dirty)
    },
    pending() {
      return Object.values(drafts).some((draft) => draft?.pending)
    },
    peek(key: string) {
      return drafts[key]
    },
    get(key: string, initial: ProviderAccountFields = { name: "", endpoint: "" }) {
      if (!drafts[key])
        setDrafts(key, { id: `account-${generateUUID()}`, ...initial, baseline: { ...initial }, apiKey: "" })
      return drafts[key]
    },
    update(key: string, value: Partial<ProviderSetupDraft>) {
      setDrafts(key, value)
    },
    remove(key: string) {
      setDrafts(key, undefined!)
    },
    clear() {
      for (const key of Object.keys(drafts)) setDrafts(key, undefined!)
      setView({
        selectedID: undefined,
        addingSourceID: undefined,
        catalogOpen: false,
        addingAdditional: false,
        query: "",
        accountQuery: "",
        origin: undefined,
      })
    },
  }
}

export type ProviderSetupDrafts = ReturnType<typeof createProviderSetupDrafts>
