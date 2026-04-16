import { createMemo, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "./icon"
import "./session-resonance-popover.css"

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
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const memories = createMemo(() => (props.context?.memory ? parseMemories(props.context.memory) : []))
  const experiences = createMemo(() => (props.context?.experience ? parseExperiences(props.context.experience) : []))
  const hasContent = createMemo(() => memories().length > 0 || experiences().length > 0)
  const totalCount = createMemo(() => memories().length + experiences().length)

  async function handleCopy() {
    if (!props.context) return
    const parts: string[] = []
    if (props.context.memory) parts.push(props.context.memory)
    if (props.context.experience) parts.push(props.context.experience)
    await navigator.clipboard.writeText(parts.join("\n\n"))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={6}>
      <Popover.Trigger
        as="button"
        data-component="resonance-trigger"
        data-empty={!hasContent()}
        title="Resonance"
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <Icon name="brain" size="small" />
        <Show when={hasContent()}>
          <span data-slot="resonance-trigger-count">{totalCount()}</span>
        </Show>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-component="resonance-popover" onClick={(e: MouseEvent) => e.stopPropagation()}>
          <div data-slot="resonance-header">
            <span data-slot="resonance-title">Resonance</span>
            <div data-slot="resonance-header-actions">
              <Show when={hasContent()}>
                <button data-slot="resonance-copy" title="Copy all" onClick={handleCopy}>
                  <Icon name={copied() ? "check" : "copy"} size="small" />
                </button>
              </Show>
              <Popover.CloseButton data-slot="resonance-close">
                <Icon name="x" size="small" />
              </Popover.CloseButton>
            </div>
          </div>
          <div data-slot="resonance-body">
            <Show when={hasContent()} fallback={<div data-slot="resonance-empty">No resonance for this turn</div>}>
              <Show when={memories().length > 0}>
                <div data-slot="resonance-section">
                  <div data-slot="resonance-section-label">Memories</div>
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
                  <div data-slot="resonance-section-label">Experiences</div>
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
