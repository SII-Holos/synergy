import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron"
import { DESKTOP_PRODUCT_NAME, type DesktopChannel } from "./identity.js"

export function installAppMenu(options: {
  channel: DesktopChannel
  debug: boolean
  getMainWindow(): BrowserWindow | null
  getZoomFactor(): number
  setZoomFactor(factor: number): void
}): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null)
    return
  }

  const appMenu: MenuItemConstructorOptions[] = [
    {
      label: DESKTOP_PRODUCT_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ]

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        click: () => options.setZoomFactor(1),
      },
      {
        label: "Zoom In",
        accelerator: "CmdOrCtrl+Plus",
        click: () => options.setZoomFactor(zoomStep(options.getZoomFactor(), 0.25)),
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => options.setZoomFactor(zoomStep(options.getZoomFactor(), -0.25)),
      },
      ...(options.debug
        ? ([
            { type: "separator" },
            {
              label: "Reload",
              accelerator: "CmdOrCtrl+R",
              click: () => options.getMainWindow()?.webContents.reload(),
            },
            {
              label: "Toggle Developer Tools",
              accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
              click: () => options.getMainWindow()?.webContents.toggleDevTools(),
            },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    { role: "editMenu" },
    viewMenu,
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: `${DESKTOP_PRODUCT_NAME} ${options.channel}`,
          enabled: false,
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({ applicationName: DESKTOP_PRODUCT_NAME })
}

function zoomStep(factor: number, delta: number): number {
  return Math.min(2, Math.max(0.5, Math.round((factor + delta) * 100) / 100))
}
