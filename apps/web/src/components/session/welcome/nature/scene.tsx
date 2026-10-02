import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { resolveThemeColor, useTheme } from "@ericsanchezok/synergy-ui/theme"
import type { WelcomeSceneProps } from "../types"
import { createNature, natureCounts, type NatureTool } from "./model"
import type { NatureCommand, NatureFrame } from "./protocol"
import { drawNature } from "./draw"
import "./style.css"

const tools = [
  { id: "soil", label: { id: "welcome.nature.soil", message: "Build land" } },
  { id: "dig", label: { id: "welcome.nature.dig", message: "Dig a channel" } },
  { id: "water", label: { id: "welcome.nature.water", message: "Pour water" } },
  { id: "seed", label: { id: "welcome.nature.seed", message: "Plant a seed" } },
] as const

export default function NatureScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const theme = useTheme()
  let latest = props.memory.read(() => createNature(props.seed))
  const [tool, setTool] = createSignal<NatureTool>("dig")
  const [grown, setGrown] = createSignal(natureCounts(latest).grown)
  const [wind, setWind] = createSignal(latest.wind)
  const [lowGravity, setLowGravity] = createSignal(latest.lowGravity)
  const [fault, setFault] = createSignal(false)
  const [restart, setRestart] = createSignal(0)
  const [cursor, setCursor] = createSignal<{ x: number; y: number }>()
  let canvas!: HTMLCanvasElement
  let worker: Worker | undefined
  let generation = 0
  let painting = false
  let drawFrame: number | undefined
  const post = (message: NatureCommand) => worker?.postMessage(message)
  function draw() {
    if (!canvas) return
    const tokens = theme.tokens()
    drawNature(
      canvas,
      latest,
      {
        ground: resolveThemeColor(tokens, "chart-series-2"),
        edge: resolveThemeColor(tokens, "text-weak"),
        water: resolveThemeColor(tokens, "chart-series-1"),
        leaf: resolveThemeColor(tokens, "chart-series-3"),
        seed: resolveThemeColor(tokens, "text-base"),
        light: resolveThemeColor(tokens, "surface-raised-stronger-non-alpha"),
      },
      cursor(),
    )
  }
  createEffect(draw)
  function initialize() {
    if (drawFrame !== undefined) cancelAnimationFrame(drawFrame)
    drawFrame = undefined
    generation++
    post({ type: "init", generation, state: latest })
    post({ type: "active", generation, value: props.active() })
  }
  createEffect(() => {
    restart()
    const owned = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
    worker = owned
    setFault(false)
    owned.onmessage = ({ data }: MessageEvent<NatureFrame>) => {
      if (worker !== owned || data.generation !== generation) return
      latest = { ...data.state, wind: wind(), lowGravity: lowGravity() }
      props.memory.write(latest)
      setGrown(natureCounts(latest).grown)
      if (drawFrame !== undefined) cancelAnimationFrame(drawFrame)
      drawFrame = requestAnimationFrame(() => {
        drawFrame = undefined
        if (worker !== owned || data.generation !== generation) return
        draw()
        post({ type: "ack", generation: data.generation })
      })
    }
    owned.onerror = () => {
      if (worker === owned) {
        setFault(true)
        owned.terminate()
        worker = undefined
      }
    }
    untrack(initialize)
    onCleanup(() => {
      if (drawFrame !== undefined) cancelAnimationFrame(drawFrame)
      drawFrame = undefined
      owned.terminate()
      if (worker === owned) worker = undefined
    })
  })
  createEffect(() => post({ type: "active", generation, value: props.active() }))
  createEffect(() => {
    latest = { ...latest, wind: wind(), lowGravity: lowGravity() }
    props.memory.write(latest)
    post({ type: "settings", generation, wind: wind(), lowGravity: lowGravity() })
  })
  onMount(() => {
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)
    draw()
    onCleanup(() => resize.disconnect())
  })
  function point(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(latest.width - 1, ((event.clientX - bounds.left) / bounds.width) * latest.width)),
      y: Math.max(0, Math.min(latest.height - 2, ((event.clientY - bounds.top) / bounds.height) * latest.height)),
    }
  }
  function paint(x: number, y: number) {
    post({ type: "paint", generation, tool: tool(), x, y })
  }
  function pointer(event: PointerEvent) {
    const next = point(event)
    const previous = cursor()
    if (painting) {
      const steps = previous ? Math.min(40, Math.ceil(Math.hypot(next.x - previous.x, next.y - previous.y))) : 1
      for (let i = 1; i <= Math.max(1, steps); i++) {
        const fraction = i / Math.max(1, steps)
        paint(
          previous ? previous.x + (next.x - previous.x) * fraction : next.x,
          previous ? previous.y + (next.y - previous.y) * fraction : next.y,
        )
      }
    }
    setCursor(next)
  }
  function key(event: KeyboardEvent) {
    const current = cursor() ?? { x: 80, y: 40 }
    const move = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] }[event.key]
    if (move) {
      event.preventDefault()
      setCursor({
        x: Math.max(0, Math.min(latest.width - 1, current.x + move[0]!)),
        y: Math.max(0, Math.min(latest.height - 2, current.y + move[1]!)),
      })
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      paint(current.x, current.y)
    }
  }
  return (
    <section
      class="welcome-scene welcome-nature"
      data-playing={props.active() && !props.reducedMotion() ? "" : undefined}
    >
      <div class="welcome-scene-heading">
        <span class="welcome-eyebrow">{i18n._({ id: "welcome.nature.name", message: "A living landscape" })}</span>
        <h1>{i18n._({ id: "welcome.nature.title", message: "Where will a little water take you?" })}</h1>
        <p>
          {i18n._({
            id: "welcome.nature.hint",
            message: "Draw a channel through the hill. Guide water to the seeds, or shape a landscape of your own.",
          })}
        </p>
      </div>
      <div class="nature-landscape" data-welcome-visual>
        <svg viewBox="0 0 720 405" aria-hidden="true" class="nature-sky">
          <circle cx="566" cy="78" r="26" fill="var(--surface-interactive-selected)" />
          <path d="M0 240Q70 156 130 216T294 202Q370 152 445 218T720 198V405H0Z" fill="var(--surface-raised-base)" />
          <g class="nature-clouds" fill="none" stroke="var(--border-base)">
            <path d="M100 80h55m-38-7h49m202 33h52m-38-7h50" stroke-linecap="round" stroke-width="3" />
          </g>
        </svg>
        <canvas
          ref={canvas}
          class="nature-canvas"
          role="group"
          tabindex="0"
          aria-label={i18n._({
            id: "welcome.nature.board",
            message: "Landscape. Arrow keys move the brush; Enter or Space applies the selected tool.",
          })}
          onKeyDown={key}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            canvas.setPointerCapture(event.pointerId)
            painting = true
            setCursor(point(event))
            pointer(event)
          }}
          onPointerMove={pointer}
          onPointerUp={() => {
            painting = false
          }}
          onPointerCancel={() => {
            painting = false
          }}
          onLostPointerCapture={() => {
            painting = false
          }}
          onPointerLeave={() => {
            if (!painting) setCursor(undefined)
          }}
        />
      </div>
      <div
        class="welcome-tools"
        role="group"
        aria-label={i18n._({ id: "welcome.nature.tools", message: "Landscape tools" })}
      >
        <For each={tools}>
          {(item) => (
            <button type="button" aria-pressed={tool() === item.id} onClick={() => setTool(item.id)}>
              {translateDescriptor(item.label, i18n)}
            </button>
          )}
        </For>
        <span class="welcome-tool-divider" />
        <button
          type="button"
          aria-pressed={wind() !== 0}
          onClick={() => setWind((value) => (value === 0 ? 1 : value === 1 ? -1 : 0))}
        >
          {i18n._({
            id: "welcome.nature.wind",
            message: "Wind: {direction, select, left {left} right {right} other {calm}}",
            values: { direction: wind() > 0 ? "right" : wind() < 0 ? "left" : "calm" },
          })}
        </button>
        <button type="button" aria-pressed={lowGravity()} onClick={() => setLowGravity(!lowGravity())}>
          {i18n._({ id: "welcome.nature.gravity", message: "Low gravity" })}
        </button>
        <Show when={!props.active()}>
          <button type="button" onClick={() => post({ type: "step", generation })}>
            {i18n._({ id: "welcome.nature.step", message: "Advance one step" })}
          </button>
        </Show>
        <button
          type="button"
          onClick={() => {
            latest = createNature(props.seed)
            setWind(0)
            setLowGravity(false)
            props.memory.write(latest)
            initialize()
          }}
        >
          {i18n._({ id: "welcome.common.reset", message: "Start over" })}
        </button>
      </div>
      <Show when={fault()}>
        <p class="welcome-scene-error" role="status">
          {i18n._({ id: "welcome.nature.failed", message: "The simulation stopped. Your task draft is safe." })}
          <button type="button" onClick={() => setRestart((value) => value + 1)}>
            {i18n._({ id: "welcome.common.retry", message: "Retry example" })}
          </button>
        </p>
      </Show>
      <div class="welcome-scene-footer">
        <p role="status">
          {i18n._({
            id: "welcome.nature.growing",
            message:
              "{count, plural, =0 {A little water. A new beginning.} one {# plant is growing.} other {# plants are growing.}}",
            values: { count: grown() },
          })}
        </p>
        <button
          class="welcome-create"
          type="button"
          disabled={props.disabled}
          onClick={() =>
            props.onStart(
              i18n._({
                id: "welcome.nature.prompt",
                message:
                  "Help me build an original interactive landscape where people can shape terrain, guide water and grow plants. Include wind and gravity controls, an accessible keyboard mode, and a simulation that stays responsive while editing. First help me choose a theme and audience. My idea is: ",
              }),
            )
          }
        >
          {i18n._({ id: "welcome.common.create", message: "Make my own version" })}
        </button>
      </div>
    </section>
  )
}
