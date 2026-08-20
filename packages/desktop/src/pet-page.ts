/**
 * Pet renderer page.
 *
 * An inline, dependency-free HTML document loaded into the transparent pet
 * window. It draws the sprite sheet frame for the current mood on a canvas,
 * falls back to a CSS blob when no sprite sheet is configured, and drives
 * drag/poke interaction through the preload bridge. It never touches Node or
 * Electron APIs directly.
 */

import type { PetMood } from "./pet-state.js"
import type { PetSettingsV1, PetSpriteSheet } from "./pet-types.js"
import { defaultDesktopSkinState, desktopThemeSnapshot, type DesktopThemeSnapshot } from "./theme.js"

export interface PetPageOptions {
  settings: PetSettingsV1
  sprite: PetSpriteSheet
  /** Theme snapshot used for the CSS fallback palette; defaults to the light shell skin. */
  theme?: DesktopThemeSnapshot
}

const FALLBACK_THEME: DesktopThemeSnapshot = desktopThemeSnapshot(defaultDesktopSkinState("light"), false)

const MOOD_ROW: Record<PetMood, number> = {
  idle: 0,
  happy: 1,
  celebrate: 2,
  sleepy: 3,
  working: 4,
  angry: 5,
  dragging: 6,
}

export function petPage(options: PetPageOptions): string {
  const { settings, sprite, theme = FALLBACK_THEME } = options
  const colors = theme.colors
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: ${theme.effective};
    --pet-primary: ${colors.markBackground};
    --pet-secondary: ${colors.control};
    --pet-accent: ${colors.focus};
    --pet-shadow: ${colors.border};
    --pet-eye: ${colors.text};
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  body { user-select: none; -webkit-user-select: none; cursor: grab; }
  body.dragging { cursor: grabbing; }
  #stage {
    position: fixed; inset: 0;
    display: grid; place-items: center;
    background: transparent;
  }
  canvas.pet-canvas {
    display: block;
    width: 100%; height: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }
  .pet-fallback {
    width: 64%; height: 64%;
    border-radius: 42% 58% 55% 45% / 50% 44% 56% 50%;
    background: radial-gradient(circle at 35% 30%, var(--pet-primary), var(--pet-secondary) 55%, var(--pet-accent));
    animation: pet-breathe 2.4s ease-in-out infinite;
    box-shadow: inset 0 -8px 18px var(--pet-shadow);
  }
  .pet-fallback::after {
    content: "";
    position: absolute; top: 32%; left: 24%;
    width: 10%; height: 12%;
    border-radius: 50%;
    background: var(--pet-eye);
    box-shadow: 420% 0 0 var(--pet-eye);
    animation: pet-blink 4s step-end infinite;
  }
  body.mood-sleepy .pet-fallback { animation: pet-breathe 3.6s ease-in-out infinite; }
  body.mood-sleepy .pet-fallback::after { animation: none; box-shadow: none; }
  body.mood-happy .pet-fallback, body.mood-celebrate .pet-fallback { animation: pet-bounce 0.8s ease-in-out infinite; }
  body.mood-working .pet-fallback { animation: pet-breathe 1.2s ease-in-out infinite; }
  body.mood-angry .pet-fallback { filter: hue-rotate(160deg) saturate(1.4); animation: pet-shake 0.5s ease-in-out infinite; }
  @keyframes pet-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.06, 0.96); }
  }
  @keyframes pet-bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-12%); }
  }
  @keyframes pet-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-5%); }
    75% { transform: translateX(5%); }
  }
  @keyframes pet-blink {
    0%, 92%, 100% { transform: scaleY(1); }
    94%, 96% { transform: scaleY(0.1); }
  }
</style>
</head>
<body class="mood-idle">
<div id="stage"></div>
<script>
(() => {
  const MOOD_ROW = ${JSON.stringify(MOOD_ROW)}
  const initialSettings = ${JSON.stringify(settings)}
  const initialSprite = ${JSON.stringify(sprite)}
  const stage = document.getElementById("stage")
  const bridge = window.synergyPet
  let mood = "idle"
  let settings = initialSettings
  let sprite = initialSprite
  let canvas = null
  let image = null
  let raf = 0
  let frameIndex = 0
  let lastFrameAt = 0
  let dragging = false
  let dragStartX = 0
  let dragStartY = 0
  let moved = false
  let lastX = 0
  let lastY = 0

  function setMood(next) {
    mood = next
    document.body.className = "mood-" + next
  }

  function ensureCanvas() {
    if (canvas) return
    canvas = document.createElement("canvas")
    canvas.className = "pet-canvas"
    stage.appendChild(canvas)
  }

  function loadImage() {
    image = null
    if (!sprite.dataUrl) { renderFallback(); return }
    const img = new Image()
    img.onload = () => {
      image = img
      canvas = canvas || ensureCanvas()
      renderFallback(false)
      lastFrameAt = 0
    }
    img.onerror = () => { image = null; renderFallback() }
    img.src = sprite.dataUrl
  }

  function renderFallback(show = true) {
    if (show) {
      if (!document.querySelector(".pet-fallback")) {
        const el = document.createElement("div")
        el.className = "pet-fallback"
        stage.appendChild(el)
      }
      if (canvas) canvas.style.display = "none"
    } else {
      const fb = document.querySelector(".pet-fallback")
      if (fb) fb.remove()
      if (canvas) canvas.style.display = "block"
    }
  }

  function drawFrame(now) {
    raf = requestAnimationFrame(drawFrame)
    if (!image || !canvas) return
    if (!lastFrameAt) lastFrameAt = now
    const frameMs = Math.max(16, sprite.frameMs || 120)
    if (now - lastFrameAt >= frameMs) {
      frameIndex = (frameIndex + 1) % Math.max(1, sprite.columns || 8)
      lastFrameAt = now
    }
    const row = MOOD_ROW[mood] ?? 0
    const rows = Math.max(1, sprite.rows || 7)
    const cols = Math.max(1, sprite.columns || 8)
    const fw = image.naturalWidth / cols
    const fh = image.naturalHeight / rows
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    const scale = Math.min(cw / fw, ch / fh)
    const dw = fw * scale
    const dh = fh * scale
    canvas.width = Math.max(1, Math.round(dw))
    canvas.height = Math.max(1, Math.round(dh))
    const ctx = canvas.getContext("2d")
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
      image,
      frameIndex * fw, row * fh, fw, fh,
      0, 0, canvas.width, canvas.height,
    )
  }

  function stopAnimation() {
    cancelAnimationFrame(raf)
    raf = 0
  }

  function startAnimation() {
    if (raf) return
    raf = requestAnimationFrame(drawFrame)
  }

  function applySprite(next) {
    sprite = next
    frameIndex = 0
    lastFrameAt = 0
    loadImage()
  }

  function onPointerDown(e) {
    dragStartX = e.clientX
    dragStartY = e.clientY
    lastX = e.clientX
    lastY = e.clientY
    moved = false
    dragging = false
    stage.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (dragging) {
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      bridge.moveBy(dx, dy)
      return
    }
    if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > 4) {
      dragging = true
      moved = true
      document.body.classList.add("dragging")
      bridge.setDragging(true)
      lastX = e.clientX
      lastY = e.clientY
    }
  }

  function onPointerUp(e) {
    if (dragging) {
      dragging = false
      document.body.classList.remove("dragging")
      bridge.setDragging(false)
    } else if (!moved && e.type === "pointerup") {
      bridge.poke()
    }
  }

  bridge.onState((state) => setMood(state.mood))
  bridge.onSettings((next) => {
    settings = next
    if (next.frameMs !== sprite.frameMs) {
      sprite = { ...sprite, frameMs: next.frameMs }
    }
  })
  bridge.onSprite((next) => applySprite(next))

  loadImage()
  startAnimation()
  stage.addEventListener("pointerdown", onPointerDown)
  stage.addEventListener("pointermove", onPointerMove)
  stage.addEventListener("pointerup", onPointerUp)
  stage.addEventListener("pointercancel", onPointerUp)
})()
</script>
</body>
</html>`

  return `data:text/html,${encodeURIComponent(html)}`
}
