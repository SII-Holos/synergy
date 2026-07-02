# Settings, Themes, Icons, App Routes, And Commands

These surfaces are declared under `contributes.ui` and registered by the Web plugin host.

## Settings

```jsonc
{
  "settings": [
    {
      "id": "main",
      "label": "My Plugin",
      "icon": "settings",
      "group": "plugins",
      "exportName": "SettingsPanel",
    },
  ],
}
```

## Themes

```jsonc
{
  "themes": [
    {
      "id": "my-theme",
      "label": "My Theme",
      "path": "./themes/default.css",
    },
  ],
}
```

Theme files are copied into `dist/themes/` during build and registered with a CSS URL.

## Icons

```jsonc
{
  "icons": [
    {
      "name": "my-logo",
      "path": "./icons/logo.svg",
    },
  ],
}
```

Icon SVG files are copied into `dist/icons/` and fetched by the host.

## App Routes

```jsonc
{
  "appRoutes": [
    {
      "id": "details",
      "label": "My Plugin",
      "icon": "sparkles",
      "entry": "./dist/ui/details.js",
      "exportName": "default",
    },
  ],
}
```

App routes are registered under `/plugins/routes/:pluginId/:routeId` and load from the route `entry` or the shared `contributes.ui.entry`. They do not automatically create sidebar entries; use `appPanels` for a top-level sidebar panel.

## Commands

```jsonc
{
  "commands": [
    {
      "id": "refresh",
      "label": "Refresh",
      "description": "Refresh plugin data",
      "icon": "refresh-cw",
      "exportName": "refreshCommand",
    },
  ],
}
```

Command exports receive host context and may perform plugin UI actions.

## Template

```bash
synergy-plugin create my-theme --template theme-icon
synergy-plugin build
synergy-plugin pack
```
