import { createEffect, createSignal } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import { createFlight, aimFlight, startFlight, advanceFlight } from "./model"

export default function FlightScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createFlight(props.seed)))
  const [idle, setIdle] = createSignal(0)
  const keys = new Set<string>()
  createEffect(() => props.memory.write(state()))
  createEffect(() => {
    if (!props.active()) keys.clear()
  })
  const reset = () => {
    keys.clear()
    setState(createFlight(props.seed))
  }
  const start = () => {
    props.interact()
    setState((s) => startFlight(s.phase === "over" ? createFlight(props.seed) : s))
  }
  useSceneClock(props.active, (dt) => {
    if (!props.reducedMotion()) setIdle((t) => t + dt)
    setState((s) => {
      const x = s.ship.x + ((keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0)) * 290 * dt
      const y = s.ship.y + ((keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0)) * 290 * dt
      return advanceFlight(keys.size ? aimFlight(s, x, y) : s, dt)
    })
  })
  const status = () =>
    state().phase === "over"
      ? i18n._({ id: "welcome.flight.over", message: "{score} points · Fly again", values: { score: state().score } })
      : !props.active()
        ? i18n._({ id: "welcome.common.continue", message: "Click to continue" })
        : state().phase === "ready"
          ? i18n._({ id: "welcome.flight.ready", message: "Move to steer · Click to fly" })
          : `${String(state().score).padStart(4, "0")} · ${"♥".repeat(state().lives)}`
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state(),
        time = idle()
      s.bullets.forEach((b) => {
        ctx.fillStyle = ink.strong
        ctx.fillRect(Math.round(b.x), Math.round(b.y), 2, 9)
        ctx.fillStyle = ink.second
        ctx.fillRect(Math.round(b.x), Math.round(b.y) + 7, 2, 3)
      })
      s.enemies.forEach((e) => {
        const mask = e.kind === 1 ? sprites.drone : sprites.enemy
        sprite(ctx, mask, e.x - mask[0].length, e.y - 8, 2, e.kind === 2 ? ink.second : ink.strong, ink.paper)
      })
      s.bursts.forEach((b) => {
        ctx.fillStyle = ink.second
        ctx.globalAlpha = Math.max(0, 1 - b.age / 0.45)
        for (let i = 0; i < 12; i++) {
          const a = (i * Math.PI) / 6,
            r = 6 + b.age * 75
          ctx.fillRect(
            Math.round(b.x + Math.cos(a) * r),
            Math.round(b.y + Math.sin(a) * r),
            i % 2 ? 3 : 2,
            i % 2 ? 3 : 2,
          )
        }
        ctx.globalAlpha = 1
      })
      if (s.invulnerable > 0) ctx.globalAlpha = Math.floor(s.time * 12) % 2 ? 0.35 : 1
      sprite(ctx, sprites.ship, s.ship.x - 11, s.ship.y - 11, 2, ink.strong, ink.paper)
      ctx.globalAlpha = 0.65
      ctx.fillStyle = ink.second
      const exhaust = 4 + (Math.floor(time * 9) % 3) * 2
      ctx.fillRect(s.ship.x - 8, s.ship.y + 9, 4, exhaust)
      ctx.fillRect(s.ship.x + 4, s.ship.y + 9, 4, exhaust)
      ctx.globalAlpha = 1
    },
    720,
    400,
  )
  return (
    <div class="welcome-game welcome-flight" data-phase={state().phase}>
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.flight.name", message: "Pixel squadron" })}
        status={status()}
        playing={state().phase === "playing"}
        onAction={start}
        onReset={reset}
        help={i18n._({
          id: "welcome.flight.help",
          message:
            "Move the pointer or use arrow keys to steer. Click or press Space to start automatic fire. Avoid enemies and protect the lower edge.",
        })}
        onKey={(e) => {
          if (e.key.startsWith("Arrow")) {
            e.preventDefault()
            e.stopPropagation()
            props.interact()
            keys.add(e.key)
          }
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault()
            e.stopPropagation()
            start()
          }
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.flight.field", message: "Aircraft playfield" })}
          aria-description={i18n._({
            id: "welcome.flight.position",
            message: "Aircraft at {x}, {y}",
            values: { x: Math.round(state().ship.x), y: Math.round(state().ship.y) },
          })}
          onKeyUp={(e) => keys.delete(e.key)}
          onBlur={() => keys.clear()}
          onPointerMove={(e) => {
            if (props.active()) {
              const p = canvas.point(e)
              setState((s) => aimFlight(s, p.x, p.y))
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            canvas.element().focus({ preventScroll: true })
            start()
            const p = canvas.point(e)
            setState((s) => aimFlight(s, p.x, p.y))
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            if (canvas.element().hasPointerCapture(e.pointerId)) canvas.element().releasePointerCapture(e.pointerId)
          }}
          onPointerCancel={() => props.pause()}
        />
      </GameSurface>
    </div>
  )
}
