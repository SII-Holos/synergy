# Settings, Themes, Icons, Routes, And Commands

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

## Routes

```jsonc
{
  "routes": [
    {
      "path": "/plugins/my-plugin",
      "entry": "default",
      "label": "My Plugin",
      "icon": "sparkles",
    },
  ],
}
```

Routes are registered as plugin routes and load from the plugin UI bundle.

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
synergy plugin create my-theme --template theme-icon
synergy plugin build
synergy plugin pack
```
