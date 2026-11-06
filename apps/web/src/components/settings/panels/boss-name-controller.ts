import { createSignal } from "solid-js"
import { bossNameFromRows, createBossNamePersister, type BossNameGateway } from "./boss-name-model"

export function createBossNameController(gateway: BossNameGateway) {
  const [content, setContent] = createSignal("")
  const [saved, setSaved] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [status, setStatus] = createSignal<"idle" | "loading" | "saving" | "error">("idle")
  const [error, setError] = createSignal<string>()
  const persister = createBossNamePersister(gateway)
  const dirty = () => loaded() && content().trim() !== saved()
  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause))
    setStatus("error")
  }
  async function load() {
    if (status() === "loading" || status() === "saving") return
    setStatus("loading")
    const previous = saved()
    try {
      const next = bossNameFromRows(await gateway.listSelfMemories())
      if (content().trim() === previous) setContent(next)
      setSaved(next)
      persister.adoptStoredName(next)
      setLoaded(true)
      setError(undefined)
      setStatus("idle")
    } catch (cause) {
      fail(cause)
    }
  }
  async function save() {
    if (status() === "loading" || status() === "saving") return false
    if (!dirty()) return true
    const submitted = content().trim()
    setStatus("saving")
    try {
      await persister.persist(submitted)
      setSaved(submitted)
      setError(undefined)
      setStatus("idle")
      return true
    } catch (cause) {
      fail(cause)
      return false
    }
  }
  function discard() {
    setContent(saved())
    setError(undefined)
    setStatus("idle")
  }
  return { content, setContent, dirty, loaded, status, error, load, save, discard }
}
export type BossNameController = ReturnType<typeof createBossNameController>
