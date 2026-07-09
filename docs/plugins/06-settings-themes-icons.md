# Settings, Themes, Icons, Navigation, And Commands

These surfaces are declared under `contributes.ui` and registered by the Web plugin host. Any UI contribution requires `permissions.ui: true`.

## Settings

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "settings": [
        {
          "id": "main",
          "label": "My Plugin",
          "icon": "settings",
          "group": "plugins",
          "exportName": "SettingsPanel",
        },
      ],
    },
  },
}
```

Settings sections without `formSchema` render a Solid component from the shared UI entry. Declarative `formSchema` settings can render without a UI entry.

## Themes

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "themes": [
        {
          "id": "my-theme",
          "label": "My Theme",
          "path": "./themes/default.css",
        },
      ],
    },
  },
}
```

Theme files are copied into `dist/themes/` during build and registered with a CSS URL.

## Icons

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "icons": [
        {
          "name": "my-logo",
          "path": "./icons/logo.svg",
        },
      ],
    },
  },
}
```

Icon SVG files are copied into `dist/icons/` and fetched by the host.

## Navigation

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "navigation": [
        {
          "id": "details",
          "label": "My Plugin",
          "icon": "sparkles",
          "placement": "sidebar",
          "exportName": "DetailsPage",
        },
      ],
    },
  },
}
```

Navigation entries render at `/plugins/:pluginId/:navigationId`. `placement: "sidebar"` also contributes a top-level sidebar button; `placement: "page"` contributes only the page route.

## Commands

```jsonc
{
  "permissions": {
    "ui": true,
  },
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "minUIApiVersion": "3.0",
      "commands": [
        {
          "id": "refresh",
          "label": "Refresh",
          "description": "Refresh plugin data",
          "icon": "refresh-cw",
          "exportName": "refreshCommand",
        },
      ],
    },
  },
}
```

Command exports receive host context and may perform plugin UI actions.

## Template

```bash
synergy-plugin create my-theme --template theme-icon
synergy-plugin build
synergy-plugin pack
```
