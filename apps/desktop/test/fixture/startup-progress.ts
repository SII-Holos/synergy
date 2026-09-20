import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
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
  const window = new BrowserWindow({
    width: 700,
    height: 520,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
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
    }
    console.log("Startup progress DOM checks passed")
  } finally {
    window.destroy()
    app.quit()
  }
}
