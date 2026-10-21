# Decision Record: Compact workflow and attachment actions within their panes

Status: implemented

## Problem

Blueprint offer buttons can wrap Chinese labels inside a fixed-height row. Attachment preview actions reserve space for several long labels, squeezing filenames and splitting MIME/size metadata even in a desktop split pane. Viewport width does not describe the space available to either control.

## Decision

The Blueprint offer owns an inline-size query container bounded by its available width. At 30rem and below its actions use icons only. The title may truncate, while Tooltip triggers retain their full hit areas and labels never wrap.

The shared attachment reader uses its named query container to hide action labels at 64rem and below. Source and Preview remain labeled mode choices. File identity and actions occupy separate rows at 520px and below. Filename and metadata truncate within their own space; icons and action targets do not shrink. Touch targets expand without removing any action.

Both surfaces retain existing localized accessible names or apply the existing action descriptor as the name and Tooltip. Download remains a native link to the original attachment. Opening behavior, preview sandboxing and workflow state are unchanged.

## Alternatives considered

**Viewport media queries.** A large window can contain a narrow conversation or resource pane, so viewport-based adaptation misses the reported layout.

**Only prohibit wrapping.** Whole labels would still consume most of a narrow toolbar and leave little room for the resource identity.

**Always remove labels or move all actions into a menu.** This gives up useful wide-pane labels or adds an extra interaction when the existing direct icons fit.

## Consequences

Compact panes prioritize the resource identity and direct actions over permanently visible explanations. Pointer and keyboard users can recover those explanations through Tooltips; accessible names remain available independently of visible labels. Real browser regressions resize panes inside a fixed wide viewport across English, Chinese, expanded translations and both color schemes, retaining existing attachment identity and download tests.

PNG and SVG image cases exercise the same action row independently of HTML's view-mode controls. The toolbar fixture is compiled before serving so development dependency optimization cannot replace the page during multi-format navigation. Captured-message loading and retry still exercise the generated client over intercepted HTTP requests.
