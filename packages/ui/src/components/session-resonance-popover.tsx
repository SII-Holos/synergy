import { createMemo, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { useLingui } from "@lingui/solid"
import { createCopyController } from "./clipboard"
import { Icon } from "./icon"
import "./session-resonance-popover.css"
import { getSemanticIcon } from "./semantic-icon"
import { RESONANCE_DESC } from "./tool-title-descriptors"

export interface InjectedContext {
  memory?: string
  experience?: string
}

interface MemoryEntry {
  title: string
  category: string
  similarity?: string
}

interface ExperienceEntry {
  intent: string
  similarity: string
  qValue: string
}

function parseMemories(xml: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  const re = /<entry\s+title="([^"]*)"(?:\s+category="([^"]*)")?(?:\s+similarity="([^"]*)")?[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    entries.push({
      title: match[1],
      category: match[2] ?? "",
      similarity: match[3],
    })
  }
  return entries
}

function parseExperiences(xml: string): ExperienceEntry[] {
  const entries: ExperienceEntry[] = []
  const expRe =
    /<experience\s+sim="([^"]*)"(?:\s+q="([^"]*)")?[^>]*>[\s\S]*?<intent>([\s\S]*?)<\/intent>[\s\S]*?<\/experience>/g
  let match: RegExpExecArray | null
  while ((match = expRe.exec(xml))) {
    entries.push({
      similarity: match[1],
      qValue: match[2] ?? "0",
      intent: match[3].trim(),
    })
  }
  return entries
}

function tone(value: number): "pos" | "neg" | "neutral" {
  if (value > 0) return "pos"
  if (value < 0) return "neg"
  return "neutral"
}

export function ResonancePopover(props: { context?: InjectedContext }) {
  const { _ } = useLingui()
  const [open, setOpen] = createSignal(false)

  const memories = createMemo(() => (props.context?.memory ? parseMemories(props.context.memory) : []))
  const experiences = createMemo(() => (props.context?.experience ? parseExperiences(props.context.experience) : []))
  const hasContent = createMemo(() => memories().length > 0 || experiences().length > 0)
  const totalCount = createMemo(() => memories().length + experiences().length)

  const copyText = () => {
    if (!props.context) return
    const parts: string[] = []
    if (props.context.memory) parts.push(props.context.memory)
    if (props.context.experience) parts.push(props.context.experience)
    return parts.join("\n\n")
  }
  const copy = createCopyController({
    text: copyText,
    copyLabel: _(RESONANCE_DESC.copyAll),
    failureDescription: _(RESONANCE_DESC.copyFail),
  })

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={6}>
      <Popover.Trigger
        as="button"
        data-component="resonance-trigger"
        data-empty={!hasContent()}
        title={_(RESONANCE_DESC.title)}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <Icon name={getSemanticIcon("memory.main")} size="small" />
        <Show when={hasContent()}>
          <span data-slot="resonance-trigger-count">{totalCount()}</span>
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-component="resonance-popover" onClick={(e: MouseEvent) => e.stopPropagation()}>
          <div data-slot="resonance-header">
            <span data-slot="resonance-title">{_(RESONANCE_DESC.title)}</span>
            <div data-slot="resonance-header-actions">
              <Show when={hasContent()}>
                <button
                  data-slot="resonance-copy"
                  data-copy-state={copy.state()}
                  title={copy.tooltip()}
                  disabled={copy.disabled()}
                  onClick={() => void copy.copy()}
                >
                  <Icon name={copy.icon()} size="small" />
                </button>
              </Show>
              <Popover.CloseButton data-slot="resonance-close">
                <Icon name={getSemanticIcon("action.close")} size="small" />
              </Popover.CloseButton>
            </div>
          </div>
          <div data-slot="resonance-body">
            <Show when={hasContent()} fallback={<div data-slot="resonance-empty">{_(RESONANCE_DESC.empty)}</div>}>
              <Show when={memories().length > 0}>
                <div data-slot="resonance-section">
                  <div data-slot="resonance-section-label">{_(RESONANCE_DESC.memories)}</div>
                  <For each={memories()}>
                    {(memory) => (
                      <div data-slot="resonance-item">
                        <span data-slot="resonance-item-text">{memory.title}</span>
                        <span data-slot="resonance-item-meta">
                          {memory.category}
                          <Show when={memory.similarity}>
                            {" · "}
                            {(parseFloat(memory.similarity!) * 100).toFixed(0)}%
                          </Show>
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={experiences().length > 0}>
                <div data-slot="resonance-section">
                  <div data-slot="resonance-section-label">{_(RESONANCE_DESC.experiences)}</div>
                  <For each={experiences()}>
                    {(exp) => {
                      const sim = parseFloat(exp.similarity)
                      const q = parseFloat(exp.qValue)
                      return (
                        <div data-slot="resonance-item">
                          <span data-slot="resonance-item-text">{exp.intent}</span>
                          <span data-slot="resonance-item-meta">
                            <span data-tone={sim >= 0.7 ? "pos" : sim >= 0.5 ? "neutral" : "neg"}>
                              {(sim * 100).toFixed(0)}%
                            </span>
                            {" · "}
                            <span data-tone={tone(q)}>
                              Q{q >= 0 ? "+" : ""}
                              {q.toFixed(1)}
                            </span>
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
