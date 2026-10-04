import { createEffect, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas, type Ink } from "../pixels"
import { useSceneClock } from "../clock"
import { advanceStack, createStack, dropBlock, stackLayout, stackGround, stackCamera, floorHeight } from "./model"

export default function StackScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createStack(props.seed)))
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => {
    canvas.advanceTransition(dt)
    setState((s) => advanceStack(s, dt))
  })
  const reset = () => {
    canvas.transition()
    setState(createStack(props.seed))
  }
  const terminal = () => state().phase === "missed"
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
        values: { height: state().height },
      })
    if (!props.active()) return i18n._({ id: "welcome.common.continue", message: "Click to continue" })
    if (state().phase === "ready") return i18n._({ id: "welcome.stack.ready", message: "Click to drop" })
    return `${state().height}${state().combo > 1 ? ` · ×${state().combo}` : ""}${state().height > 0 && state().height % 12 === 0 ? " · ★" : ""}`
  }
  function block(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    x: number,
    y: number,
    width: number,
    perfect: boolean,
    moving = false,
    opacity = 1,
  ) {
    x = Math.round(x / 2) * 2
    width = Math.floor(width / 2) * 2
    ctx.fillStyle = moving ? ink.strong : ink.accent
    ctx.globalAlpha = opacity
    ctx.fillRect(x, y, width, floorHeight)
    ctx.globalAlpha = 0.65 * opacity
    ctx.fillStyle = ink.paper
    ctx.fillRect(x + 2, y + 2, width - 4, 2)
    ctx.globalAlpha = opacity
    ctx.fillStyle = ink.strong
    ctx.globalAlpha = 0.15 * opacity
    ctx.fillRect(x, y + floorHeight - 2, width, 2)
    ctx.globalAlpha = 1
    for (let wx = x + 6; wx < x + width - 4; wx += 12) {
      ctx.globalAlpha = (perfect ? 0.9 : 0.45) * opacity
      ctx.fillStyle = ink.paper
      ctx.fillRect(wx, y + 6, 4, 5)
    }
    ctx.globalAlpha = 1
  }
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state()
      const ending = terminal() ? (props.reducedMotion() ? 1 : s.ending) : 0
      const camera = Math.round(props.reducedMotion() ? stackCamera(s) : s.camera)
      ctx.globalAlpha = 0.12
      ctx.fillStyle = ink.strong
      for (let i = 0; i < 12; i++) {
        const x = 40 + i * 55,
          h = 8 + ((i * 17) % 30)
        ctx.fillRect(x, stackGround - h + camera, 20 + (i % 3) * 8, h)
      }
      ctx.fillRect(40, stackGround + camera, 640, 2)
      ctx.globalAlpha = 1
      for (const b of stackLayout(s, props.reducedMotion()))
        block(ctx, ink, b.x, b.y, b.width, b.perfect && b.level === s.height && s.cooldown > 0, false, 1 - ending * 0.3)
      const y = stackGround - (s.height + 2) * floorHeight + camera
      if (s.fall) {
        const t = props.reducedMotion() ? 1 : Math.min(1, s.fall.age / 0.14)
        block(ctx, ink, s.fall.x, Math.round(y - 26 * (1 - t * t)), s.fall.width, false, true)
      } else if (!terminal()) {
        block(ctx, ink, s.moving.x, y - 26, s.moving.width, false, true)
      }
      if (s.cooldown > 0 && s.last === "perfect") {
        const top = stackLayout(s, props.reducedMotion()).at(-1)!
        ctx.fillStyle = ink.paper
        ctx.globalAlpha = props.reducedMotion() ? 0.4 : s.cooldown * 7
        ctx.fillRect(top.x, top.y + floorHeight - 2, top.width, 2)
        ctx.globalAlpha = 1
      }
      if (s.cut && !props.reducedMotion()) {
        ctx.save()
        ctx.translate(
          s.cut.x + s.cut.width / 2 + s.cut.direction * s.cut.age * 85,
          stackGround - (s.cut.level + 1) * floorHeight + camera + s.cut.age * s.cut.age * 320,
        )
        ctx.rotate(s.cut.direction * s.cut.age * 1.6)
        block(
          ctx,
          ink,
          -s.cut.width / 2,
          0,
          s.cut.width,
          false,
          false,
          Math.max(0, Math.min(1, (0.8 - s.cut.age) / 0.25)),
        )
        ctx.restore()
      }
      if (terminal() && s.height > 0) {
        const top = stackLayout(s, props.reducedMotion()).at(-1)!
        const reveal = Math.max(0, Math.min(1, (ending - 0.25) / 0.4))
        ctx.globalAlpha = reveal
        sprite(
          ctx,
          sprites.flag,
          top.x + top.width / 2 - 1,
          top.y - 24 + Math.round((1 - reveal) ** 3 * 8),
          3,
          ink.strong,
          ink.second,
        )
        ctx.globalAlpha = 1
      } else if (s.height > 0 && s.height % 12 === 0 && !s.fall)
        sprite(ctx, sprites.flag, s.blocks.at(-1)!.x + 8, y + floorHeight - 26, 2, ink.strong, ink.second)
    },
    720,
    340,
    "end",
    props.reducedMotion,
  )
  return (
    <div class="welcome-game welcome-stack" data-phase={state().phase} data-height={state().height}>
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
            if (e.repeat) return
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
