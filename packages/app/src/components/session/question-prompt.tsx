import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { QuestionRequest, QuestionAnswer } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Countdown } from "@ericsanchezok/synergy-ui/countdown"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import "./question-prompt.css"

export interface QuestionPromptProps {
  request: QuestionRequest
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const sdk = useSDK()
  const [collapsed, setCollapsed] = createSignal(false)

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1))

  const countdownSeconds = () => props.request.timeout as number | undefined

  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: -1,
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
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })
  const currentStepLabel = createMemo(() => {
    if (confirm()) return "Review"
    return question()?.header || `Question ${store.tab + 1}`
  })

  function submit() {
    if (!single() && !allAnswered()) return
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    sdk.client.question.reply({
      requestID: props.request.id,
      answers,
    })
  }

  function reject() {
    sdk.client.question.reject({
      requestID: props.request.id,
    })
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      sdk.client.question.reply({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", -1)
    setStore("otherOpen", false)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
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

      const existing = store.answers[store.tab] ?? []
      const next = [...existing]
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
    setStore("selected", -1)
    setStore("otherOpen", false)
  }

  return (
    <section class="question-prompt-shell" aria-label="Question awaiting your input">
      <Show when={collapsed()}>
        <button type="button" class="question-prompt-collapsed" onClick={() => setCollapsed(false)}>
          <span class="question-prompt-collapsed-main">
            <Icon name={getSemanticIcon("navigation.expand")} size="small" class="question-prompt-muted-icon" />
            <span class="question-prompt-collapsed-title">{currentStepLabel()}</span>
          </span>
          <span class="question-prompt-collapsed-meta">
            <Show when={countdownSeconds() != null}>
              <Countdown seconds={countdownSeconds()!} active={true} />
            </Show>
            <span>Open</span>
          </span>
        </button>
      </Show>

      <Show when={!collapsed()}>
        <div class="question-prompt-expanded">
          <header class="question-prompt-header">
            <div class="question-prompt-heading">
              <div class="question-prompt-kicker">Needs your input</div>
              <div class="question-prompt-title">{currentStepLabel()}</div>
            </div>
            <div class="question-prompt-header-actions">
              <Show when={!single()}>
                <span class="question-prompt-step-count">
                  {Math.min(store.tab + 1, questions().length)} / {questions().length}
                </span>
              </Show>
              <Show when={countdownSeconds() != null}>
                <Countdown seconds={countdownSeconds()!} active={true} />
              </Show>
              <Button variant="ghost" size="small" onClick={reject} class="question-prompt-skip" title="Skip question">
                Skip
              </Button>
              <button
                type="button"
                class="question-prompt-collapse-button"
                onClick={() => setCollapsed(true)}
                title="Collapse"
              >
                <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
              </button>
            </div>
          </header>

          <Show when={!single()}>
            <nav class="question-prompt-steps" aria-label="Question steps">
              <For each={questions()}>
                {(q, index) => {
                  const isActive = () => index() === store.tab
                  const isAnswered = () => (store.answers[index()]?.length ?? 0) > 0
                  return (
                    <button
                      type="button"
                      class="question-prompt-step"
                      classList={{
                        "is-active": isActive(),
                        "is-answered": isAnswered(),
                      }}
                      onClick={() => goToTab(index())}
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
                classList={{
                  "is-active": confirm(),
                  "is-answered": allAnswered(),
                }}
                onClick={() => goToTab(questions().length)}
              >
                <span>Review</span>
              </button>
            </nav>
          </Show>

          <div class="question-prompt-content">
            <Show when={!confirm()}>
              <div class="question-prompt-question">
                <Markdown text={question()?.question + (multi() ? " *(select all that apply)*" : "")} />
              </div>

              <div class="question-prompt-options">
                <For each={options()}>
                  {(opt) => {
                    const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                    return (
                      <button
                        type="button"
                        class="question-prompt-option"
                        classList={{
                          "is-picked": picked(),
                        }}
                        onClick={() => (multi() ? toggle(opt.label) : pick(opt.label))}
                      >
                        <span class="question-prompt-option-mark">
                          <Show when={picked()}>
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
                        <span class="question-prompt-option-label">Other answer</span>
                        <span class="question-prompt-option-description">Type a different answer</span>
                      </span>
                    </button>
                  }
                >
                  <div class="question-prompt-other">
                    <div class="question-prompt-other-label">
                      <span>Other answer</span>
                      <Show when={customPicked()}>
                        <Icon name={getSemanticIcon("state.success")} size="small" />
                      </Show>
                    </div>
                    <div class="question-prompt-other-row">
                      <TextField
                        placeholder="Type your own answer..."
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
                        {multi() ? "Add" : "Submit"}
                      </Button>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={confirm() && !single()}>
              <div class="question-prompt-review">
                <div class="question-prompt-review-title">Review your answers</div>
                <div class="question-prompt-review-list">
                  <For each={questions()}>
                    {(q, index) => {
                      const value = () => store.answers[index()]?.join(", ") ?? ""
                      const answered = () => Boolean(value())
                      return (
                        <button
                          type="button"
                          class="question-prompt-review-row"
                          classList={{
                            "is-missing": !answered(),
                          }}
                          onClick={() => goToTab(index())}
                        >
                          <span class="question-prompt-review-label">{q.header}</span>
                          <span class="question-prompt-review-value">{answered() ? value() : "Not answered"}</span>
                          <span class="question-prompt-review-edit">Edit</span>
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
                    Previous
                  </Button>
                </Show>
                <Show when={!confirm()}>
                  <Button
                    variant="secondary"
                    size="large"
                    onClick={() => goToTab(store.tab + 1)}
                    disabled={!currentAnswered()}
                  >
                    Next
                  </Button>
                </Show>
                <Show when={confirm()}>
                  <Button variant="primary" size="large" onClick={submit} disabled={!allAnswered()}>
                    Submit
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
