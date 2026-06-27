import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron"
import { DESKTOP_PRODUCT_NAME, type DesktopChannel } from "./identity.js"

export function installAppMenu(options: {
  channel: DesktopChannel
  debug: boolean
  getMainWindow(): BrowserWindow | null
}): void {
  const appMenu: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
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
      : []

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
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
