import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { QuestionRequest, QuestionAnswer } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Card } from "@ericsanchezok/synergy-ui/card"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Countdown } from "@ericsanchezok/synergy-ui/countdown"
import { useSDK } from "@/context/sdk"

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
  })

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const multi = createMemo(() => question()?.multiple === true)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
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
  }

  return (
    <Card variant="info" class="border-l-2 border-l-accent max-h-[min(60vh,480px)] flex flex-col overflow-hidden">
      {/* Collapsed bar */}
      <Show when={collapsed()}>
        <button
          class="flex items-center gap-2 px-4 py-3 w-full text-left hover:bg-surface-raised-base-hover transition-colors"
          onClick={() => setCollapsed(false)}
        >
          <Icon name="chevron-right" size="small" class="text-icon-base shrink-0" />
          <span class="text-text-strong text-14-medium truncate flex-1">
            {question()?.header || question()?.question || "Question"}
          </span>
          <Show when={countdownSeconds() != null}>
            <Countdown seconds={countdownSeconds()!} active={true} />
          </Show>
          <span class="text-text-weak text-12-regular shrink-0">Click to expand</span>
        </button>
      </Show>

      {/* Expanded content */}
      <Show when={!collapsed()}>
        <div class="flex flex-col gap-3 p-4 min-h-0">
          {/* Collapse button + Tabs for multiple questions */}
          <div class="flex items-center gap-2 shrink-0">
            <button
              class="flex items-center justify-center size-6 rounded hover:bg-surface-raised-base-hover transition-colors shrink-0"
              onClick={() => setCollapsed(true)}
              title="Collapse"
            >
              <Icon name="chevron-down" size="small" class="text-icon-base" />
            </button>
            <Show when={countdownSeconds() != null}>
              <Countdown seconds={countdownSeconds()!} active={true} />
            </Show>
            <Show when={!single()}>
              <div class="flex flex-row gap-2 flex-wrap">
                <For each={questions()}>
                  {(q, index) => {
                    const isActive = () => index() === store.tab
                    const isAnswered = () => (store.answers[index()]?.length ?? 0) > 0
                    return (
                      <button
                        class="px-3 py-1 rounded-md text-sm transition-colors"
                        classList={{
                          "bg-accent text-accent-foreground": isActive(),
                          "bg-surface-raised-base text-text-strong": !isActive() && isAnswered(),
                          "bg-surface-raised-base text-text-weak": !isActive() && !isAnswered(),
                        }}
                        onClick={() => goToTab(index())}
                      >
                        {q.header}
                      </button>
                    )
                  }}
                </For>
                <button
                  class="px-3 py-1 rounded-md text-sm transition-colors"
                  classList={{
                    "bg-accent text-accent-foreground": confirm(),
                    "bg-surface-raised-base text-text-weak": !confirm(),
                  }}
                  onClick={() => goToTab(questions().length)}
                >
                  Confirm
                </button>
              </div>
            </Show>
          </div>

          {/* Question content — scrollable */}
          <Show when={!confirm()}>
            <div class="flex flex-col gap-3 overflow-y-auto min-h-0 [scrollbar-width:thin]">
              <div class="text-text-strong text-14-medium shrink-0">
                <Markdown text={question()?.question + (multi() ? " *(select all that apply)*" : "")} />
              </div>

              {/* Options */}
              <div class="flex flex-col gap-2">
                <For each={options()}>
                  {(opt, i) => {
                    const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                    return (
                      <button
                        class="flex flex-col gap-1 p-3 rounded-lg text-left transition-colors bg-surface-raised-base hover:bg-surface-raised-base-hover"
                        classList={{
                          "ring-2 ring-accent": picked(),
                        }}
                        onClick={() => (multi() ? toggle(opt.label) : pick(opt.label))}
                      >
                        <div class="flex items-center gap-2">
                          <span class="text-text-strong text-14-medium">{opt.label}</span>
                          <Show when={picked()}>
                            <Icon name="check" size="small" class="text-success" />
                          </Show>
                        </div>
                        <span class="text-text-weak text-12-regular">{opt.description}</span>
                      </button>
                    )
                  }}
                </For>

                {/* Other option */}
                <div class="flex flex-col gap-2 p-3 rounded-lg bg-surface-raised-base">
                  <div class="flex items-center gap-2">
                    <span class="text-text-strong text-14-medium">Other</span>
                    <Show when={customPicked()}>
                      <Icon name="check" size="small" class="text-success" />
                    </Show>
                  </div>
                  <div class="flex gap-2">
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
                      class="flex-1"
                    />
                    <Button variant="secondary" size="small" onClick={handleCustomSubmit}>
                      {multi() ? "Add" : "Submit"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Show>

          {/* Confirm view — scrollable */}
          <Show when={confirm() && !single()}>
            <div class="flex flex-col gap-3 overflow-y-auto min-h-0 [scrollbar-width:thin]">
              <div class="text-text-strong text-14-medium">Review your answers</div>
              <div class="flex flex-col gap-2">
                <For each={questions()}>
                  {(q, index) => {
                    const value = () => store.answers[index()]?.join(", ") ?? ""
                    const answered = () => Boolean(value())
                    return (
                      <div class="flex gap-2 items-baseline">
                        <span class="text-text-weak text-12-regular">{q.header}:</span>
                        <span
                          class="text-14-regular"
                          classList={{
                            "text-text-strong": answered(),
                            "text-error": !answered(),
                          }}
                        >
                          {answered() ? value() : "(not answered)"}
                        </span>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>

          {/* Actions — always visible */}
          <div class="flex justify-between items-center pt-2 border-t border-border-base shrink-0">
            <Button variant="ghost" size="small" onClick={reject}>
              Dismiss
            </Button>
            <Show when={!single()}>
              <div class="flex gap-2">
                <Show when={store.tab > 0}>
                  <Button variant="ghost" size="small" onClick={() => goToTab(store.tab - 1)}>
                    Previous
                  </Button>
                </Show>
                <Show when={!confirm()}>
                  <Button variant="secondary" size="small" onClick={() => goToTab(store.tab + 1)}>
                    Next
                  </Button>
                </Show>
                <Show when={confirm()}>
                  <Button variant="primary" size="small" onClick={submit}>
                    Submit
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </Card>
  )
}
