import { createEffect, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas, type Ink } from "../pixels"
import { useSceneClock } from "../clock"
import { advanceStack, createStack, dropBlock, stackGoal } from "./model"

export default function StackScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createStack(props.seed)))
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => setState((s) => advanceStack(s, dt)))
  const reset = () => setState(createStack(props.seed))
  const terminal = () => state().phase === "won" || state().phase === "missed"
  const act = () => {
    props.interact()
    if (terminal()) reset()
    else setState(dropBlock)
  }
  const status = () => {
    if (terminal())
      return i18n._({
        id: "welcome.stack.result",
        message: "{height} floors · Play again",
        values: { height: state().blocks.length - 1 },
      })
    if (!props.active()) return i18n._({ id: "welcome.common.continue", message: "Click to continue" })
    if (state().phase === "ready") return i18n._({ id: "welcome.stack.ready", message: "Click to drop" })
    return `${state().blocks.length - 1} / ${stackGoal}${state().combo > 1 ? ` · ×${state().combo}` : ""}`
  }
  function block(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    x: number,
    y: number,
    width: number,
    perfect: boolean,
    moving = false,
  ) {
    x = Math.round(x / 2) * 2
    width = Math.floor(width / 2) * 2
    ctx.fillStyle = moving ? ink.strong : ink.accent
    ctx.fillRect(x, y, width, 16)
    ctx.globalAlpha = 0.65
    ctx.fillStyle = ink.paper
    ctx.fillRect(x + 2, y + 2, width - 4, 2)
    ctx.globalAlpha = 1
    ctx.fillStyle = ink.strong
    ctx.globalAlpha = 0.15
    ctx.fillRect(x, y + 14, width, 2)
    ctx.globalAlpha = 1
    for (let wx = x + 6; wx < x + width - 4; wx += 12) {
      ctx.globalAlpha = perfect ? 0.9 : 0.45
      ctx.fillStyle = ink.paper
      ctx.fillRect(wx, y + 6, 4, 5)
    }
    ctx.globalAlpha = 1
  }
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state()
      ctx.globalAlpha = 0.12
      ctx.fillStyle = ink.strong
      for (let i = 0; i < 12; i++) {
        const x = 40 + i * 55,
          h = 8 + ((i * 17) % 30)
        ctx.fillRect(x, 307 - h, 20 + (i % 3) * 8, h)
      }
      ctx.fillRect(40, 310, 640, 2)
      ctx.globalAlpha = 1
      s.blocks.forEach((b, index) => block(ctx, ink, b.x, 292 - index * 19, b.width, b.perfect))
      if (!terminal()) {
        const y = 292 - s.blocks.length * 19 - 7
        block(ctx, ink, s.moving.x, y, s.moving.width, false, true)
        ctx.globalAlpha = 0.08
        ctx.fillStyle = ink.strong
        ctx.fillRect(s.moving.x, 310, Math.max(2, s.moving.width), 3)
        ctx.globalAlpha = 1
      }
      if (s.cut) {
        ctx.globalAlpha = Math.max(0, 1 - s.cut.age / 0.8)
        block(
          ctx,
          ink,
          s.cut.x + s.cut.direction * s.cut.age * 85,
          292 - s.cut.level * 19 + s.cut.age * s.cut.age * 240,
          s.cut.width,
          false,
        )
        ctx.globalAlpha = 1
      }
      if (s.phase === "won")
        sprite(ctx, sprites.flag, s.blocks.at(-1)!.x + 12, 292 - s.blocks.length * 19 - 12, 3, ink.strong, ink.second)
    },
    720,
    340,
    "end",
  )
  return (
    <div class="welcome-game welcome-stack" data-phase={state().phase} data-height={state().blocks.length - 1}>
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.stack.name", message: "Tiny tower" })}
        status={status()}
        playing={state().phase === "playing"}
        onAction={act}
        onReset={reset}
        help={i18n._({
          id: "welcome.stack.help",
          message: "Click or press Space to stack the moving floor. Line up the edges.",
        })}
        onKey={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault()
            e.stopPropagation()
            act()
          }
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.stack.field", message: "Stacking playfield" })}
          onClick={() => {
            canvas.element().focus({ preventScroll: true })
            act()
          }}
        />
      </GameSurface>
    </div>
  )
}
