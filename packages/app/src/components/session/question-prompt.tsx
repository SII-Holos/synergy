import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { QuestionRequest, QuestionAnswer } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Countdown } from "@ericsanchezok/synergy-ui/countdown"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { questionOptionShortcutIndex } from "./question-prompt-model"
import "./question-prompt.css"

export interface QuestionPromptProps {
  request: QuestionRequest
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const sdk = useSDK()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const [collapsed, setCollapsed] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  let root: HTMLElement | undefined

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const countdownSeconds = () => props.request.timeout as number | undefined

  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    otherOpen: false,
  })

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const multi = createMemo(() => question()?.multiple === true)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const currentAnswer = createMemo(() => store.answers[store.tab] ?? [])
  const currentAnswered = createMemo(() => currentAnswer().length > 0)
  const allAnswered = createMemo(() => questions().every((_, i) => (store.answers[i]?.length ?? 0) > 0))
  const customPicked = createMemo(() => {
    const v = input()
    return v ? (store.answers[store.tab]?.includes(v) ?? false) : false
  })
  const questionID = createMemo(() => `${props.request.id}-question-${store.tab}`)
  const choiceHintID = createMemo(() => `${props.request.id}-choice-hint-${store.tab}`)
  const currentStepLabel = createMemo(() => {
    if (confirm()) return _(S.questionReview)
    return question()?.header || i18n._({ ...S.questionStepLabel, values: { index: store.tab + 1 } })
  })

  function submit() {
    if (!single() && !allAnswered()) return
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    sdk.client.question.reply({ requestID: props.request.id, answers })
  }
  function reject() {
    sdk.client.question.reject({ requestID: props.request.id })
  }

  function pick(answer: string, custom = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      sdk.client.question.reply({ requestID: props.request.id, answers: [[answer]] })
      return
    }
    setStore("tab", store.tab + 1)
    setStore("otherOpen", false)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const idx = next.indexOf(answer)
    if (idx === -1) next.push(answer)
    else next.splice(idx, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function handleCustomSubmit() {
    const text = input().trim()
    if (!text) return
    if (multi()) {
      const inputs = [...store.custom]
      inputs[store.tab] = text
      setStore("custom", inputs)
      const exist = store.answers[store.tab] ?? []
      const next = [...exist]
      if (!next.includes(text)) next.push(text)
      const answers = [...store.answers]
      answers[store.tab] = next
      setStore("answers", answers)
      return
    }
    pick(text, true)
  }

  function goToTab(index: number) {
    setStore("tab", index)
    setStore("otherOpen", false)
  }

  onMount(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target
      const editable =
        target instanceof Element &&
        Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
      const activeElement = document.activeElement
      const scopeActive =
        activeElement == null ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        Boolean(root?.contains(activeElement))
      const index = questionOptionShortcutIndex({
        key: event.key,
        optionCount: options().length,
        scopeActive,
        modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
        editable,
      })
      if (index == null || collapsed() || confirm() || store.otherOpen || menuOpen()) return
      const option = options()[index]
      if (!option) return
      event.preventDefault()
      if (multi()) toggle(option.label)
      else pick(option.label)
    }
    document.addEventListener("keydown", handleShortcut)
    onCleanup(() => document.removeEventListener("keydown", handleShortcut))
  })

  return (
    <section ref={root} class="question-prompt-shell" aria-label={_(S.questionAria)}>
      <Show when={collapsed()}>
        <button
          type="button"
          class="question-prompt-collapsed"
          aria-expanded="false"
          onClick={() => setCollapsed(false)}
        >
          <span class="question-prompt-collapsed-main">
            <Icon name={getSemanticIcon("navigation.expand")} size="small" class="question-prompt-muted-icon" />
            <span class="question-prompt-collapsed-title">{currentStepLabel()}</span>
          </span>
          <span class="question-prompt-collapsed-meta">
            <Show when={countdownSeconds() != null}>
              <Countdown seconds={countdownSeconds()!} active={true} />
            </Show>
            <span>{_(S.questionOpen)}</span>
          </span>
        </button>
      </Show>
      <Show when={!collapsed()}>
        <div class="question-prompt-expanded">
          <header class="question-prompt-meta">
            <div class="question-prompt-meta-summary">
              <span class="question-prompt-kicker">{_(S.questionNeedsInput)}</span>
              <span class="question-prompt-meta-separator" aria-hidden="true">
                ·
              </span>
              <span class="question-prompt-current-step">{currentStepLabel()}</span>
              <Show when={!single()}>
                <span class="question-prompt-meta-separator" aria-hidden="true">
                  ·
                </span>
                <span class="question-prompt-step-count">
                  {Math.min(store.tab + 1, questions().length)} / {questions().length}
                </span>
              </Show>
              <Show when={countdownSeconds() != null}>
                <span class="question-prompt-meta-separator" aria-hidden="true">
                  ·
                </span>
                <Countdown seconds={countdownSeconds()!} active={true} />
              </Show>
            </div>
            <div class="question-prompt-meta-actions">
              <Popover
                open={menuOpen()}
                onOpenChange={setMenuOpen}
                placement="bottom-end"
                class="question-prompt-menu-popover"
                trigger={
                  <button
                    type="button"
                    class="question-prompt-more-button"
                    aria-label={_(S.questionMoreActions)}
                    aria-expanded={menuOpen()}
                    aria-haspopup="menu"
                  >
                    <Icon name={getSemanticIcon("action.more")} size="small" />
                  </button>
                }
              >
                <div class="question-prompt-menu-list" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    class="question-prompt-menu-item question-prompt-skip"
                    title={_(S.questionSkipTitle)}
                    onClick={() => {
                      setMenuOpen(false)
                      reject()
                    }}
                  >
                    {_(S.questionSkip)}
                  </button>
                </div>
              </Popover>
              <button
                type="button"
                class="question-prompt-collapse-button"
                aria-expanded="true"
                onClick={() => setCollapsed(true)}
                title={_(S.questionCollapseTitle)}
              >
                <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
              </button>
            </div>
          </header>
          <Show when={!single()}>
            <nav class="question-prompt-steps" aria-label={_(S.questionStepsAria)}>
              <For each={questions()}>
                {(q, idx) => {
                  const isActive = () => idx() === store.tab
                  const isAnswered = () => (store.answers[idx()]?.length ?? 0) > 0
                  return (
                    <button
                      type="button"
                      class="question-prompt-step"
                      classList={{ "is-active": isActive(), "is-answered": isAnswered() }}
                      onClick={() => goToTab(idx())}
                    >
                      <span>{q.header}</span>
                      <Show when={isAnswered()}>
                        <Icon name={getSemanticIcon("state.success")} size="small" />
                      </Show>
                    </button>
                  )
                }}
              </For>
              <button
                type="button"
                class="question-prompt-step"
                classList={{ "is-active": confirm(), "is-answered": allAnswered() }}
                onClick={() => goToTab(questions().length)}
              >
                <span>{_(S.questionReview)}</span>
              </button>
            </nav>
          </Show>
          <div class="question-prompt-content">
            <Show when={!confirm()}>
              <div class="question-prompt-question" id={questionID()}>
                <Markdown text={question()?.question ?? ""} />
              </div>
              <div class="question-prompt-choice-hint" id={choiceHintID()}>
                {multi() ? _(S.questionMultiHint) : _(S.questionSingleHint)}
              </div>
              <div
                class="question-prompt-options"
                role={multi() ? "group" : "radiogroup"}
                aria-labelledby={questionID()}
                aria-describedby={choiceHintID()}
              >
                <For each={options()}>
                  {(opt, idx) => {
                    const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                    return (
                      <button
                        type="button"
                        role={multi() ? "checkbox" : "radio"}
                        aria-checked={picked()}
                        aria-keyshortcuts={idx() < 9 ? String(idx() + 1) : undefined}
                        class="question-prompt-option"
                        classList={{ "is-picked": picked() }}
                        onClick={() => (multi() ? toggle(opt.label) : pick(opt.label))}
                      >
                        <span class="question-prompt-option-mark question-prompt-option-shortcut" aria-hidden="true">
                          <Show when={picked()} fallback={<Show when={idx() < 9}>{idx() + 1}</Show>}>
                            <Icon name={getSemanticIcon("state.success")} size="small" />
                          </Show>
                        </span>
                        <span class="question-prompt-option-copy">
                          <span class="question-prompt-option-label">{opt.label}</span>
                          <span class="question-prompt-option-description">{opt.description}</span>
                        </span>
                      </button>
                    )
                  }}
                </For>
                <Show
                  when={store.otherOpen}
                  fallback={
                    <button
                      type="button"
                      class="question-prompt-option question-prompt-other-trigger"
                      onClick={() => setStore("otherOpen", true)}
                    >
                      <span class="question-prompt-option-mark question-prompt-other-mark">
                        <Icon name={getSemanticIcon("action.add")} size="small" />
                      </span>
                      <span class="question-prompt-option-copy">
                        <span class="question-prompt-option-label">{_(S.questionOtherAnswer)}</span>
                        <span class="question-prompt-option-description">{_(S.questionOtherDesc)}</span>
                      </span>
                    </button>
                  }
                >
                  <div class="question-prompt-other">
                    <div class="question-prompt-other-label">
                      <span>{_(S.questionOtherAnswer)}</span>
                      <Show when={customPicked()}>
                        <Icon name={getSemanticIcon("state.success")} size="small" />
                      </Show>
                    </div>
                    <div class="question-prompt-other-row">
                      <TextField
                        placeholder={_(S.questionCustomPlaceholder)}
                        value={input()}
                        onInput={(e: InputEvent & { currentTarget: HTMLInputElement }) => {
                          const inputs = [...store.custom]
                          inputs[store.tab] = e.currentTarget.value
                          setStore("custom", inputs)
                        }}
                        onKeyDown={(e: KeyboardEvent) => {
                          if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
                            e.preventDefault()
                            handleCustomSubmit()
                          }
                        }}
                        class="question-prompt-other-input"
                      />
                      <Button
                        variant="secondary"
                        size="large"
                        onClick={handleCustomSubmit}
                        disabled={!input().trim()}
                        class="question-prompt-other-button"
                      >
                        {multi() ? _(S.questionAdd) : _(S.questionSubmit)}
                      </Button>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={confirm() && !single()}>
              <div class="question-prompt-review">
                <div class="question-prompt-review-title">{_(S.questionReviewTitle)}</div>
                <div class="question-prompt-review-list">
                  <For each={questions()}>
                    {(q, idx) => {
                      const val = () => store.answers[idx()]?.join(", ") ?? ""
                      const answered = () => Boolean(val())
                      return (
                        <button
                          type="button"
                          class="question-prompt-review-row"
                          classList={{ "is-missing": !answered() }}
                          onClick={() => goToTab(idx())}
                        >
                          <span class="question-prompt-review-label">{q.header}</span>
                          <span class="question-prompt-review-value">
                            {answered() ? val() : _(S.questionNotAnswered)}
                          </span>
                          <span class="question-prompt-review-edit">{_(S.questionEdit)}</span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>
            </Show>
          </div>
          <Show when={!single()}>
            <footer class="question-prompt-footer">
              <div class="question-prompt-footer-actions">
                <Show when={store.tab > 0}>
                  <Button variant="ghost" size="large" onClick={() => goToTab(store.tab - 1)}>
                    {_(S.questionPrevious)}
                  </Button>
                </Show>
                <Show when={!confirm()}>
                  <Button
                    variant="secondary"
                    size="large"
                    onClick={() => goToTab(store.tab + 1)}
                    disabled={!currentAnswered()}
                  >
                    {_(S.questionNext)}
                  </Button>
                </Show>
                <Show when={confirm()}>
                  <Button variant="primary" size="large" onClick={submit} disabled={!allAnswered()}>
                    {_(S.questionSubmit)}
                  </Button>
                </Show>
              </div>
            </footer>
          </Show>
        </div>
      </Show>
    </section>
  )
}
