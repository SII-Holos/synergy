import { calendarKeyDate } from "./calendar-navigation"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { requestErrorMessage } from "@/utils/error"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import type { AgendaItem, AgendaTrigger, AgendaCreateInput, AgendaPatchInput } from "@ericsanchezok/synergy-sdk/client"
import { AppPanel } from "@/components/app-panel"
import {
  startOfDay,
  addDays,
  addMonths,
  startOfWeek,
  getMonthNamesShort,
  getDayLabelsMini,
  formatLocaleDate,
} from "./date"
import { useLocale, type IntlFormatter } from "@/context/locale"
import { A } from "./agenda-i18n"

// ---------------------------------------------------------------------------
// Repeat — "every N unit" model
// ---------------------------------------------------------------------------

type RepeatMode = "off" | "interval" | "custom"
type IntervalUnit = "minutes" | "hours" | "days" | "weeks"

const INTERVAL_SHORTS: Record<IntervalUnit, string> = {
  minutes: "m",
  hours: "h",
  days: "d",
  weeks: "w",
}

function unitToShort(unit: IntervalUnit): string {
  return INTERVAL_SHORTS[unit]
}

function shortToUnit(s: string): IntervalUnit {
  for (const [unit, short] of Object.entries(INTERVAL_SHORTS)) {
    if (s.endsWith(short)) return unit as IntervalUnit
  }
  return "days"
}

function parseIntervalString(s: string): { count: number; unit: IntervalUnit } {
  const match = s.match(/^(\d+)(m|h|d|w)$/)
  if (!match) return { count: 1, unit: "days" }
  return { count: parseInt(match[1], 10), unit: shortToUnit(match[2]) }
}

function nextFiveMinuteTime(now = new Date()): Date {
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5)
  return d
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
  const now = nextFiveMinuteTime()
  const defaults: ScheduleState = {
    hasSchedule: false,
    date: startOfDay(now.getTime()),
    hour: now.getHours(),
    minute: now.getMinutes(),
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

/**
 * Triggers the schedule form cannot represent (session, webhook, watch, or
 * anything beyond the first at/every/cron). Edit saves preserve these so the
 * form never silently deletes triggers it cannot render.
 */
function unrepresentedTriggers(triggers: AgendaTrigger[]): AgendaTrigger[] {
  if (!triggers || triggers.length === 0) return []
  const [first] = triggers
  if (first.type === "at" || first.type === "every" || first.type === "cron") return triggers.slice(1)
  return triggers
}

// ---------------------------------------------------------------------------

function formatDate(ts: number, fmt: IntlFormatter): string {
  return formatLocaleDate(ts, fmt)
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

// ---------------------------------------------------------------------------
// AgendaForm
// ---------------------------------------------------------------------------

export function AgendaFormDialog(props: { directory: string; item?: AgendaItem; onClose: () => void }) {
  const { i18n } = useLocale()
  let requestClose = props.onClose
  return (
    <Dialog
      size="wide"
      class="app-panel-detail-dialog agenda-form-dialog"
      title={i18n._(props.item ? A.editAgenda : A.newAgenda)}
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        requestClose()
      }}
      action={
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          aria-label={i18n._({ id: "ui.dialog.close", message: "Close dialog" })}
          onClick={() => requestClose()}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <AgendaForm
        directory={props.directory}
        item={props.item}
        presentation="dialog"
        onBack={props.onClose}
        registerDismiss={(dismiss) => {
          requestClose = dismiss ?? props.onClose
        }}
      />
    </Dialog>
  )
}

export function AgendaForm(props: {
  directory: string
  item?: AgendaItem
  onBack: () => void
  presentation?: "panel" | "dialog"
  registerDismiss?: (dismiss: (() => void) | undefined) => void
}) {
  const confirm = useConfirm()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const isEdit = () => !!props.item
  const isDialog = () => props.presentation === "dialog"

  const parsed = parseTriggersToSchedule(props.item?.triggers ?? [])

  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const [title, setTitle] = createSignal(props.item?.title ?? "")
  const [prompt, setPrompt] = createSignal(props.item?.prompt ?? "")
  const [description, setDescription] = createSignal(props.item?.description ?? "")
  const [tagsText, setTagsText] = createSignal((props.item?.tags ?? []).join(", "))
  const [selectedScopeID, setSelectedScopeID] = createSignal("")

  const [hasSchedule, setHasSchedule] = createSignal(isEdit() ? parsed.hasSchedule : true)
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

  const titleRequiredMsg = createMemo(() => _(A.formTitleRequired))

  createEffect(() => {
    if (title().trim() && error() === titleRequiredMsg()) setError("")
  })

  const canSubmit = createMemo(() => title().trim().length > 0 && !saving())

  const scopes = createMemo(() => [{ id: "home", name: _(A.formScopeHome), local: null }, ...globalSync.data.scope])

  const currentScopeID = createMemo(() => {
    const dir = props.directory
    if (!dir) return ""
    const [store] = globalSync.ensureScopeState(dir)
    return store.scopeID
  })

  const snapshot = () =>
    JSON.stringify([
      title(),
      prompt(),
      description(),
      tagsText(),
      selectedScopeID(),
      hasSchedule(),
      date(),
      hour(),
      minute(),
      repeatMode(),
      intervalCount(),
      intervalUnit(),
      customCron(),
      cronTz(),
    ])
  const initialSnapshot = snapshot()
  async function requestDismiss() {
    if (saving()) return
    if (snapshot() !== initialSnapshot) {
      const discard = await confirm.ask({
        title: { id: "app.agenda.form.discardTitle", message: "Discard changes?" },
        description: {
          id: "app.agenda.form.discardDescription",
          message: "Your changes to this agenda have not been saved.",
        },
        confirmLabel: { id: "app.agenda.form.discardChanges", message: "Discard changes" },
        cancelLabel: { id: "app.agenda.form.keepEditing", message: "Keep editing" },
        tone: "neutral",
      })
      if (!discard) return
    }
    props.onBack()
  }
  props.registerDismiss?.(() => void requestDismiss())
  onCleanup(() => props.registerDismiss?.(undefined))

  async function save() {
    if (!canSubmit()) return
    const t = title().trim()
    if (!t) {
      setError(titleRequiredMsg())
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
    const preserved = unrepresentedTriggers(props.item?.triggers ?? [])

    try {
      if (isEdit()) {
        const patch: AgendaPatchInput = {
          title: t,
          description: description().trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          triggers: [...preserved, ...triggers],
          prompt: promptValue || undefined,
        }
        await sdk.client.agenda.update(
          { id: props.item!.id, scopeID: props.directory, agendaPatchInput: patch },
          { throwOnError: true },
        )
      } else {
        const input: AgendaCreateInput = {
          title: t,
          description: description().trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          triggers: triggers.length > 0 ? triggers : undefined,
          prompt: promptValue,
          createdBy: "user",
        }
        await sdk.client.agenda.create(
          { scopeID: selectedScopeID() || currentScopeID() || props.directory, agendaCreateInput: input },
          { throwOnError: true },
        )
      }
      props.onBack()
    } catch (err: unknown) {
      setError(requestErrorMessage(err, _(A.formSaveFailed)))
    }
    setSaving(false)
  }

  return (
    <>
      <Show when={!isDialog()}>
        <AppPanel.Header>
          <AppPanel.HeaderRow>
            <AppPanel.Action
              icon={getSemanticIcon("navigation.back")}
              title={_(A.formBack)}
              onClick={() => void requestDismiss()}
            />
            <AppPanel.Title>{isEdit() ? _(A.editAgenda) : _(A.newAgenda)}</AppPanel.Title>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="px-2.5 py-1 rounded-full app-panel-caption font-medium text-text-weak hover:bg-surface-raised-base-hover transition-colors"
                onClick={() => void requestDismiss()}
              >
                {_(A.formCancel)}
              </button>
              <button
                type="button"
                classList={{
                  "px-3 py-1 rounded-full app-panel-caption font-medium transition-colors": true,
                  "bg-text-strong text-background-base hover:bg-text-base": canSubmit(),
                  "bg-surface-raised-base text-text-weaker ring-1 ring-inset ring-border-base/35 cursor-not-allowed":
                    !canSubmit(),
                }}
                onClick={save}
                disabled={!canSubmit()}
              >
                <Show when={!saving()} fallback={<Spinner class="size-3 inline-block" />}>
                  {isEdit() ? _(A.formSave) : _(A.formCreate)}
                </Show>
              </button>
            </div>
          </AppPanel.HeaderRow>
        </AppPanel.Header>
      </Show>

      <AppPanel.Body padding={false} class={isDialog() ? "!px-6 !pb-3" : "!px-5"}>
        <div
          classList={{
            "agenda-form-surface flex flex-col": true,
            "gap-4": isDialog(),
            "gap-0 rounded-xl bg-surface-inset-base p-3": !isDialog(),
          }}
        >
          <Field label={_(A.formTitle)}>
            <div class="agenda-control-surface px-3.5 py-3">
              <input
                type="text"
                autofocus
                class="w-full bg-transparent app-panel-section-title text-text-strong outline-none py-1 placeholder:text-text-weak"
                aria-label={_(A.formTitle)}
                placeholder={_(A.formTitlePlaceholder)}
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
            </div>
          </Field>

          <Field label={_(A.formPromptLabel)}>
            <div class="agenda-control-surface px-3.5 py-3">
              <textarea
                class="w-full bg-transparent app-panel-copy text-text-base outline-none resize-none min-h-24 placeholder:text-text-weak"
                aria-label={_(A.formPromptLabel)}
                placeholder={_(A.formPromptDetailedPlaceholder)}
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                rows={4}
              />
            </div>
          </Field>

          <Field label={_(A.formSchedule)}>
            <div class="flex items-center">
              <Show
                when={hasSchedule()}
                fallback={
                  <button
                    type="button"
                    class="agenda-form-time-action app-panel-control text-text-strong hover:text-text-base transition-colors"
                    onClick={() => {
                      setHasSchedule(true)
                      setDate(startOfDay(Date.now()))
                      const now = new Date()
                      const m5 = Math.ceil(now.getMinutes() / 5) * 5
                      setHour(m5 >= 60 ? (now.getHours() + 1) % 24 : now.getHours())
                      setMinute(m5 % 60)
                    }}
                  >
                    {_(A.formAddTime)}
                  </button>
                }
              >
                <div class="agenda-control-surface agenda-schedule-control flex-1 min-w-0 flex items-center gap-2.5 flex-wrap px-3.5 py-2.5">
                  <DatePicker value={date()} onChange={setDate} />
                  <TimePicker hour={hour()} minute={minute()} onHourChange={setHour} onMinuteChange={setMinute} />
                  <button
                    type="button"
                    class="agenda-form-time-action agenda-form-time-remove ml-auto flex items-center justify-center rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-inset-base-hover transition-colors"
                    aria-label={_(A.formRemoveTime)}
                    onClick={() => {
                      setHasSchedule(false)
                      setRepeatMode("off")
                    }}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </div>
              </Show>
            </div>
          </Field>

          <Show when={isEdit() && unrepresentedTriggers(props.item?.triggers ?? []).length > 0}>
            <p class="app-panel-caption text-text-weaker -mt-1">{_(A.formUnsupportedTriggers)}</p>
          </Show>
          {/* Repeat */}
          <Show when={hasSchedule()}>
            <Field label={_(A.formRepeat)}>
              <div class="agenda-control-surface min-w-0 px-3 py-2.5">
                <RepeatControl
                  mode={repeatMode()}
                  count={intervalCount()}
                  unit={intervalUnit()}
                  onModeChange={setRepeatMode}
                  onCountChange={setIntervalCount}
                  onUnitChange={setIntervalUnit}
                  i18n={i18n}
                />
              </div>
            </Field>
            <Show when={repeatMode() === "custom"}>
              <div class="flex flex-col gap-1.5">
                <input
                  type="text"
                  class="agenda-control-surface w-full app-panel-caption text-text-base outline-none px-3 py-2"
                  placeholder={_(A.formCronDetailedPlaceholder)}
                  value={customCron()}
                  onInput={(e) => setCustomCron(e.currentTarget.value)}
                />
                <input
                  type="text"
                  class="agenda-control-surface w-full app-panel-caption text-text-weaker outline-none px-3 py-2"
                  placeholder={_(A.formTzDetailedPlaceholder)}
                  value={cronTz()}
                  onInput={(e) => setCronTz(e.currentTarget.value)}
                />
              </div>
            </Show>
          </Show>

          <Divider />

          <Show
            when={showDesc()}
            fallback={<ExpandRow label={_(A.formAddDescription)} onClick={() => setShowDesc(true)} />}
          >
            <Field label={_(A.formDescription)}>
              <div class="agenda-control-surface px-3 py-2.5">
                <textarea
                  class="w-full bg-transparent app-panel-caption text-text-base outline-none resize-none min-h-20 placeholder:text-text-weak"
                  aria-label={_(A.formDescription)}
                  placeholder={_(A.formDescriptionPlaceholder)}
                  value={description()}
                  onInput={(e) => setDescription(e.currentTarget.value)}
                  rows={3}
                />
              </div>
            </Field>
          </Show>

          <Show when={showTags()} fallback={<ExpandRow label={_(A.formAddTags)} onClick={() => setShowTags(true)} />}>
            <Field label={_(A.formTags)}>
              <div class="agenda-control-surface px-3 py-2.5">
                <input
                  type="text"
                  class="w-full bg-transparent app-panel-caption text-text-base outline-none placeholder:text-text-weak"
                  aria-label={_(A.formTags)}
                  placeholder={_(A.formTagsPlaceholder)}
                  value={tagsText()}
                  onInput={(e) => setTagsText(e.currentTarget.value)}
                />
              </div>
            </Field>
          </Show>

          <Divider />

          <button
            type="button"
            class="agenda-control-surface flex items-center gap-3 px-3.5 py-3 w-full text-left"
            aria-expanded={showAdvanced()}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="app-panel-caption font-medium text-text-strong">{_(A.formAdvancedTitle)}</span>
              <span class="app-panel-caption text-text-weaker truncate">{_(A.formAdvancedSubtitle)}</span>
            </span>
            <div class="shrink-0 text-icon-weak-base">
              <Icon name={showAdvanced() ? "chevron-up" : "chevron-down"} size="small" />
            </div>
          </button>

          <Show when={showAdvanced()}>
            <div class="pb-3 flex flex-col gap-3">
              <Show when={!isEdit() && scopes().length > 1}>
                <div class="flex flex-col gap-1">
                  <span class="app-panel-caption font-medium text-text-weaker">{_(A.formScopeLabel)}</span>
                  <ScopePicker
                    scopes={scopes()}
                    currentScopeID={currentScopeID()}
                    value={selectedScopeID() || currentScopeID()}
                    onChange={setSelectedScopeID}
                    i18n={i18n}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </AppPanel.Body>

      <Show when={error()}>
        <div class="shrink-0 mx-5 mb-3 app-panel-caption text-text-diff-delete-base bg-text-diff-delete-base/10 border border-text-diff-delete-base/18 rounded-[1rem] px-3 py-2.5 shadow-[inset_0_1px_0_var(--border-weak-base)]">
          {error()}
        </div>
      </Show>

      <Show when={isDialog()}>
        <AppPanel.Footer class="!px-6 !py-4 justify-end">
          <button
            type="button"
            class="h-9 rounded-lg px-4 app-panel-caption font-medium text-text-base ring-1 ring-inset ring-border-base/50 transition-colors hover:bg-surface-raised-base-hover"
            onClick={() => void requestDismiss()}
          >
            {_(A.formCancel)}
          </button>
          <button
            type="button"
            classList={{
              "h-9 rounded-lg px-4 app-panel-caption font-medium transition-colors ring-1 ring-inset": true,
              "bg-text-strong text-background-base hover:bg-text-base ring-border-weaker-selected": canSubmit(),
              "bg-surface-raised-base text-text-weaker ring-border-base/35 cursor-not-allowed": !canSubmit(),
            }}
            onClick={save}
            disabled={!canSubmit()}
          >
            <Show when={!saving()} fallback={<Spinner class="size-3 inline-block" />}>
              {isEdit() ? _(A.formSave) : _(A.formCreate)}
            </Show>
          </button>
        </AppPanel.Footer>
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
  const [focusedDate, setFocusedDate] = createSignal(startOfDay(props.value))
  const { i18n, fmt } = useLocale()
  const monthNames = createMemo(() => getMonthNamesShort(fmt))
  const dayLabels = createMemo(() => getDayLabelsMini(fmt))

  createEffect(
    on(
      () => props.value,
      (v) => {
        setDisplayMonth(v)
        setFocusedDate(startOfDay(v))
      },
    ),
  )

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
    if (ts === selected()) return "bg-text-strong text-background-base"
    if (ts === today()) return "bg-surface-raised-base text-text-strong ring-1 ring-inset ring-border-base/55"
    const inMonth = new Date(ts).getMonth() === currentMonth()
    return inMonth ? "text-text-base hover:bg-surface-raised-base-hover" : "text-text-weak"
  }

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      title={i18n._(A.formSchedule)}
      variant="menu"
      class="agenda-picker-overlay"
      triggerAs={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          class="agenda-picker-trigger agenda-schedule-trigger app-panel-control"
          data-open={open() ? "true" : undefined}
        >
          {formatDate(props.value, fmt)}
        </button>
      )}
    >
      <div class="agenda-date-popover select-none">
        <div class="flex items-center justify-between mb-3">
          <span class="app-panel-row-title text-text-strong">
            {monthNames()[new Date(displayMonth()).getMonth()]} {new Date(displayMonth()).getFullYear()}
          </span>
          <div class="flex items-center gap-1">
            <NavBtn
              label={i18n._({ id: "app.agenda.calendar.previousMonth", message: "Previous month" })}
              onClick={() => {
                setDisplayMonth((m) => addMonths(m, -1))
                setFocusedDate(startOfDay(displayMonth()))
              }}
            >
              {"‹"}
            </NavBtn>
            <NavBtn
              label={i18n._({ id: "app.agenda.calendar.nextMonth", message: "Next month" })}
              onClick={() => {
                setDisplayMonth((m) => addMonths(m, 1))
                setFocusedDate(startOfDay(displayMonth()))
              }}
            >
              {"›"}
            </NavBtn>
          </div>
        </div>

        <div class="grid grid-cols-7 mb-1">
          <For each={dayLabels()}>
            {(label) => (
              <div class="agenda-date-cell flex items-center justify-center app-panel-caption font-medium text-text-weaker">
                {label}
              </div>
            )}
          </For>
        </div>
        <div class="grid grid-cols-7">
          <For each={gridDays()}>
            {(ts) => (
              <button
                type="button"
                aria-label={fmt.date(ts, { dateStyle: "full" })}
                aria-pressed={ts === selected()}
                aria-current={ts === today() ? "date" : undefined}
                tabindex={ts === focusedDate() ? 0 : -1}
                data-picker-date={ts}
                onKeyDown={(event) => {
                  const next = calendarKeyDate(ts, event.key, event.shiftKey)
                  if (next === undefined) return
                  event.preventDefault()
                  setFocusedDate(next)
                  setDisplayMonth(next)
                  requestAnimationFrame(() =>
                    document.querySelector<HTMLButtonElement>(`[data-picker-date="${next}"]`)?.focus(),
                  )
                }}
                class={`agenda-date-cell flex items-center justify-center app-panel-caption font-medium leading-none transition-colors ${cellClass(ts)}`}
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
          class="mt-3 h-8 rounded-lg px-2.5 app-panel-caption font-medium text-text-strong transition-colors hover:bg-surface-raised-base-hover"
          onClick={() => {
            props.onChange(today())
            setDisplayMonth(today())
            setOpen(false)
          }}
        >
          {i18n._(A.calendarToday)}
        </button>
      </div>
    </Popover>
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
  const { i18n } = useLocale()
  let hourListRef: HTMLDivElement | undefined
  let minuteListRef: HTMLDivElement | undefined

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
    <Popover
      open={open()}
      onOpenChange={setOpen}
      title={i18n._(A.formSchedule)}
      variant="menu"
      class="agenda-picker-overlay"
      triggerAs={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          class="agenda-picker-trigger agenda-schedule-trigger app-panel-control tabular-nums"
          data-open={open() ? "true" : undefined}
        >
          {pad2(props.hour)}:{pad2(props.minute)}
        </button>
      )}
    >
      <div class="agenda-time-popover">
        <div ref={hourListRef} class="agenda-time-column border-r border-border-weaker-base/35">
          <For each={HOURS}>
            {(h) => (
              <button
                type="button"
                classList={{
                  "agenda-time-option app-panel-copy text-center transition-colors tabular-nums": true,
                  "bg-text-strong text-background-base": h === props.hour,
                  "text-text-base hover:bg-surface-raised-base-hover": h !== props.hour,
                }}
                onClick={() => props.onHourChange(h)}
              >
                {pad2(h)}
              </button>
            )}
          </For>
        </div>
        <div ref={minuteListRef} class="agenda-time-column">
          <For each={MINUTES}>
            {(m) => (
              <button
                type="button"
                classList={{
                  "agenda-time-option app-panel-copy text-center transition-colors tabular-nums": true,
                  "bg-text-strong text-background-base": m === props.minute,
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
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// RepeatControl — "every N unit" inline input
// ---------------------------------------------------------------------------

function intervalUnitLabel(unit: IntervalUnit, _: (d: { id: string; message: string }) => string): string {
  if (unit === "minutes") return _(A.intervalMinutes)
  if (unit === "hours") return _(A.intervalHours)
  if (unit === "days") return _(A.intervalDays)
  return _(A.intervalWeeks)
}

function RepeatControl(props: {
  mode: RepeatMode
  count: number
  unit: IntervalUnit
  onModeChange: (m: RepeatMode) => void
  onCountChange: (n: number) => void
  onUnitChange: (u: IntervalUnit) => void
  i18n: import("@lingui/core").I18n
}) {
  const [unitOpen, setUnitOpen] = createSignal(false)
  const _ = (d: { id: string; message: string }) => props.i18n._(d)
  let unitRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!unitOpen()) return
    function onClick(e: MouseEvent) {
      if (unitRef && !unitRef.contains(e.target as Node)) setUnitOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    onCleanup(() => document.removeEventListener("mousedown", onClick))
  })

  const units = (): { value: IntervalUnit; label: string }[] => [
    { value: "minutes", label: intervalUnitLabel("minutes", _) },
    { value: "hours", label: intervalUnitLabel("hours", _) },
    { value: "days", label: intervalUnitLabel("days", _) },
    { value: "weeks", label: intervalUnitLabel("weeks", _) },
  ]

  return (
    <div class="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
      <Show when={props.mode === "interval"}>
        <span class="app-panel-caption text-text-base">{_(A.formRepeatEvery)}</span>
        <input
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          class="agenda-picker-trigger h-8 w-14 px-2 app-panel-caption font-medium text-text-strong text-center outline-none tabular-nums"
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
            class="agenda-picker-trigger gap-1 px-3 py-1 app-panel-caption"
            data-open={unitOpen() ? "true" : undefined}
            onClick={() => setUnitOpen((v) => !v)}
          >
            {intervalUnitLabel(props.unit, _)}
            <Icon name="chevron-down" size="small" class="text-icon-weak-base" />
          </button>
          <Show when={unitOpen()}>
            <div class="agenda-picker-popover agenda-menu-popover">
              <For each={units()}>
                {(u) => (
                  <button
                    type="button"
                    classList={{
                      "w-full px-3 py-1.5 app-panel-caption text-left flex items-center justify-between transition-colors": true,
                      "text-text-strong bg-surface-raised-base": u.value === props.unit,
                      "text-text-base hover:bg-surface-raised-base-hover": u.value !== props.unit,
                    }}
                    onClick={() => {
                      props.onUnitChange(u.value)
                      setUnitOpen(false)
                    }}
                  >
                    <span>{u.label}</span>
                    <Show when={u.value === props.unit}>
                      <Icon name="check" size="small" class="text-text-strong" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.mode === "off"}>
        <span class="app-panel-caption text-text-weaker">{_(A.formRepeatOff)}</span>
      </Show>

      <Show when={props.mode === "custom"}>
        <span class="app-panel-caption text-text-weaker">{_(A.formRepeatCustom)}</span>
      </Show>

      <div class="ml-auto flex items-center gap-0.5">
        <ModeChip active={props.mode === "off"} onClick={() => props.onModeChange("off")}>
          {_(A.formRepeatOffChip)}
        </ModeChip>
        <ModeChip active={props.mode === "interval"} onClick={() => props.onModeChange("interval")}>
          {_(A.formIntervalChip)}
        </ModeChip>
        <ModeChip active={props.mode === "custom"} onClick={() => props.onModeChange("custom")}>
          {_(A.formCronChip)}
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
        "px-2 py-0.5 rounded-full app-panel-caption font-medium transition-colors": true,
        "bg-text-strong text-background-base ring-1 ring-inset ring-border-weaker-selected": props.active,
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

function scopePickerLabel(
  s: { id: string; name?: string; local?: { worktree: string } | null },
  currentScopeID: string,
  _: (d: { id: string; message: string }, values?: Record<string, unknown>) => string,
): string {
  const name = s.name || getFilename(s.local?.worktree ?? "") || s.id
  if (s.id === currentScopeID) return _(A.formScopeCurrent, { name })
  return name
}

function ScopePicker(props: {
  scopes: { id: string; name?: string; local?: { worktree: string } | null }[]
  currentScopeID: string
  value: string
  onChange: (id: string) => void
  i18n: import("@lingui/core").I18n
}) {
  const _ = (descriptor: { id: string; message: string }, values?: Record<string, unknown>) =>
    props.i18n._(values ? { ...descriptor, values } : descriptor)
  return (
    <MenuField
      value={props.value}
      ariaLabel={_(A.formScopeLabel)}
      triggerClass="agenda-control-surface w-full"
      options={props.scopes.map((scope) => ({
        value: scope.id,
        label: scopePickerLabel(scope, props.currentScopeID, _),
      }))}
      onChange={props.onChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2">
      <span class="px-0.5 app-panel-caption font-medium text-text-strong">{props.label}</span>
      {props.children}
    </div>
  )
}

function Divider() {
  return <div class="agenda-soft-divider" />
}

function ExpandRow(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="flex items-center py-2.5 px-0.5 w-full text-left rounded-[0.95rem] hover:bg-surface-raised-base-hover transition-colors"
      onClick={props.onClick}
    >
      <span class="app-panel-caption text-text-strong">{props.label}</span>
    </button>
  )
}

function NavBtn(props: { onClick: () => void; children: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class="w-8 h-8 flex items-center justify-center rounded-full app-panel-section-title text-text-weaker hover:text-text-weak hover:bg-surface-raised-base-hover transition-colors"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
