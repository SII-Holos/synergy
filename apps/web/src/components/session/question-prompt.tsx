import { createMemo, For, Show } from "solid-js"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Countdown } from "@ericsanchezok/synergy-ui/countdown"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { useSessionDecision } from "@/context/session-decision"
import { questionAnswers, questionCountdown, questionOptionShortcutIndex } from "./question-prompt-model"
import { requestSubmissionLocked } from "./request-submission"
import "./question-prompt.css"

const copy = {
  other: { id: "session.question.customAnswer", message: "Other answer" },
  supplement: { id: "session.question.supplement", message: "Additional context (optional)" },
  placeholder: { id: "session.question.answerPlaceholder", message: "Write your answer…" },
  previous: { id: "session.question.previous", message: "Previous" },
  next: { id: "session.question.next", message: "Next" },
  send: { id: "session.question.send", message: "Send" },
  sending: { id: "session.decision.submitting", message: "Submitting…" },
  step: { id: "session.question.step", message: "Question {index}/{count}" },
  directAnswer: { id: "session.question.directAnswer", message: "Answer: {option}. {description}" },
}

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const decisions = useSessionDecision()
  const { i18n } = useLocale()
  const state = () => decisions.state(decisions.key("question", props.request))
  const locked = () => !decisions.draftsReady() || requestSubmissionLocked(state())
  const draft = createMemo(() => decisions.draft(props.request))
  const question = createMemo(() => props.request.questions[draft().step])
  const direct = () => props.request.questions.length === 1 && !question()?.multiple
  const answers = createMemo(() => questionAnswers(props.request, draft()))
  const answered = () => (answers()[draft().step]?.length ?? 0) > 0
  const last = () => draft().step === props.request.questions.length - 1
  const clock = createMemo(() => questionCountdown(props.request))
  const fieldName = () => "question-" + props.request.id + "-" + draft().step
  let root: HTMLDivElement | undefined

  const select = (label: string) => {
    if (locked()) return
    decisions.updateDraft(props.request, (previous) => {
      const selections = [...previous.selections]
      const source = [...previous.source]
      if (question()?.multiple) {
        const chosen = selections[previous.step] ?? []
        selections[previous.step] = chosen.includes(label)
          ? chosen.filter((item) => item !== label)
          : [...chosen, label]
      } else {
        selections[previous.step] = [label]
        source[previous.step] = "option"
      }
      return { ...previous, selections, source }
    })
    if (direct()) void decisions.respondQuestion(props.request, [[label]])
  }
  const customSource = () =>
    decisions.updateDraft(props.request, (previous) => {
      const source = [...previous.source]
      source[previous.step] = "custom"
      return { ...previous, source }
    })
  const advance = () => {
    if (locked()) return
    if (direct()) {
      const answer = draft().custom[0]?.trim()
      if (!answer) return
      customSource()
      void decisions.respondQuestion(props.request, [[answer]])
      return
    }
    if (!answered()) return
    if (!last()) {
      decisions.updateDraft(props.request, (previous) => ({ ...previous, step: previous.step + 1 }))
      return
    }
    const values = answers()
    if (values.every((answer) => answer.length > 0)) void decisions.respondQuestion(props.request, values)
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || locked()) return
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      advance()
      return
    }
    const target = event.target instanceof HTMLElement ? event.target : undefined
    const index = questionOptionShortcutIndex({
      key: event.key,
      optionCount: question()?.options.length ?? 0,
      scopeActive: !!root?.contains(target ?? null),
      modified: event.ctrlKey || event.metaKey || event.altKey || event.shiftKey,
      editable: !!target?.closest('input, textarea, [contenteditable="true"]'),
    })
    if (index === undefined) return
    event.preventDefault()
    select(question()!.options[index].label)
  }

  return (
    <div ref={root} class="decision-content question-prompt" onKeyDown={keyDown}>
      <div
        class="decision-body"
        role={!direct() && !question()?.multiple ? "radiogroup" : undefined}
        aria-label={question()?.question}
      >
        <p class="question-text">{question()?.question}</p>
        <div class="question-meta">
          <Show when={props.request.questions.length > 1}>
            <span>
              {i18n._({ ...copy.step, values: { index: draft().step + 1, count: props.request.questions.length } })}
            </span>
          </Show>
          <Show when={clock()}>
            {(value) => <Countdown seconds={value().seconds} startedAt={value().startedAt} active />}
          </Show>
        </div>
        <div
          class="question-options"
          role={direct() || question()?.multiple ? "group" : undefined}
          aria-label={question()?.question}
        >
          <For each={question()?.options}>
            {(option) => {
              const selected = () =>
                draft().selections[draft().step]?.includes(option.label) &&
                (question()?.multiple || draft().source[draft().step] === "option")
              const contents = () => (
                <span class="question-option-text">
                  <span class="question-option-label">{option.label}</span>
                  <Show when={option.description}>
                    <span class="question-option-description">{option.description}</span>
                  </Show>
                </span>
              )
              return (
                <Show
                  when={direct()}
                  fallback={
                    <label class="question-option" data-selected={selected() ? "true" : undefined}>
                      <input
                        type={question()?.multiple ? "checkbox" : "radio"}
                        name={fieldName()}
                        checked={!!selected()}
                        disabled={locked()}
                        onChange={() => select(option.label)}
                      />
                      {contents()}
                    </label>
                  }
                >
                  <button
                    type="button"
                    class="question-option"
                    aria-label={i18n._({
                      ...copy.directAnswer,
                      values: { option: option.label, description: option.description },
                    })}
                    disabled={locked()}
                    data-selected={selected() ? "true" : undefined}
                    onClick={() => select(option.label)}
                  >
                    {contents()}
                    <Icon name={getSemanticIcon("prompt.submit")} size="small" />
                  </button>
                </Show>
              )
            }}
          </For>
        </div>
        <Show when={!direct() && !question()?.multiple}>
          <label class="question-custom-source">
            <input
              type="radio"
              name={fieldName()}
              checked={draft().source[draft().step] === "custom"}
              disabled={locked()}
              onChange={customSource}
            />
            {i18n._(copy.other)}
          </label>
        </Show>
        <TextField
          multiline
          label={i18n._(question()?.multiple ? copy.supplement : copy.other)}
          hideLabel={!direct() && !question()?.multiple}
          value={draft().custom[draft().step] ?? ""}
          placeholder={i18n._(copy.placeholder)}
          disabled={locked()}
          onChange={(value) =>
            decisions.updateDraft(props.request, (previous) => {
              const custom = [...previous.custom]
              const source = [...previous.source]
              custom[previous.step] = value
              if (!question()?.multiple) source[previous.step] = "custom"
              return { ...previous, custom, source }
            })
          }
        />
      </div>
      <div class="decision-footer">
        <Show when={draft().step > 0}>
          <Button
            variant="ghost"
            disabled={locked()}
            onClick={() =>
              decisions.updateDraft(props.request, (previous) => ({ ...previous, step: previous.step - 1 }))
            }
          >
            {i18n._(copy.previous)}
          </Button>
        </Show>
        <Button
          variant="primary"
          disabled={locked() || (direct() ? !draft().custom[0]?.trim() : !answered())}
          aria-busy={state().status === "pending"}
          onClick={advance}
        >
          {i18n._(state().status === "pending" ? copy.sending : last() ? copy.send : copy.next)}
        </Button>
      </div>
    </div>
  )
}
