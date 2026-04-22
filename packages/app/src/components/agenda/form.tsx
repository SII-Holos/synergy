import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import type { AgendaItem, AgendaTrigger, AgendaCreateInput, AgendaPatchInput } from "@ericsanchezok/synergy-sdk/client"
import { Panel } from "@/components/panel"
import { startOfDay, addDays, addMonths, startOfWeek, MONTH_NAMES_SHORT, DAY_LABELS_MINI } from "./date"

// ---------------------------------------------------------------------------
// Repeat — "every N unit" model
// ---------------------------------------------------------------------------

type RepeatMode = "off" | "interval" | "custom"
type IntervalUnit = "minutes" | "hours" | "days" | "weeks"

const INTERVAL_UNITS: { value: IntervalUnit; label: string; short: string }[] = [
  { value: "minutes", label: "minutes", short: "m" },
  { value: "hours", label: "hours", short: "h" },
  { value: "days", label: "days", short: "d" },
  { value: "weeks", label: "weeks", short: "w" },
]

function unitToShort(unit: IntervalUnit): string {
  return INTERVAL_UNITS.find((u) => u.value === unit)!.short
}

function shortToUnit(s: string): IntervalUnit {
  const found = INTERVAL_UNITS.find((u) => s.endsWith(u.short))
  return found?.value ?? "days"
}

function parseIntervalString(s: string): { count: number; unit: IntervalUnit } {
  const match = s.match(/^(\d+)(m|h|d|w)$/)
  if (!match) return { count: 1, unit: "days" }
  return { count: parseInt(match[1], 10), unit: shortToUnit(match[2]) }
}

// ---------------------------------------------------------------------------
// Trigger conversion — form state <-> API triggers
// ---------------------------------------------------------------------------

interface ScheduleState {
  hasSchedule: boolean
  date: number
  hour: number
  minute: number
  repeatMode: RepeatMode
  intervalCount: number
  intervalUnit: IntervalUnit
  customCron: string
  cronTz: string
}

function buildTriggers(s: ScheduleState): AgendaTrigger[] {
  if (!s.hasSchedule) return []

  if (s.repeatMode === "off") {
    const d = new Date(s.date)
    d.setHours(s.hour, s.minute, 0, 0)
    return [{ type: "at", at: d.getTime() }]
  }

  if (s.repeatMode === "interval") {
    const short = unitToShort(s.intervalUnit)
    const count = Math.max(1, Math.floor(s.intervalCount))
    if (s.intervalUnit === "minutes" || s.intervalUnit === "hours") {
      return [{ type: "every", interval: `${count}${short}` }]
    }
    if (s.intervalUnit === "days" && count === 1) {
      return [{ type: "cron", expr: `${s.minute} ${s.hour} * * *` }]
    }
    if (s.intervalUnit === "weeks" && count === 1) {
      return [{ type: "cron", expr: `${s.minute} ${s.hour} * * ${new Date(s.date).getDay()}` }]
    }
    return [{ type: "every", interval: `${count}${short}` }]
  }

  if (s.repeatMode === "custom") {
    const expr = s.customCron.trim()
    if (!expr) return []
    return [{ type: "cron", expr, tz: s.cronTz.trim() || undefined }]
  }

  return []
}

function parseTriggersToSchedule(triggers: AgendaTrigger[]): ScheduleState {
  const now = new Date()
  const defaults: ScheduleState = {
    hasSchedule: false,
    date: startOfDay(Date.now()),
    hour: now.getHours(),
    minute: Math.ceil(now.getMinutes() / 5) * 5,
    repeatMode: "off",
    intervalCount: 1,
    intervalUnit: "days",
    customCron: "",
    cronTz: "",
  }

  if (!triggers || triggers.length === 0) return defaults

  const t = triggers[0]

  if (t.type === "at") {
    const d = new Date(t.at)
    return { ...defaults, hasSchedule: true, date: startOfDay(t.at), hour: d.getHours(), minute: d.getMinutes() }
  }

  if (t.type === "every") {
    const parsed = parseIntervalString(t.interval)
    return {
      ...defaults,
      hasSchedule: true,
      repeatMode: "interval",
      intervalCount: parsed.count,
      intervalUnit: parsed.unit,
    }
  }

  if (t.type === "cron") {
    const parts = t.expr.split(/\s+/)
    if (parts.length === 5) {
      const [cronMin, cronHour, cronDay, , cronDow] = parts
      const hour = parseInt(cronHour, 10)
      const min = parseInt(cronMin, 10)
      if (!isNaN(hour) && !isNaN(min)) {
        if (cronDay === "*" && cronDow === "*") {
          return {
            ...defaults,
            hasSchedule: true,
            hour,
            minute: min,
            repeatMode: "interval",
            intervalCount: 1,
            intervalUnit: "days",
          }
        }
        if (cronDay === "*" && /^\d$/.test(cronDow)) {
          const dow = parseInt(cronDow, 10)
          const diff = (dow - now.getDay() + 7) % 7
          return {
            ...defaults,
            hasSchedule: true,
            date: startOfDay(addDays(Date.now(), diff)),
            hour,
            minute: min,
            repeatMode: "interval",
            intervalCount: 1,
            intervalUnit: "weeks",
          }
        }
      }
    }
    return { ...defaults, hasSchedule: true, repeatMode: "custom", customCron: t.expr, cronTz: t.tz ?? "" }
  }

  return defaults
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

// ---------------------------------------------------------------------------
// AgendaForm
// ---------------------------------------------------------------------------

export function AgendaForm(props: { directory: string; item?: AgendaItem; onBack: () => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const isEdit = () => !!props.item

  const parsed = parseTriggersToSchedule(props.item?.triggers ?? [])

  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const [title, setTitle] = createSignal(props.item?.title ?? "")
  const [prompt, setPrompt] = createSignal(props.item?.prompt ?? "")
  const [description, setDescription] = createSignal(props.item?.description ?? "")
  const [tagsText, setTagsText] = createSignal((props.item?.tags ?? []).join(", "))
  const [selectedScopeID, setSelectedScopeID] = createSignal("")

  const [hasSchedule, setHasSchedule] = createSignal(parsed.hasSchedule)
  const [date, setDate] = createSignal(parsed.date)
  const [hour, setHour] = createSignal(parsed.hour)
  const [minute, setMinute] = createSignal(parsed.minute)
  const [repeatMode, setRepeatMode] = createSignal<RepeatMode>(parsed.repeatMode)
  const [intervalCount, setIntervalCount] = createSignal(parsed.intervalCount)
  const [intervalUnit, setIntervalUnit] = createSignal<IntervalUnit>(parsed.intervalUnit)
  const [customCron, setCustomCron] = createSignal(parsed.customCron)
  const [cronTz, setCronTz] = createSignal(parsed.cronTz)

  const [showDesc, setShowDesc] = createSignal(!!props.item?.description)
  const [showTags, setShowTags] = createSignal(!!(props.item?.tags && props.item.tags.length > 0))
  const [showAdvanced, setShowAdvanced] = createSignal(isEdit() && !!props.item?.prompt)

  createEffect(() => {
    if (title().trim() && error() === "Title is required") setError("")
  })

  const scopes = createMemo(() => {
    const home = globalSync.data.path.home
    const seen = new Set<string>()
    const items = (globalSync.data.scope ?? []).filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      if (home && s.worktree === home) return false
      return true
    })
    if (home) items.unshift({ id: "global", worktree: home, name: "Home" } as (typeof items)[0])
    return items
  })

  const currentScopeID = createMemo(() => {
    const dir = props.directory
    if (!dir) return ""
    const [store] = globalSync.child(dir)
    return store.scopeID
  })

  async function save() {
    const t = title().trim()
    if (!t) {
      setError("Title is required")
      return
    }
    setSaving(true)
    setError("")

    const triggers = buildTriggers({
      hasSchedule: hasSchedule(),
      date: date(),
      hour: hour(),
      minute: minute(),
      repeatMode: repeatMode(),
      intervalCount: intervalCount(),
      intervalUnit: intervalUnit(),
      customCron: customCron(),
      cronTz: cronTz(),
    })
    const tags = tagsText()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const promptValue = prompt().trim()

    try {
      if (isEdit()) {
        const patch: AgendaPatchInput = {
          title: t,
          description: description().trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          triggers,
          prompt: promptValue || undefined,
        }
        await sdk.client.agenda.update({ id: props.item!.id, directory: props.directory, agendaPatchInput: patch })
      } else {
        const input: AgendaCreateInput = {
          title: t,
          description: description().trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          triggers: triggers.length > 0 ? triggers : undefined,
          prompt: promptValue,
          createdBy: "user",
        }
        await sdk.client.agenda.create({ directory: props.directory, agendaCreateInput: input })
      }
      props.onBack()
    } catch (err: any) {
      setError(err?.message ?? "Failed to save")
    }
    setSaving(false)
  }

  return (
    <>
      <Panel.Header>
        <Panel.HeaderRow>
          <Panel.Action icon="arrow-left" title="Back" onClick={props.onBack} />
          <Panel.Title>{isEdit() ? "Edit" : "New Item"}</Panel.Title>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-11-medium text-text-weak hover:bg-surface-raised-base-hover transition-colors"
              onClick={props.onBack}
            >
              Cancel
            </button>
            <button
              type="button"
              classList={{
                "px-3 py-1 rounded-lg text-11-medium transition-colors text-white": true,
                "bg-text-interactive-base hover:opacity-85": !saving(),
                "bg-text-interactive-base opacity-50 pointer-events-none": saving(),
              }}
              onClick={save}
              disabled={saving()}
            >
              <Show when={!saving()} fallback={<Spinner class="size-3 inline-block" />}>
                {isEdit() ? "Save" : "Create"}
              </Show>
            </button>
          </div>
        </Panel.HeaderRow>
      </Panel.Header>

      <div class="flex-1 min-h-0 overflow-y-auto px-5 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div class="flex flex-col gap-0">
          <input
            type="text"
            class="w-full bg-transparent text-15-medium text-text-strong outline-none py-3 placeholder:text-text-weaker/50"
            placeholder="Add title"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />

          <div class="flex items-start gap-2.5 py-2.5">
            <div class="shrink-0 mt-0.5 text-icon-weak">
              <Icon name="sparkles" size="small" />
            </div>
            <textarea
              class="flex-1 bg-transparent text-12-regular text-text-base outline-none resize-none min-h-14 placeholder:text-text-weaker/50"
              placeholder="Agent prompt (what should the agent do?)"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              rows={2}
            />
          </div>

          <Divider />

          {/* Schedule */}
          <div class="flex items-center gap-2.5 py-2.5">
            <div class="shrink-0 text-icon-weak">
              <Icon name="clock" size="small" />
            </div>
            <Show
              when={hasSchedule()}
              fallback={
                <button
                  type="button"
                  class="text-12-regular text-text-interactive-base hover:text-text-interactive-base-hover transition-colors"
                  onClick={() => {
                    setHasSchedule(true)
                    setDate(startOfDay(Date.now()))
                    const now = new Date()
                    const m5 = Math.ceil(now.getMinutes() / 5) * 5
                    setHour(m5 >= 60 ? (now.getHours() + 1) % 24 : now.getHours())
                    setMinute(m5 % 60)
                  }}
                >
                  Add time
                </button>
              }
            >
              <div class="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
                <DatePicker value={date()} onChange={setDate} />
                <TimePicker hour={hour()} minute={minute()} onHourChange={setHour} onMinuteChange={setMinute} />
                <button
                  type="button"
                  class="ml-auto text-icon-weak hover:text-text-diff-delete-base transition-colors"
                  onClick={() => {
                    setHasSchedule(false)
                    setRepeatMode("off")
                  }}
                >
                  <Icon name="x" size="small" />
                </button>
              </div>
            </Show>
          </div>

          {/* Repeat */}
          <Show when={hasSchedule()}>
            <div class="flex items-center gap-2.5 py-2.5">
              <div class="shrink-0 text-icon-weak">
                <Icon name="repeat" size="small" />
              </div>
              <RepeatControl
                mode={repeatMode()}
                count={intervalCount()}
                unit={intervalUnit()}
                onModeChange={setRepeatMode}
                onCountChange={setIntervalCount}
                onUnitChange={setIntervalUnit}
              />
            </div>
            <Show when={repeatMode() === "custom"}>
              <div class="pl-8 pb-2 flex flex-col gap-1.5">
                <input
                  type="text"
                  class="w-full bg-transparent text-12-regular text-text-base outline-none px-2.5 py-1.5 rounded-lg border border-border-weaker-base/50 focus:border-border-interactive-base"
                  placeholder="Cron expression, e.g. 0 9 * * 1-5"
                  value={customCron()}
                  onInput={(e) => setCustomCron(e.currentTarget.value)}
                />
                <input
                  type="text"
                  class="w-full bg-transparent text-11-regular text-text-weaker outline-none px-2.5 py-1 rounded-lg border border-border-weaker-base/50 focus:border-border-interactive-base"
                  placeholder="Timezone (e.g. Asia/Shanghai)"
                  value={cronTz()}
                  onInput={(e) => setCronTz(e.currentTarget.value)}
                />
              </div>
            </Show>
          </Show>

          <Divider />

          <Show
            when={showDesc()}
            fallback={<ExpandRow icon="file-text" label="Add description" onClick={() => setShowDesc(true)} />}
          >
            <div class="flex items-start gap-2.5 py-2.5">
              <div class="shrink-0 mt-0.5 text-icon-weak">
                <Icon name="file-text" size="small" />
              </div>
              <textarea
                class="flex-1 bg-transparent text-12-regular text-text-base outline-none resize-none min-h-14 placeholder:text-text-weaker/50"
                placeholder="Description..."
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                rows={2}
              />
            </div>
          </Show>

          <Show
            when={showTags()}
            fallback={<ExpandRow icon="tag" label="Add tags" onClick={() => setShowTags(true)} />}
          >
            <div class="flex items-center gap-2.5 py-2.5">
              <div class="shrink-0 text-icon-weak">
                <Icon name="tag" size="small" />
              </div>
              <input
                type="text"
                class="flex-1 bg-transparent text-12-regular text-text-base outline-none placeholder:text-text-weaker/50"
                placeholder="tag1, tag2, ..."
                value={tagsText()}
                onInput={(e) => setTagsText(e.currentTarget.value)}
              />
            </div>
          </Show>

          <Divider />

          <button
            type="button"
            class="flex items-center gap-2.5 py-2.5 w-full text-left"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <div class="shrink-0 text-icon-weak">
              <Icon name="settings" size="small" />
            </div>
            <span class="text-12-regular text-text-weak flex-1">Advanced</span>
            <div class="shrink-0 text-icon-weak">
              <Icon name={showAdvanced() ? "chevron-up" : "chevron-down"} size="small" />
            </div>
          </button>

          <Show when={showAdvanced()}>
            <div class="pl-8 pb-3 flex flex-col gap-3">
              <Show when={!isEdit() && scopes().length > 1}>
                <div class="flex flex-col gap-1">
                  <span class="text-11-medium text-text-weaker">Scope</span>
                  <ScopePicker
                    scopes={scopes()}
                    currentScopeID={currentScopeID()}
                    value={selectedScopeID() || currentScopeID()}
                    onChange={setSelectedScopeID}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={error()}>
        <div class="shrink-0 mx-5 mb-3 text-12-regular text-text-diff-delete-base bg-text-diff-delete-base/10 border border-text-diff-delete-base/20 rounded-lg px-3 py-2">
          {error()}
        </div>
      </Show>
    </>
  )
}

// ---------------------------------------------------------------------------
// DatePicker
// ---------------------------------------------------------------------------

function DatePicker(props: { value: number; onChange: (ts: number) => void }) {
  const [open, setOpen] = createSignal(false)
  const [displayMonth, setDisplayMonth] = createSignal(props.value)
  let containerRef: HTMLDivElement | undefined

  createEffect(
    on(
      () => props.value,
      (v) => setDisplayMonth(v),
    ),
  )

  createEffect(() => {
    if (!open()) return
    function onClick(e: MouseEvent) {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    onCleanup(() => document.removeEventListener("mousedown", onClick))
  })

  const today = createMemo(() => startOfDay(Date.now()))
  const selected = createMemo(() => startOfDay(props.value))
  const currentMonth = createMemo(() => new Date(displayMonth()).getMonth())

  const gridDays = createMemo(() => {
    const d = new Date(displayMonth())
    const first = new Date(d.getFullYear(), d.getMonth(), 1)
    first.setHours(0, 0, 0, 0)
    const gridStart = startOfWeek(first.getTime())
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    last.setHours(0, 0, 0, 0)
    const gridEnd = addDays(startOfWeek(last.getTime()), 7)
    const days: number[] = []
    let cur = gridStart
    while (cur < gridEnd) {
      days.push(cur)
      cur = addDays(cur, 1)
    }
    return days
  })

  function cellClass(ts: number): string {
    if (ts === selected()) return "bg-surface-interactive-solid text-text-on-interactive-base"
    if (ts === today()) return "bg-surface-interactive-selected-weak text-text-interactive-base"
    const inMonth = new Date(ts).getMonth() === currentMonth()
    return inMonth ? "text-text-base hover:bg-surface-raised-base-hover" : "text-text-weaker/40"
  }

  return (
    <div ref={containerRef} class="relative">
      <button
        type="button"
        class="px-2.5 py-1 rounded-lg text-12-medium text-text-base border border-border-weaker-base/50 hover:border-border-interactive-base transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {formatDate(props.value)}
      </button>

      <Show when={open()}>
        <div
          class="absolute top-full left-0 mt-1 z-50 bg-surface-base border border-border-weaker-base rounded-xl shadow-lg p-3 select-none"
          style={{ width: "224px" }}
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-12-medium text-text-strong">
              {MONTH_NAMES_SHORT[new Date(displayMonth()).getMonth()]} {new Date(displayMonth()).getFullYear()}
            </span>
            <div class="flex items-center gap-0.5">
              <NavBtn onClick={() => setDisplayMonth((m) => addMonths(m, -1))}>{"‹"}</NavBtn>
              <NavBtn onClick={() => setDisplayMonth((m) => addMonths(m, 1))}>{"›"}</NavBtn>
            </div>
          </div>

          <div class="grid grid-cols-7 mb-0.5">
            <For each={DAY_LABELS_MINI}>
              {(label) => (
                <div class="w-7 h-6 flex items-center justify-center text-10-medium text-text-weaker">{label}</div>
              )}
            </For>
          </div>
          <div class="grid grid-cols-7">
            <For each={gridDays()}>
              {(ts) => (
                <button
                  type="button"
                  class={`w-7 h-7 flex items-center justify-center rounded-full text-[11px] leading-none transition-colors ${cellClass(ts)}`}
                  onClick={() => {
                    props.onChange(ts)
                    setOpen(false)
                  }}
                >
                  {new Date(ts).getDate()}
                </button>
              )}
            </For>
          </div>

          <button
            type="button"
            class="mt-2 text-11-medium text-text-interactive-base hover:text-text-interactive-base-hover"
            onClick={() => {
              props.onChange(today())
              setDisplayMonth(today())
              setOpen(false)
            }}
          >
            Today
          </button>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TimePicker — split hour + minute columns
// ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)

function TimePicker(props: {
  hour: number
  minute: number
  onHourChange: (h: number) => void
  onMinuteChange: (m: number) => void
}) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined
  let hourListRef: HTMLDivElement | undefined
  let minuteListRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!open()) return
    function onClick(e: MouseEvent) {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    onCleanup(() => document.removeEventListener("mousedown", onClick))
  })

  createEffect(() => {
    if (!open()) return
    requestAnimationFrame(() => {
      scrollToSelected(hourListRef, props.hour)
      scrollToSelected(minuteListRef, MINUTES.indexOf(props.minute))
    })
  })

  function scrollToSelected(listEl: HTMLDivElement | undefined, idx: number) {
    if (!listEl || idx < 0) return
    const child = listEl.children[idx] as HTMLElement | undefined
    if (child) child.scrollIntoView({ block: "center" })
  }

  return (
    <div ref={containerRef} class="relative">
      <button
        type="button"
        class="px-2.5 py-1 rounded-lg text-12-medium text-text-base border border-border-weaker-base/50 hover:border-border-interactive-base transition-colors tabular-nums"
        onClick={() => setOpen((v) => !v)}
      >
        {pad2(props.hour)}:{pad2(props.minute)}
      </button>

      <Show when={open()}>
        <div
          class="absolute top-full left-0 mt-1 z-50 bg-surface-base border border-border-weaker-base rounded-xl shadow-lg flex overflow-hidden"
          style={{ height: "200px" }}
        >
          <div
            ref={hourListRef}
            class="overflow-y-auto [scrollbar-width:thin] w-14 border-r border-border-weaker-base/50"
          >
            <For each={HOURS}>
              {(h) => (
                <button
                  type="button"
                  classList={{
                    "w-full px-2 py-1.5 text-12-regular text-center transition-colors tabular-nums": true,
                    "bg-surface-interactive-selected-weak text-text-interactive-base": h === props.hour,
                    "text-text-base hover:bg-surface-raised-base-hover": h !== props.hour,
                  }}
                  onClick={() => props.onHourChange(h)}
                >
                  {pad2(h)}
                </button>
              )}
            </For>
          </div>
          <div ref={minuteListRef} class="overflow-y-auto [scrollbar-width:thin] w-14">
            <For each={MINUTES}>
              {(m) => (
                <button
                  type="button"
                  classList={{
                    "w-full px-2 py-1.5 text-12-regular text-center transition-colors tabular-nums": true,
                    "bg-surface-interactive-selected-weak text-text-interactive-base": m === props.minute,
                    "text-text-base hover:bg-surface-raised-base-hover": m !== props.minute,
                  }}
                  onClick={() => props.onMinuteChange(m)}
                >
                  {pad2(m)}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RepeatControl — "every N unit" inline input
// ---------------------------------------------------------------------------

function RepeatControl(props: {
  mode: RepeatMode
  count: number
  unit: IntervalUnit
  onModeChange: (m: RepeatMode) => void
  onCountChange: (n: number) => void
  onUnitChange: (u: IntervalUnit) => void
}) {
  const [unitOpen, setUnitOpen] = createSignal(false)
  let unitRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!unitOpen()) return
    function onClick(e: MouseEvent) {
      if (unitRef && !unitRef.contains(e.target as Node)) setUnitOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    onCleanup(() => document.removeEventListener("mousedown", onClick))
  })

  return (
    <div class="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
      <Show when={props.mode === "interval"}>
        <span class="text-12-regular text-text-base">Every</span>
        <input
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          class="w-12 bg-transparent text-12-medium text-text-strong text-center outline-none px-1 py-0.5 rounded-lg border border-border-weaker-base/50 focus:border-border-interactive-base tabular-nums"
          value={props.count}
          onInput={(e) => {
            const raw = e.currentTarget.value.replace(/[^0-9]/g, "")
            e.currentTarget.value = raw
            const v = parseInt(raw, 10)
            if (!isNaN(v) && v >= 1 && v <= 999) props.onCountChange(v)
          }}
          onBlur={(e) => {
            const raw = e.currentTarget.value.replace(/[^0-9]/g, "")
            const v = parseInt(raw, 10)
            if (isNaN(v) || v < 1) {
              props.onCountChange(1)
              e.currentTarget.value = "1"
            }
          }}
        />
        <div ref={unitRef} class="relative">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 rounded-lg text-12-regular text-text-base border border-border-weaker-base/50 hover:border-border-interactive-base transition-colors"
            onClick={() => setUnitOpen((v) => !v)}
          >
            {props.unit}
            <Icon name="chevron-down" size="small" class="text-icon-weak" />
          </button>
          <Show when={unitOpen()}>
            <div class="absolute top-full left-0 mt-1 z-50 bg-surface-base border border-border-weaker-base rounded-xl shadow-lg overflow-hidden min-w-28">
              <For each={INTERVAL_UNITS}>
                {(u) => (
                  <button
                    type="button"
                    classList={{
                      "w-full px-3 py-1.5 text-12-regular text-left flex items-center justify-between transition-colors": true,
                      "text-text-interactive-base": u.value === props.unit,
                      "text-text-base hover:bg-surface-raised-base-hover": u.value !== props.unit,
                    }}
                    onClick={() => {
                      props.onUnitChange(u.value)
                      setUnitOpen(false)
                    }}
                  >
                    <span>{u.label}</span>
                    <Show when={u.value === props.unit}>
                      <Icon name="check" size="small" class="text-text-interactive-base" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.mode === "off"}>
        <span class="text-12-regular text-text-weaker">Does not repeat</span>
      </Show>

      <Show when={props.mode === "custom"}>
        <span class="text-12-regular text-text-weaker">Custom cron</span>
      </Show>

      <div class="ml-auto flex items-center gap-0.5">
        <ModeChip active={props.mode === "off"} onClick={() => props.onModeChange("off")}>
          Off
        </ModeChip>
        <ModeChip active={props.mode === "interval"} onClick={() => props.onModeChange("interval")}>
          Interval
        </ModeChip>
        <ModeChip active={props.mode === "custom"} onClick={() => props.onModeChange("custom")}>
          Cron
        </ModeChip>
      </div>
    </div>
  )
}

function ModeChip(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      classList={{
        "px-1.5 py-0.5 rounded-md text-10-medium transition-colors": true,
        "bg-surface-interactive-selected-weak text-text-interactive-base": props.active,
        "text-text-weaker hover:text-text-weak": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// ScopePicker — custom dropdown replacing native <select>
// ---------------------------------------------------------------------------

function ScopePicker(props: {
  scopes: { id: string; name?: string; worktree: string }[]
  currentScopeID: string
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!open()) return
    function onClick(e: MouseEvent) {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    onCleanup(() => document.removeEventListener("mousedown", onClick))
  })

  function scopeLabel(s: { id: string; name?: string; worktree: string }): string {
    const name = s.name || getFilename(s.worktree) || s.id
    return s.id === props.currentScopeID ? `${name} (current)` : name
  }

  const activeLabel = createMemo(() => {
    const s = props.scopes.find((s) => s.id === props.value)
    return s ? scopeLabel(s) : "Select scope"
  })

  return (
    <div ref={containerRef} class="relative">
      <button
        type="button"
        class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-12-regular text-text-base border border-border-weaker-base/50 hover:border-border-interactive-base transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span class="truncate">{activeLabel()}</span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak" />
      </button>

      <Show when={open()}>
        <div class="absolute top-full left-0 right-0 mt-1 z-50 bg-surface-base border border-border-weaker-base rounded-xl shadow-lg overflow-hidden max-h-48 overflow-y-auto [scrollbar-width:thin]">
          <For each={props.scopes}>
            {(scope) => (
              <button
                type="button"
                classList={{
                  "w-full px-3 py-2 text-12-regular text-left flex items-center justify-between transition-colors": true,
                  "text-text-interactive-base": scope.id === props.value,
                  "text-text-base hover:bg-surface-raised-base-hover": scope.id !== props.value,
                }}
                onClick={() => {
                  props.onChange(scope.id)
                  setOpen(false)
                }}
              >
                <span class="truncate">{scopeLabel(scope)}</span>
                <Show when={scope.id === props.value}>
                  <Icon name="check" size="small" class="shrink-0 text-text-interactive-base" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Divider() {
  return <div class="border-b border-border-weaker-base/50 my-0.5" />
}

function ExpandRow(props: { icon: "file-text" | "tag"; label: string; onClick: () => void }) {
  return (
    <button type="button" class="flex items-center gap-2.5 py-2.5 w-full text-left" onClick={props.onClick}>
      <div class="shrink-0 text-icon-weak">
        <Icon name={props.icon} size="small" />
      </div>
      <span class="text-12-regular text-text-interactive-base">{props.label}</span>
    </button>
  )
}

function NavBtn(props: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      class="w-6 h-6 flex items-center justify-center rounded text-text-weaker hover:text-text-weak hover:bg-surface-raised-base-hover transition-colors"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
