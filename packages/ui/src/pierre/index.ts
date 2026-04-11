import { DiffLineAnnotation, FileContents, FileDiffOptions } from "@pierre/diffs"
import { ComponentProps } from "solid-js"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diffs] {
  --diffs-bg: light-dark(var(--diffs-light-bg), var(--diffs-dark-bg));
  --diffs-bg-buffer: var(--diffs-bg-buffer-override, light-dark( color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer))));
  --diffs-bg-hover: var(--diffs-bg-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 97%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-mixer))));
  --diffs-bg-context: var(--diffs-bg-context-override, light-dark( color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92.5%, var(--diffs-mixer))));
  --diffs-bg-separator: var(--diffs-bg-separator-override, light-dark( color-mix(in lab, var(--diffs-bg) 96%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-mixer))));
  --diffs-fg: light-dark(var(--diffs-light), var(--diffs-dark));
  --diffs-fg-number: var(--diffs-fg-number-override, light-dark(color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg)), color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))));
  --diffs-deletion-base: var(--diffs-deletion-color-override, light-dark(var(--diffs-light-deletion-color, var(--diffs-deletion-color, rgb(255, 0, 0))), var(--diffs-dark-deletion-color, var(--diffs-deletion-color, rgb(255, 0, 0)))));
  --diffs-addition-base: var(--diffs-addition-color-override, light-dark(var(--diffs-light-addition-color, var(--diffs-addition-color, rgb(0, 255, 0))), var(--diffs-dark-addition-color, var(--diffs-addition-color, rgb(0, 255, 0)))));
  --diffs-modified-base: var(--diffs-modified-color-override, light-dark(var(--diffs-light-modified-color, var(--diffs-modified-color, rgb(0, 0, 255))), var(--diffs-dark-modified-color, var(--diffs-modified-color, rgb(0, 0, 255)))));
  --diffs-bg-deletion: var(--diffs-bg-deletion-override, light-dark( color-mix(in lab, var(--diffs-bg) 98%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-number: var(--diffs-bg-deletion-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-hover: var(--diffs-bg-deletion-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-emphasis: var(--diffs-bg-deletion-emphasis-override, light-dark(rgb(from var(--diffs-deletion-base) r g b / 0.7), rgb(from var(--diffs-deletion-base) r g b / 0.1)));
  --diffs-bg-addition: var(--diffs-bg-addition-override, light-dark( color-mix(in lab, var(--diffs-bg) 98%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-addition-base))));
  --diffs-bg-addition-number: var(--diffs-bg-addition-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-addition-base))));
  --diffs-bg-addition-hover: var(--diffs-bg-addition-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-addition-base))));
  --diffs-bg-addition-emphasis: var(--diffs-bg-addition-emphasis-override, light-dark(rgb(from var(--diffs-addition-base) r g b / 0.07), rgb(from var(--diffs-addition-base) r g b / 0.1)));
  --diffs-selection-base: var(--diffs-modified-base);
  --diffs-selection-number-fg: light-dark( color-mix(in lab, var(--diffs-selection-base) 65%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-selection-base) 75%, var(--diffs-mixer)));
  --diffs-bg-selection: var(--diffs-bg-selection-override, light-dark( color-mix(in lab, var(--diffs-bg) 82%, var(--diffs-selection-base)), color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-selection-base))));
  --diffs-bg-selection-number: var(--diffs-bg-selection-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-selection-base)), color-mix(in lab, var(--diffs-bg) 60%, var(--diffs-selection-base))));
}

[data-diffs-header],
[data-diffs] {
  [data-separator-wrapper] {
    margin: 0 !important;
    border-radius: 0 !important;
  }
  [data-expand-button] {
    width: 6.5ch !important;
    height: 24px !important;
    justify-content: end !important;
    padding-left: 3ch !important;
    padding-inline: 1ch !important;
  }
  [data-separator-multi-button] {
    grid-template-rows: 10px 10px !important;
    [data-expand-button] {
      height: 12px !important;
    }
  }
  [data-separator-content] {
    height: 24px !important;
  }
  [data-code] {
    overflow-x: auto !important;
  }
}`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: "Synergy",
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    disableBackground: false,
    expansionLineCount: 20,
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}
