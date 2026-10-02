import { experiencePreview } from "./experience-preview"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExperienceInfo, MemoryInfo, SkillSummary } from "@ericsanchezok/synergy-sdk/client"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import type { useGlobalSDK } from "@/context/global-sdk"
import { useLocale } from "@/context/locale"
import { relativeTime } from "@/utils/time"
import { createLibraryCollection } from "./library-collection"
import { createExperienceDetails } from "./experience-details"
import { ExperienceCard } from "./experience-view"
import { MemoryCard } from "./memory-view"
import type { View } from "./shared"

type RecentItem = { kind: "memory"; item: MemoryInfo } | { kind: "experience"; item: ExperienceInfo }
export type LibraryHomeSync = { sync: () => Promise<void>; syncing: () => boolean }

export function LibraryHome(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  scopeID?: string
  scopeLabel?: (id: string) => string | undefined
  onBrowse: (view: View, search?: string) => void
  registerSync: (handle: LibraryHomeSync | undefined) => void
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const { fmt } = useLocale()
  const memories = createLibraryCollection<MemoryInfo>(
    () => props.search,
    async (query, signal) => {
      const result = query
        ? await props.sdk.client.library.search({ query, topK: 20 }, { signal, throwOnError: true })
        : await props.sdk.client.library.list(undefined, { signal, throwOnError: true })
      return result.data ?? []
    },
  )
  const experiences = createLibraryCollection<ExperienceInfo>(
    () => props.search,
    async (query, signal) => {
      if (query) {
        const result = await props.sdk.client.library.experience.search(
          { query, topK: 20 },
          { signal, throwOnError: true },
        )
        return result.data ?? []
      }
      const result = await props.sdk.client.library.experience.page(
        { sort: "updated", limit: 20 },
        { signal, throwOnError: true },
      )
      return result.data?.items ?? []
    },
  )
  const skills = createLibraryCollection<SkillSummary>(
    () => props.scopeID ?? "",
    async (scopeID, signal) => {
      const result = await props.sdk.client.skill.list(
        { scopeID: scopeID || undefined },
        { signal, throwOnError: true },
      )
      return result.data?.items ?? []
    },
  )
  const details = createExperienceDetails(async (id, signal) => {
    const result = await props.sdk.client.library.experience.get({ id }, { signal, throwOnError: true })
    if (!result.data) throw new Error("Missing experience detail")
    return result.data
  })
  let detailDialog: string | undefined
  onCleanup(() => {
    if (detailDialog) dialog.close(detailDialog)
  })
  const [sections, setSections] = createSignal(new Set<string>())
  const labels = createMemo(() => ({
    memory: _({ id: "app.library.nav.memories", message: "Memories" }),
    experience: _({ id: "app.library.nav.experiences", message: "Experiences" }),
    skill: _({ id: "app.library.nav.skills", message: "Skills" }),
  }))
  const sources = () => [
    { id: "memory" as const, ...memories },
    { id: "experience" as const, ...experiences },
    { id: "skill" as const, ...skills },
  ]
  createEffect(() => {
    props.registerSync({
      sync: async () => {
        await Promise.all(sources().map((source) => source.refresh()))
      },
      syncing: () => sources().some((source) => source.loading()),
    })
  })
  onCleanup(() => props.registerSync(undefined))
  createEffect(() => {
    props.search
    props.scopeID
    if (detailDialog) dialog.close(detailDialog)
    detailDialog = undefined
  })
  const recent = createMemo<RecentItem[]>(() =>
    [
      ...memories.items().map((item) => ({ kind: "memory" as const, item })),
      ...experiences.items().map((item) => ({ kind: "experience" as const, item })),
    ]
      .sort((a, b) => b.item.updatedAt - a.item.updatedAt)
      .slice(0, 20),
  )
  const matchingSkills = createMemo(() => {
    const query = props.search.toLocaleLowerCase()
    return skills.items().filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(query))
  })
  function toggle(entry: RecentItem) {
    if (entry.kind === "experience") void details.load(entry.item.id)
    setSections(new Set([`${entry.item.id}-script`]))
    detailDialog = dialog.show(
      () => (
        <Dialog size="wide" class="app-panel-detail-dialog library-detail-dialog" title={labels()[entry.kind]}>
          {entry.kind === "memory" ? (
            <MemoryCard
              detailPresentation
              item={entry.item}
              expanded
              similarity={undefined}
              searching={false}
              selecting={false}
              selected={false}
              onToggle={() => dialog.close(detailDialog)}
            />
          ) : (
            <ExperienceCard
              sdk={props.sdk}
              sourceScopeName={props.scopeLabel?.(entry.item.scopeID)}
              detailPresentation
              item={entry.item}
              expanded
              similarity={undefined}
              searching={false}
              selecting={false}
              selected={false}
              detail={details.read(entry.item.id)?.data}
              detailError={!!details.read(entry.item.id)?.error}
              onRetry={() => void details.load(entry.item.id)}
              expandedSections={sections()}
              onToggle={() => dialog.close(detailDialog)}
              onToggleSection={(key) =>
                setSections((previous) => {
                  const next = new Set(previous)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
            />
          )}
        </Dialog>
      ),
      () => {
        detailDialog = undefined
      },
    )
  }
  function rows(entries: RecentItem[]) {
    return (
      <div class="library-home-results">
        <For each={entries}>
          {(entry) => {
            const preview = () => (entry.kind === "experience" ? experiencePreview(entry.item.intent) : undefined)
            return (
              <div class="library-home-item">
                <button type="button" class="library-home-result" aria-haspopup="dialog" onClick={() => toggle(entry)}>
                  <span class="library-home-result-main">
                    <span class="app-panel-row-title text-text-strong">
                      {entry.kind === "memory"
                        ? entry.item.title
                        : preview()?.title ||
                          (entry.item.rewardStatus === "encoding_failed"
                            ? _({
                                id: "app.library.experience.encodingFailedTitle",
                                message: "Experience encoding failed",
                              })
                            : _({ id: "app.library.experience.missingIntent", message: "Intent not recorded" }))}
                    </span>
                    <Show when={entry.kind === "memory" ? entry.item.content : preview()?.summary}>
                      {(summary) => <span class="app-panel-copy text-text-weak">{summary()}</span>}
                    </Show>
                  </span>
                  <span class="library-home-result-meta app-panel-caption">
                    <span>{labels()[entry.kind]}</span>
                    <Show when={entry.kind === "experience"}>
                      <span>
                        {entry.kind === "experience" &&
                          (entry.item.rewardStatus === "encoding_failed"
                            ? _({ id: "app.library.experience.status.failed", message: "Encoding failed" })
                            : entry.item.rewardStatus === "pending"
                              ? _({ id: "app.library.experience.status.pending", message: "Pending evaluation" })
                              : _({ id: "app.library.experience.status.evaluated", message: "Evaluated" }))}
                      </span>
                    </Show>
                    <span>{relativeTime(fmt, entry.item.updatedAt)}</span>
                  </span>
                </button>
              </div>
            )
          }}
        </For>
      </div>
    )
  }
  return (
    <div class="library-home">
      <For each={sources()}>
        {(source) => (
          <Show when={source.error()}>
            <div class="library-home-notice" role="alert">
              <span>
                {_({
                  id: "app.library.home.groupFailed",
                  message: "Unable to refresh {group}. Other results remain available.",
                  values: { group: labels()[source.id] },
                })}
              </span>
              <button type="button" disabled={source.loading()} onClick={() => void source.refresh()}>
                {_({ id: "app.library.stats.retry", message: "Retry" })}
              </button>
            </div>
          </Show>
        )}
      </For>
      <Show when={sources().some((source) => source.loading())}>
        <p role="status" class="app-panel-caption text-text-weak">
          {_({ id: "app.library.home.loading", message: "Loading library…" })}
        </p>
      </Show>
      <Show
        when={!props.search}
        fallback={
          <>
            <For each={["memory", "experience"] as const}>
              {(kind) => (
                <section>
                  <h2>{labels()[kind]}</h2>
                  {rows(
                    kind === "memory"
                      ? memories.items().map((item) => ({ kind, item }))
                      : experiences.items().map((item) => ({ kind, item })),
                  )}
                  <Show
                    when={
                      !(kind === "memory"
                        ? memories.loading() || memories.error() || memories.items().length
                        : experiences.loading() || experiences.error() || experiences.items().length)
                    }
                  >
                    <p class="library-home-empty">
                      {_({ id: "app.library.home.noMatches", message: "No matching results" })}
                    </p>
                  </Show>
                </section>
              )}
            </For>
            <section>
              <h2>{labels().skill}</h2>
              <div class="library-home-results">
                <For each={matchingSkills()}>
                  {(skill) => (
                    <button
                      type="button"
                      class="library-home-result"
                      onClick={() => props.onBrowse("skill", skill.name)}
                    >
                      <span class="library-home-result-main">
                        <span class="app-panel-row-title text-text-strong">{skill.name}</span>
                        <span class="app-panel-caption text-text-weak">{skill.description}</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <Show when={!skills.loading() && !skills.error() && !matchingSkills().length}>
                <p class="library-home-empty">
                  {_({ id: "app.library.home.noMatches", message: "No matching results" })}
                </p>
              </Show>
            </section>
          </>
        }
      >
        <section>
          <h2>{_({ id: "app.library.home.recent", message: "Recently updated" })}</h2>
          {rows(recent())}
          <Show
            when={
              !memories.loading() &&
              !experiences.loading() &&
              !memories.error() &&
              !experiences.error() &&
              !recent().length
            }
          >
            <p class="library-home-empty">
              {_({ id: "app.library.home.empty", message: "Your memories and experiences will appear here." })}
            </p>
          </Show>
        </section>
      </Show>
    </div>
  )
}
