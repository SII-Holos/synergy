# Sandbox UI Guide

Sandbox UI is used for plugin surfaces that should not run as trusted host imports.

Declare a sandboxed panel or settings section:

```jsonc
{
  "contributes": {
    "ui": {
      "entry": "./dist/ui/index.js",
      "workspacePanels": [
        {
          "id": "panel",
          "label": "Panel",
          "icon": "layout-panel-left",
          "sandbox": true,
          "sandboxEntry": "./ui/index.js",
        },
      ],
    },
  },
  "permissions": {
    "ui": {
      "workspacePanels": true,
      "sandboxIframe": true,
    },
  },
}
```

The host records the surface and exposes the sandbox shell at:

```text
/plugin/:pluginId/sandbox/:panelId
```

Static JS, CSS, SVG, and asset files are served from:

```text
/plugin/assets/:pluginId/:version/*
```

The runtime plugin still follows the normal object descriptor contract. Sandbox UI does not change server-side permission enforcement.
