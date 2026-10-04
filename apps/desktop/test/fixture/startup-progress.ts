import { app, BrowserWindow, ipcMain, WebContentsView } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { desktopStartupPage, startupStatusScript, startupThemeScript } from "../../src/startup-page.js"
import { desktopErrorPage } from "../../src/error-page.js"
import { DesktopServerStartup } from "../../src/server-startup.js"
import { defaultDesktopSkinState, desktopThemeSnapshot } from "../../src/theme.js"
import { DesktopStartupOverlay } from "../../src/startup-overlay.js"

void run().catch((error) => {
  console.error(error)
  app.exit(1)
})

async function run() {
  console.log("Startup progress: waiting for Electron")
  await app.whenReady()
  console.log("Startup progress: Electron ready")
  let recoveryMode = "managed"
  let maintenanceRunning = false
  let maintenanceCalls = 0
  let cancelCalls = 0
  let diagnosticsCalls = 0
  let finishMaintenance: (() => void) | undefined
  const windowActions: string[] = []
  let windowState = { maximized: false, fullscreen: false, focused: true }
  let holdWindowState = false
  let releaseWindowState: (() => void) | undefined
  let requestedWindowState: (() => void) | undefined
  let holdToggleState = false
  let releaseToggleState: (() => void) | undefined
  let requestedToggleState: (() => void) | undefined
  ipcMain.handle("fixture.window.state", () => {
    const snapshot = windowState
    if (!holdWindowState) return snapshot
    requestedWindowState?.()
    return new Promise((resolve) => {
      releaseWindowState = () => resolve(snapshot)
    })
  })
  for (const action of ["minimize", "toggleMaximize", "close"]) {
    ipcMain.handle(`fixture.window.${action}`, () => {
      windowActions.push(action)
      if (action === "toggleMaximize") windowState = { ...windowState, maximized: !windowState.maximized }
      if (action === "toggleMaximize" && holdToggleState) {
        const snapshot = windowState
        requestedToggleState?.()
        return new Promise((resolve) => {
          releaseToggleState = () => resolve(snapshot)
        })
      }
      return windowState
    })
  }
  const status = () => ({
    mode: recoveryMode,
    maintenance: { state: maintenanceRunning ? "running" : "idle", progress: { step: 2, current: 512, total: 0 } },
  })
  ipcMain.handle("fixture.recovery.status", status)
  ipcMain.handle("fixture.recovery.restart", () => status())
  ipcMain.handle("fixture.recovery.maintenance", async () => {
    maintenanceCalls++
    maintenanceRunning = true
    await new Promise<void>((resolve) => {
      finishMaintenance = resolve
    })
    return status()
  })
  ipcMain.handle("fixture.recovery.cancelMaintenance", () => {
    cancelCalls++
    maintenanceRunning = false
    finishMaintenance?.()
    return status()
  })
  ipcMain.handle("fixture.recovery.diagnostics", () => {
    diagnosticsCalls++
    return "startup-diagnostics.tar.gz"
  })
  const window = new BrowserWindow({
    width: 700,
    height: 520,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "recovery-preload.cjs"),
    },
  })
  const iconDataUrl =
    "data:image/png;base64," +
    (await fs.readFile(path.resolve(process.env.SYNERGY_STARTUP_ICON ?? "build/icon.png"))).toString("base64")
  try {
    for (const mode of ["light", "dark"] as const) {
      await window.loadURL(
        desktopStartupPage({
          chrome: "native",
          iconDataUrl,
          theme: desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark"),
        }),
      )
      console.log(`Startup progress: ${mode} page loaded`)
      await window.webContents.executeJavaScript(
        startupStatusScript({ title: "Starting local runtime", detail: "Opening the local server." }),
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-activity]').textContent`),
        "Waiting for the first update",
        "initial copy cannot establish backend progress",
      )
      await window.webContents.executeJavaScript(
        startupStatusScript({ title: "Loading workspace", detail: "Opening your workspace.", phase: "starting" }),
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[aria-current="step"]').dataset.stage`),
        "starting",
        "a healthy first snapshot opens the workspace without requiring migration events",
      )
      let now = 0
      const startup = new DesktopServerStartup({ now: () => now })
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"storage","step":1,"stage":"scan","current":10001,"total":0,"bytes":1000}\n',
      )
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-status]').textContent`),
        "Updating saved data",
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.body.textContent.includes('Scanning saved files.')`),
        true,
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('.startup-count').textContent`),
        "10,001 items checked",
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[role="progressbar"]').getAttribute('aria-valuetext')`,
        ),
        "10,001 items checked. Total not yet known.",
      )
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"maintenance","id":1,"state":"started","operation":"vacuum","timeoutMs":900000}\n',
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"maintenance","id":1,"state":"stage","stage":"rewrite"}\n')
      await window.webContents.executeJavaScript(startupStatusScript({ ...startup.status(), elapsedMs: 301000 }))
      assert.equal(
        await window.webContents.executeJavaScript(`document.body.textContent.includes('Rebuilding the database.')`),
        true,
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-elapsed]').textContent`),
        "Waiting 5:01",
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`,
        ),
        false,
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"maintenance","id":1,"state":"completed","elapsedMs":301000}\n')
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"migration","step":9,"current":358,"total":8494,"task":"file-history"}\n',
      )
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      await window.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(document.querySelector('.startup-progress__fill').getAnimations().map(animation => animation.finished))
      })()`)
      console.log(`Startup progress: ${mode} animation settled`)
      const state = await window.webContents.executeJavaScript(`(() => {
        const bar = document.querySelector('[role="progressbar"]')
        const title = document.querySelector('[data-startup-status]')
        return { value: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext'),
          title: title.textContent, height: bar.getBoundingClientRect().height,
          titleHeight: title.getBoundingClientRect().height,
          ratio: document.querySelector('.startup-progress__fill').getBoundingClientRect().width / bar.getBoundingClientRect().width,
          animation: getComputedStyle(document.querySelector('.startup-progress__fill')).animationName }
      })()`)
      assert.equal(state.value, "4")
      assert.equal(state.text, "358 / 8,494 · 4%")
      assert.equal(state.title, "Updating saved data")
      assert.ok(state.height > 0)
      assert.ok(state.titleHeight > 1)
      assert.equal(state.animation, "none")
      assert.ok(Math.abs(state.ratio - 358 / 8494) < 0.001)
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-detail]').textContent`),
        "Preparing saved file history.",
      )
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"migration","step":16,"current":68005,"total":0,"task":"tool-history"}\n',
      )
      now = 65_000
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`,
        ),
        false,
      )
      const waiting = await window.webContents.executeJavaScript(`(() => ({
        count: document.querySelector('.startup-count').textContent,
        step: document.querySelector('[data-startup-step]').textContent,
        activity: document.querySelector('[data-startup-activity]').textContent,
        hintVisible: !document.querySelector('[data-startup-hint]').hidden,
        unknownVisible: !document.querySelector('[data-startup-unknown-total]').hidden,
        phase: document.querySelector('[aria-current="step"]').dataset.stage,
      }))()`)
      assert.equal(waiting.count, "68,005 items checked")
      assert.equal(waiting.step, "Step 16")
      assert.equal(waiting.activity, "Last progress 1:05 ago")
      assert.equal(waiting.hintVisible, true)
      assert.equal(waiting.unknownVisible, true)
      assert.equal(waiting.phase, "migration")
      assert.equal(startup.remainingMs(), 235_000)
      assert.equal(
        await window.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.startup-progress__fill')).animationPlayState`,
        ),
        "paused",
        "a silent interval does not keep presenting activity motion",
      )
      await window.webContents.executeJavaScript(
        startupStatusScript({ title: "Updating saved data", detail: startup.status().detail }),
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-activity]').textContent`),
        "Last progress 1:05 ago",
        "presentation-only updates cannot reset the progress age",
      )
      await window.webContents.executeJavaScript(startupStatusScript({ ...startup.status(), totalElapsedMs: 0 }))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-total]').textContent`),
        "Total 1:05",
        "a restarted backend clock cannot reduce the total overlay wait",
      )
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"migration","step":16,"current":68006,"total":0,"task":"tool-history"}\n',
      )
      const taskMutations = await window.webContents.executeJavaScript(`(async () => {
        let mutations = 0
        const observer = new MutationObserver(records => { mutations += records.length })
        observer.observe(document.querySelector('.startup-work__heading'), { childList: true, subtree: true })
        ${startupStatusScript(startup.status())}
        await Promise.resolve()
        observer.disconnect()
        return mutations
      })()`)
      assert.equal(taskMutations, 0, "count updates do not repeat task announcements")
      assert.equal(
        await window.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.startup-progress__fill')).animationPlayState`,
        ),
        "running",
        "accepted progress resumes the unknown-total indicator",
      )
      now += 65_000
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      const alternateMode = mode === "light" ? "dark" : "light"
      const alternateTheme = desktopThemeSnapshot(defaultDesktopSkinState(alternateMode), alternateMode === "dark")
      await window.webContents.executeJavaScript(startupThemeScript(alternateTheme))
      const switched = await window.webContents.executeJavaScript(`(() => ({
        mode: document.documentElement.dataset.startupTheme,
        text: document.documentElement.style.getPropertyValue('--startup-text'),
        count: document.querySelector('.startup-count').textContent,
        activity: document.querySelector('[data-startup-activity]').textContent,
      }))()`)
      assert.equal(switched.mode, alternateMode)
      assert.equal(switched.text, alternateTheme.colors.text)
      assert.equal(switched.count, "68,006 items checked")
      assert.equal(switched.activity, "Last progress 1:05 ago")
      await window.webContents.executeJavaScript(
        startupThemeScript(desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark")),
      )
      const indicatorVisible = await window.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const bar = document.querySelector('[role="progressbar"]').getBoundingClientRect()
        const fill = document.querySelector('.startup-progress__fill')
        const animation = fill.getAnimations()[0]
        const state = animation?.playState
        const duration = animation ? Number(animation.effect.getComputedTiming().duration) : 0
        animation?.pause()
        const visible = [0, duration / 2, duration].every(time => {
          if (animation) animation.currentTime = time
          const rect = fill.getBoundingClientRect()
          return rect.width > 0 && rect.left >= bar.left - 1 && rect.right <= bar.right + 1
        })
        if (animation) { animation.currentTime = duration / 2; if (state !== 'paused') animation.play() }
        return visible
      })()`)
      assert.equal(indicatorVisible, true, "the unknown-total indicator remains visible throughout its motion")
      if (process.env.SYNERGY_STARTUP_SCREENSHOTS) {
        await fs.mkdir(process.env.SYNERGY_STARTUP_SCREENSHOTS, { recursive: true })
        await window.webContents.executeJavaScript(
          `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        )
        await fs.writeFile(
          path.join(process.env.SYNERGY_STARTUP_SCREENSHOTS, `${mode}.png`),
          (await window.webContents.capturePage()).toPNG(),
        )
      }
      window.webContents.debugger.attach()
      await window.webContents.debugger.sendCommand("Accessibility.enable")
      await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(resolve))`)
      const accessibility: { nodes: { role: { value: string }; name?: { value: string } }[] } =
        await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree")
      assert.ok(
        accessibility.nodes.some((node) => node.role.value === "heading" && node.name?.value === "Updating saved data"),
        "the startup title remains a heading for screen-reader navigation",
      )
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      })
      assert.equal(
        await window.webContents.executeJavaScript(`matchMedia('(prefers-reduced-motion: reduce)').matches`),
        true,
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.startup-progress__fill')).animationName`,
        ),
        "none",
      )
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] })
      window.webContents.debugger.detach()
      window.setSize(320, 600)
      await window.webContents.executeJavaScript(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      )
      const narrow = await window.webContents.executeJavaScript(`(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bar: document.querySelector('[role="progressbar"]').getBoundingClientRect().width,
      }))()`)
      assert.ok(narrow.scrollWidth <= narrow.width)
      assert.ok(narrow.bar > 0)
      window.setSize(700, 520)
      window.webContents.setZoomFactor(2)
      await window.webContents.executeJavaScript(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      )
      const zoom = await window.webContents.executeJavaScript(
        `(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))()`,
      )
      assert.ok(zoom.scrollWidth <= zoom.width)
      window.webContents.setZoomFactor(1)
      await window.webContents.executeJavaScript(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('.startup-count').textContent`),
        "Waiting for progress updates",
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"recovery","current":10001}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-status]').textContent`),
        "Restoring saved work",
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('.startup-count').textContent`),
        "10,001 items checked",
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-startup-status]').textContent`),
        "Starting Synergy",
      )
      await window.loadURL(
        desktopErrorPage(
          "Synergy could not start",
          "VACUUM exceeded its waiting budget\n" + "fixture failure details\n".repeat(1000),
          desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark"),
        ),
      )
      const errorLayout = await window.webContents.executeJavaScript(`(() => {
        const title = document.querySelector('h1').getBoundingClientRect()
        const reason = document.querySelector('p').getBoundingClientRect()
        const pre = document.querySelector('pre')
        return { titleTop: title.top, reasonBottom: reason.bottom, height: innerHeight,
          scrollable: pre.scrollHeight > pre.clientHeight, bottom: pre.getBoundingClientRect().bottom }
      })()`)
      assert.ok(errorLayout.titleTop >= 0)
      assert.ok(errorLayout.reasonBottom < errorLayout.height)
      assert.ok(errorLayout.bottom <= errorLayout.height)
      assert.ok(errorLayout.scrollable)
      await window.webContents.executeJavaScript(`new Promise(resolve => {
        document.querySelector('[data-error-action="maintenance"]').click()
        const timer = setInterval(() => {
          if (!document.querySelector('[data-error-status]').textContent.includes('512 processed')) return
          clearInterval(timer); resolve()
        }, 25)
      })`)
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-error-action="retry"]').disabled`),
        true,
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[data-error-action="return"]').disabled`),
        false,
      )
      await window.webContents.executeJavaScript(`new Promise(resolve => {
        document.querySelector('[data-error-action="return"]').click()
        const timer = setInterval(() => {
          if (document.querySelector('[data-error-action="retry"]').disabled) return
          clearInterval(timer); resolve()
        }, 25)
      })`)
      await window.webContents.executeJavaScript(`new Promise(resolve => {
        document.querySelector('[data-error-action="diagnostics"]').click()
        const timer = setInterval(() => {
          if (!document.querySelector('[data-error-status]').textContent.includes('startup-diagnostics.tar.gz')) return
          clearInterval(timer); resolve()
        }, 25)
      })`)
    }
    holdWindowState = true
    const stateRequested = new Promise<void>((resolve) => {
      requestedWindowState = resolve
    })
    const overlay = new DesktopStartupOverlay({
      window,
      chrome: "custom",
      iconDataUrl,
      theme: desktopThemeSnapshot(defaultDesktopSkinState("dark"), true),
      preloadPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "recovery-preload.cjs"),
    })
    try {
      await overlay.load()
      overlay.attach()
      window.showInactive()
      const view = window.contentView.children.at(-1)
      assert.ok(view instanceof WebContentsView)
      const controls = view.webContents
      await stateRequested
      controls.focus()
      const maximizeLabel = () =>
        controls.executeJavaScript(
          `document.querySelector('[data-window-action="maximize"]').getAttribute('aria-label')`,
        )
      assert.equal(await maximizeLabel(), "Maximize")
      windowState = { ...windowState, maximized: true }
      overlay.setWindowState(windowState)
      assert.equal(await maximizeLabel(), "Restore", "native state reaches the startup view before the app is ready")
      holdWindowState = false
      releaseWindowState?.()
      await controls.executeJavaScript(`window.synergyDesktop.window.state()`)
      assert.equal(await maximizeLabel(), "Restore", "an older initial state reply cannot undo a live window update")
      console.log("Startup progress: window state checks passed")
      controls.debugger.attach()
      const press = async (key: string, code: string, keyCode: number) => {
        for (const type of ["keyDown", "keyUp"]) {
          await controls.debugger.sendCommand("Input.dispatchKeyEvent", {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
          })
        }
      }
      await press("Tab", "Tab", 9)
      assert.equal(
        await controls.executeJavaScript(`document.activeElement.dataset.windowAction`),
        "minimize",
        "window controls are reachable in order by keyboard",
      )
      const keyboardFocus = await controls.executeJavaScript(`getComputedStyle(document.activeElement).boxShadow`)
      assert.notEqual(keyboardFocus, "none", "keyboard focus remains visible")
      await press("Enter", "Enter", 13)
      await press("Tab", "Tab", 9)
      assert.equal(await controls.executeJavaScript(`document.activeElement.dataset.windowAction`), "maximize")
      await press(" ", "Space", 32)
      const actionDeadline = Date.now() + 2000
      while (Date.now() < actionDeadline && (await maximizeLabel()) !== "Maximize")
        await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(await maximizeLabel(), "Maximize", "the keyboard action updates the maximize label")
      await press("Tab", "Tab", 9)
      assert.equal(await controls.executeJavaScript(`document.activeElement.dataset.windowAction`), "close")
      await press("Enter", "Enter", 13)
      await controls.executeJavaScript(`new Promise(resolve => requestAnimationFrame(resolve))`)
      assert.deepEqual(windowActions, ["minimize", "toggleMaximize", "close"])
      holdToggleState = true
      const toggleRequested = new Promise<void>((resolve) => {
        requestedToggleState = resolve
      })
      await controls.executeJavaScript(`document.querySelector('[data-window-action="maximize"]').click()`)
      await toggleRequested
      windowState = { ...windowState, maximized: false }
      overlay.setWindowState(windowState)
      holdToggleState = false
      releaseToggleState?.()
      await controls.executeJavaScript(`window.synergyDesktop.window.state()`)
      assert.equal(await maximizeLabel(), "Maximize", "an older action reply cannot undo a live window update")
      controls.debugger.detach()
    } finally {
      await overlay.dismiss()
    }
    assert.equal(maintenanceCalls, 2)
    assert.equal(cancelCalls, 2)
    assert.equal(diagnosticsCalls, 2)
    recoveryMode = "external"
    await window.loadURL(
      desktopErrorPage(
        "Cannot connect",
        "external server unavailable",
        desktopThemeSnapshot(defaultDesktopSkinState("light"), false),
      ),
    )
    await window.webContents.executeJavaScript(`new Promise(resolve => {
      const timer = setInterval(() => {
        if (!document.querySelector('[data-error-action="maintenance"]').disabled) return
        clearInterval(timer); resolve()
      }, 25)
    })`)
    assert.equal(
      await window.webContents.executeJavaScript(`document.querySelector('[data-error-action="retry"]').disabled`),
      false,
    )
    console.log("Startup progress DOM checks passed")
  } finally {
    window.destroy()
    app.quit()
  }
}
