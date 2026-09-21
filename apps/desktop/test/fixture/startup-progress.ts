import { app, BrowserWindow, ipcMain } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { desktopStartupPage, startupStatusScript } from "../../src/startup-page.js"
import { desktopErrorPage } from "../../src/error-page.js"
import { DesktopServerStartup } from "../../src/server-startup.js"
import { defaultDesktopSkinState, desktopThemeSnapshot } from "../../src/theme.js"

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
  try {
    for (const mode of ["light", "dark"] as const) {
      await window.loadURL(
        desktopStartupPage({
          chrome: "native",
          theme: desktopThemeSnapshot(defaultDesktopSkinState(mode), mode === "dark"),
        }),
      )
      console.log(`Startup progress: ${mode} page loaded`)
      const startup = new DesktopServerStartup()
      startup.receive(
        'SYNERGY_STARTUP_V1 {"phase":"storage","step":1,"stage":"scan","current":10001,"total":0,"bytes":1000}\n',
      )
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[role="status"]').textContent`),
        "Updating saved data",
      )
      assert.equal(
        await window.webContents.executeJavaScript(`document.body.textContent.includes('Scanning saved files. 10001')`),
        true,
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
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":358,"total":8494}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      await window.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(document.querySelector('.startup-progress__fill').getAnimations().map(animation => animation.finished))
      })()`)
      console.log(`Startup progress: ${mode} animation settled`)
      const state = await window.webContents.executeJavaScript(`(() => {
        const bar = document.querySelector('[role="progressbar"]')
        const title = document.querySelector('[role="status"]')
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
      if (process.env.SYNERGY_STARTUP_SCREENSHOTS) {
        await fs.mkdir(process.env.SYNERGY_STARTUP_SCREENSHOTS, { recursive: true })
        await fs.writeFile(
          path.join(process.env.SYNERGY_STARTUP_SCREENSHOTS, `${mode}.png`),
          (await window.webContents.capturePage()).toPNG(),
        )
      }
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"migration","step":2,"current":0,"total":0}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`,
        ),
        false,
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('.startup-count').textContent`),
        "",
      )
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"recovery","current":10001}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[role="status"]').textContent`),
        "Restoring saved work",
      )
      assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('10001')`), true)
      startup.receive('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
      await window.webContents.executeJavaScript(startupStatusScript(startup.status()))
      assert.equal(
        await window.webContents.executeJavaScript(`document.querySelector('[role="status"]').textContent`),
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
