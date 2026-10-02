import { createEffect, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import { createOrbit, aimOrbit, launchOrbit, advanceOrbit, prepareOrbit, predictOrbit, launchPoint } from "./model"

export default function OrbitScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createOrbit(props.seed)))
  const [pulse, setPulse] = createSignal(0)
  let drag: { id: number; x: number; y: number; angle: number; power: number; moved: boolean } | undefined
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => {
    setState((s) => advanceOrbit(s, dt))
    if (!props.reducedMotion()) setPulse((t) => t + dt)
  })
  const reset = () => {
    cancel()
    setState(createOrbit(props.seed))
  }
  const act = () => {
    props.interact()
    setState((s) => (s.phase === "aiming" ? launchOrbit(s) : prepareOrbit(s)))
  }
  const status = () => {
    if (state().phase === "delivered")
      return i18n._({ id: "welcome.orbit.arrived", message: "Delivered · Click for the next flight" })
    if (state().phase === "missed")
      return i18n._({ id: "welcome.orbit.again", message: "Try a different angle · Click to retry" })
    if (!props.active()) return i18n._({ id: "welcome.common.continue", message: "Click to continue" })
    if (state().phase === "aiming") return i18n._({ id: "welcome.orbit.ready", message: "Aim, then click to launch" })
    return `${state().round + 1} / 3`
  }
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state(),
        t = pulse()
      for (let index = 0; index < s.planets.length; index++) {
        const p = s.planets[index]!,
          color = index ? ink.second : ink.accent
        for (let y = -p.radius; y <= p.radius; y += 4)
          for (let x = -p.radius; x <= p.radius; x += 4) {
            if (x * x + y * y > p.radius * p.radius) continue
            ctx.fillStyle = color
            ctx.globalAlpha = x + y > p.radius * 0.3 ? 0.6 : 0.85
            ctx.fillRect(p.x + x, p.y + y, 4, 4)
            if (Math.round(x + y * 3) % 28 === 0) {
              ctx.globalAlpha = 0.22
              ctx.fillStyle = ink.strong
              ctx.fillRect(p.x + x, p.y + y, 4, 4)
            }
          }
        ctx.globalAlpha = 0.12
        ctx.strokeStyle = color
        ctx.setLineDash([2, 8])
        ctx.beginPath()
        ctx.ellipse(p.x, p.y, p.radius + 16, p.radius + 10, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.globalAlpha = 1
      sprite(
        ctx,
        sprites.beacon,
        s.target.x - 13,
        s.target.y - 15,
        3,
        s.phase === "delivered" ? ink.second : ink.strong,
        ink.paper,
      )
      ctx.globalAlpha = 0.2 + 0.15 * Math.sin(t * 2)
      sprite(ctx, sprites.star, s.target.x - 7, s.target.y - 46, 2, ink.second)
      ctx.globalAlpha = 1
      const trail = s.phase === "aiming" ? predictOrbit(s) : s.trace
      trail.forEach((p, index) => {
        ctx.globalAlpha = s.phase === "aiming" ? 0.12 + (index / trail.length) * 0.25 : (index / trail.length) * 0.45
        ctx.fillStyle = ink.strong
        ctx.fillRect(Math.round(p.x / 2) * 2, Math.round(p.y / 2) * 2, 2, 2)
      })
      ctx.globalAlpha = 1
      const position = s.phase === "aiming" ? launchPoint : s.ship
      const angle = s.phase === "aiming" ? s.angle : (Math.atan2(s.ship.vy, s.ship.vx) * 180) / Math.PI
      ctx.save()
      ctx.translate(position.x, position.y)
      ctx.rotate(((angle + 90) * Math.PI) / 180)
      sprite(ctx, sprites.rocket, -12, -12, 2, ink.strong, ink.paper)
      if (s.phase === "flying") {
        ctx.fillStyle = ink.second
        ctx.fillRect(-4, 5, 8, 6 + (Math.round(t * 18) % 3) * 2)
        ctx.globalAlpha = 0.4
        ctx.fillRect(-2, 14, 4, 6)
      }
      ctx.restore()
      if (s.phase === "delivered" || s.phase === "missed") {
        ctx.fillStyle = s.phase === "delivered" ? ink.second : ink.strong
        for (let i = 0; i < 12; i++) {
          const a = (i * Math.PI) / 6
          ctx.globalAlpha = 0.4
          ctx.fillRect(position.x + Math.cos(a) * 24, position.y + Math.sin(a) * 24, 3, 3)
        }
        ctx.globalAlpha = 1
      }
    },
    720,
    320,
  )
  function cancel() {
    if (!drag) return
    const previous = drag
    drag = undefined
    setState((s) => aimOrbit(s, previous.angle, previous.power))
    if (canvas.element().hasPointerCapture(previous.id)) canvas.element().releasePointerCapture(previous.id)
  }
  createEffect(() => {
    if (!props.active()) cancel()
  })
  onCleanup(cancel)
  return (
    <div class="welcome-game welcome-orbit" data-phase={state().phase}>
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.orbit.name", message: "Gravity post" })}
        status={status()}
        playing={state().phase === "flying"}
        onAction={act}
        onReset={reset}
        help={i18n._({
          id: "welcome.orbit.help",
          message:
            "Move to aim, click to launch, or pull back to set power. Arrow keys aim and adjust power; Space launches.",
        })}
        onKey={(e) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(e.key)) {
            e.preventDefault()
            e.stopPropagation()
            props.interact()
            if (e.key === " " || e.key === "Enter") act()
            else
              setState((s) =>
                aimOrbit(
                  s,
                  s.angle + (e.key === "ArrowLeft" ? -2 : e.key === "ArrowRight" ? 2 : 0),
                  s.power + (e.key === "ArrowUp" ? 15 : e.key === "ArrowDown" ? -15 : 0),
                ),
              )
          }
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.orbit.field", message: "Gravity delivery playfield" })}
          aria-description={i18n._({
            id: "welcome.orbit.aim",
            message: "Angle {angle}°, power {power}",
            values: { angle: state().angle.toFixed(1), power: Math.round(state().power) },
          })}
          onPointerMove={(e) => {
            if (state().phase !== "aiming") return
            const point = canvas.point(e)
            if (drag) {
              const dx = drag.x - point.x,
                dy = drag.y - point.y
              if (Math.hypot(dx, dy) > 5) {
                drag.moved = true
                setState((s) =>
                  aimOrbit(s, (Math.atan2(dy, Math.max(1, dx)) * 180) / Math.PI, 220 + Math.hypot(dx, dy) * 2),
                )
              }
            } else if (props.active())
              setState((s) =>
                aimOrbit(
                  s,
                  (Math.atan2(point.y - launchPoint.y, Math.max(1, point.x - launchPoint.x)) * 180) / Math.PI,
                  s.power,
                ),
              )
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            canvas.element().focus({ preventScroll: true })
            props.interact()
            if (state().phase !== "aiming") {
              act()
              return
            }
            const point = canvas.point(e)
            drag = { ...point, id: e.pointerId, angle: state().angle, power: state().power, moved: false }
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            if (drag?.id !== e.pointerId) return
            drag = undefined
            canvas.element().releasePointerCapture(e.pointerId)
            act()
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        />
      </GameSurface>
    </div>
  )
}
