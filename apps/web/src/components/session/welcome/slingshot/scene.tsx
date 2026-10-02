import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import { createSlingshot, slingAnchor, slingOrigin, type SlingSnapshot } from "./model"

const bird = [
  "000111110000",
  "001111111000",
  "011111111100",
  "111111211110",
  "111111221111",
  "111111111100",
  "011111111000",
  "001111110000",
  "000111000000",
]
const target = [
  "0001111000",
  "0011111100",
  "0111111110",
  "1112112111",
  "1112112111",
  "1111111111",
  "0111221110",
  "0011111100",
  "0001111000",
]
export default function SlingshotScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const game = createSlingshot(
    props.seed,
    props.memory.read<SlingSnapshot | undefined>(() => undefined),
  )
  const [state, setState] = createSignal(game.snapshot())
  const [armed, setArmed] = createSignal(false)
  const [generation, setGeneration] = createSignal(0)
  const [drag, setDrag] = createSignal<{
    id: number
    angle: number
    power: number
    x: number
    y: number
    moved: boolean
  }>()
  const sync = () => setState(game.snapshot())
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => {
    game.advance(dt)
    sync()
  })
  const angle = createMemo(() => state().angle),
    power = createMemo(() => state().power),
    phase = createMemo(() => state().phase),
    level = createMemo(() => state().level)
  const trajectory = createMemo(() => {
    angle()
    power()
    phase()
    level()
    generation()
    return game.predict()
  })
  const terminal = () => state().phase === "won" || state().phase === "lost"
  const act = () => {
    props.interact()
    if (state().phase === "won") game.next()
    else if (state().phase === "lost") game.retry()
    else setArmed(true)
    sync()
  }
  const reset = () => {
    cancel()
    game.retry()
    setArmed(false)
    setGeneration((n) => n + 1)
    sync()
  }
  const status = () => {
    const s = state()
    if (s.phase === "won")
      return i18n._({
        id: "welcome.slingshot.won",
        message: "{stars} · Next level",
        values: { stars: "★".repeat(s.stars) },
      })
    if (s.phase === "lost") return i18n._({ id: "welcome.slingshot.lost", message: "Try again" })
    if (!props.active()) return i18n._({ id: "welcome.common.continue", message: "Click to continue" })
    if (s.phase === "aiming")
      return i18n._({
        id: "welcome.slingshot.ready",
        message: "Pull back and release · {shots} shots",
        values: { shots: s.shots },
      })
    return i18n._({
      id: "welcome.slingshot.score",
      message: "Level {level} · {score} points",
      values: { level: s.level + 1, score: s.score },
    })
  }
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state()
      ctx.fillStyle = ink.strong
      ctx.globalAlpha = 0.15
      ctx.fillRect(28, 320, 664, 2)
      for (let x = 32; x < 700; x += 34) ctx.fillRect(x, 328 + (x % 3), 4, 1)
      ctx.globalAlpha = 1
      ctx.fillStyle = ink.second
      ctx.fillRect(91, 256, 10, 64)
      ctx.fillRect(78, 219, 7, 40)
      ctx.fillRect(108, 219, 7, 40)
      ctx.fillRect(82, 250, 29, 9)
      const pulling = s.phase === "aiming" && armed()
      const origin = pulling ? slingOrigin(s.angle, s.power) : slingAnchor
      ctx.strokeStyle = ink.strong
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(80, 228)
      if (s.phase === "flying" && s.elapsed < 0.18 && !props.reducedMotion())
        ctx.lineTo(98 + Math.sin(s.elapsed * 65) * 12 * (1 - s.elapsed / 0.18), 224)
      else ctx.lineTo(origin.x, origin.y)
      ctx.lineTo(111, 228)
      ctx.stroke()
      if (pulling)
        for (const [index, p] of trajectory().entries()) {
          ctx.globalAlpha = Math.max(0.08, 0.5 - index / 55)
          ctx.fillStyle = ink.strong
          ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2)
        }
      ctx.globalAlpha = 1
      for (const b of s.bodies) {
        ctx.save()
        ctx.translate(Math.round(b.x), Math.round(b.y))
        ctx.rotate(b.angle)
        if (b.kind === "bird") sprite(ctx, bird, -12, -9, 2, ink.accent, ink.paper)
        else if (b.kind === "target") sprite(ctx, target, -10, -9, 2, ink.second, ink.paper)
        else {
          ctx.fillStyle = b.kind === "wood" ? ink.second : ink.soft
          ctx.fillRect(-b.width / 2, -b.height / 2, b.width, b.height)
          ctx.fillStyle = ink.paper
          ctx.globalAlpha = 0.45
          ctx.fillRect(-b.width / 2 + 2, -b.height / 2 + 2, b.width - 4, 2)
          ctx.fillStyle = ink.strong
          ctx.globalAlpha = 0.22
          if (b.kind === "wood") {
            for (let n = 8; n < Math.max(b.width, b.height) - 4; n += 12) {
              if (b.width > b.height) ctx.fillRect(-b.width / 2 + n, -1, 5, 2)
              else ctx.fillRect(-2, -b.height / 2 + n, 2, 6)
            }
          } else for (let x = 4; x < b.width - 4; x += 8) ctx.fillRect(-b.width / 2 + x, 2, 3, 3)
        }
        ctx.restore()
      }
      if (s.phase === "aiming") {
        ctx.save()
        ctx.translate(Math.round(origin.x), Math.round(origin.y))
        ctx.rotate(((s.angle + 35) * Math.PI) / 360)
        sprite(ctx, bird, -12, -9, 2, ink.accent, ink.paper)
        ctx.restore()
      }
      if (s.phase === "flying" && !props.reducedMotion()) {
        const b = s.bodies.find((b) => b.id === s.sequence - 1)
        if (b)
          for (let i = 1; i <= 6; i++) {
            ctx.globalAlpha = (1 - i / 7) * 0.25
            ctx.fillStyle = ink.accent
            ctx.fillRect(Math.round(b.x - b.vx * i * 0.008), Math.round(b.y - b.vy * i * 0.008), 3, 3)
          }
      }
      if (!props.reducedMotion())
        for (const burst of s.bursts) {
          ctx.globalAlpha = Math.max(0, 1 - burst.age / 0.55)
          ctx.fillStyle = burst.kind === "wood" || burst.kind === "target" ? ink.second : ink.accent
          for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI) / 4
            ctx.fillRect(
              Math.round(burst.x + Math.cos(a) * burst.age * 85),
              Math.round(burst.y + Math.sin(a) * burst.age * 85 + burst.age ** 2 * 100),
              i % 2 ? 4 : 2,
              3,
            )
          }
        }
      ctx.globalAlpha = 1
    },
    720,
    360,
    "end",
  )
  function cancel() {
    const previous = drag()
    if (!previous) return
    setDrag(undefined)
    setArmed(false)
    game.aim(previous.angle, previous.power)
    sync()
    if (canvas.element().hasPointerCapture(previous.id)) canvas.element().releasePointerCapture(previous.id)
  }
  createEffect(() => {
    if (!props.active()) cancel()
  })
  onCleanup(() => {
    cancel()
    game.dispose()
  })
  return (
    <div
      class="welcome-game welcome-slingshot"
      data-phase={state().phase}
      data-shots={state().shots}
      data-level={state().level}
    >
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.slingshot.name", message: "Pixel slingshot" })}
        status={status()}
        playing={state().phase === "flying"}
        onAction={act}
        onReset={reset}
        help={i18n._({
          id: "welcome.slingshot.help",
          message:
            "Pull the bird back and release to topple the targets. Left and right aim, up and down set power, Space launches. Escape cancels the pull.",
        })}
        onKey={(e) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(e.key)) return
          e.preventDefault()
          e.stopPropagation()
          props.interact()
          if (terminal()) {
            act()
            return
          }
          setArmed(true)
          if (e.key === " " || e.key === "Enter") {
            game.launch()
            setArmed(false)
          } else
            game.aim(
              state().angle + (e.key === "ArrowLeft" ? -2 : e.key === "ArrowRight" ? 2 : 0),
              state().power + (e.key === "ArrowUp" ? 20 : e.key === "ArrowDown" ? -20 : 0),
            )
          sync()
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.slingshot.field", message: "Slingshot playfield" })}
          aria-description={i18n._({
            id: "welcome.slingshot.aim",
            message: "Angle {angle}°, power {power}",
            values: { angle: Math.round(state().angle), power: Math.round(state().power) },
          })}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            canvas.element().focus({ preventScroll: true })
            props.interact()
            if (terminal()) {
              act()
              return
            }
            if (state().phase !== "aiming") return
            const p = canvas.point(e),
              rect = canvas.element().getBoundingClientRect()
            const scale = Math.min(rect.width / 720, rect.height / 360)
            const origin = armed() ? slingOrigin(state().angle, state().power) : slingAnchor
            if (Math.hypot(p.x - origin.x, p.y - origin.y) > Math.max(22, 22 / scale)) return
            setDrag({ id: e.pointerId, ...p, angle: state().angle, power: state().power, moved: false })
            setArmed(false)
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!props.active() || state().phase !== "aiming") return
            const p = canvas.point(e),
              previous = drag()
            if (previous) {
              if (previous.id !== e.pointerId) return
              setArmed(true)
              const dx = slingAnchor.x - p.x,
                dy = slingAnchor.y - p.y
              setDrag({ ...previous, moved: previous.moved || Math.hypot(p.x - previous.x, p.y - previous.y) > 6 })
              game.aim((Math.atan2(dy, dx) * 180) / Math.PI, Math.hypot(dx, dy) * 9.5)
            } else if (!armed())
              game.aim((Math.atan2(p.y - slingAnchor.y, p.x - slingAnchor.x) * 180) / Math.PI, state().power)
            sync()
          }}
          onPointerUp={(e) => {
            const previous = drag()
            if (previous?.id !== e.pointerId) return
            if (!previous.moved) {
              cancel()
              return
            }
            setDrag(undefined)
            setArmed(false)
            canvas.element().releasePointerCapture(e.pointerId)
            game.launch()
            sync()
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        />
      </GameSurface>
    </div>
  )
}
