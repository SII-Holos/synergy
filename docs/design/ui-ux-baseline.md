# UI/UX Baseline

This document is the review baseline for the Synergy frontend redesign beginning on 2026-09-05. It records the current product surfaces, the user questions each surface must answer, and the visual risks to verify before and after each UI pull request.

## Product target

Synergy should feel like a quiet, capable, precise workbench for running agents, preserving context, and returning to active work without losing orientation.

The primary visual subject is the current work: project, session, task state, and required user action. Navigation and controls support that subject instead of competing with it.

## Current surface inventory

| Surface | Primary user question | Main implementation area | Baseline risks |
| --- | --- | --- | --- |
| Home | Where should I resume work? | `packages/app/src/pages/home.tsx` | Weak prioritization between recent work, projects, and secondary entry points |
| Directory layout | Which project and sessions are active? | `packages/app/src/pages/layout.tsx`, `packages/app/src/pages/directory-layout.tsx` | Project context and session navigation can read as one undifferentiated navigation column |
| Session | What is the agent doing and what is the result? | `packages/app/src/pages/session.tsx`, `packages/ui/src/components/session-turn.tsx` | Tool activity, messages, status, and controls compete for attention |
| Session activity | Which work is ordinary progress and which needs intervention? | `packages/ui/src/components/session-turn-activity.tsx`, `packages/ui/src/components/message-part.tsx` | Repeated cards, borders, and status treatments create visual noise |
| Composer | What can I send or control right now? | `packages/app/src/components/prompt-input/` | Advanced controls can make the primary input surface feel crowded |
| Desktop chrome | Where is the application boundary and which window actions are available? | `packages/app/src/components/app-shell/desktop-window-chrome.tsx` | Window chrome and product chrome can compete for the same top-row space |
| Sidebar and mobile drawer | How do I change project, session, or workspace? | `packages/app/src/components/app-shell/` | Global navigation, project context, recent sessions, and actions have overlapping responsibilities |
| Notes | What knowledge am I reading or editing? | `packages/app/src/components/notes/` | Document editing and application chrome may not share a stable surface hierarchy |
| Blueprints | What plan is active and what happens next? | `packages/app/src/components/blueprints/` | Blueprint identity can be visually close to ordinary notes or passive list cards |
| Workbench | Which tool or document is currently open? | `packages/app/src/components/workspace/` | Workbench panels can feel like separate applications |
| Settings | Which product area am I configuring? | `packages/app/src/components/settings/` | Form shells and low-frequency options can create dense administrative layouts |
| Marketplace and plugins | What can I install, enable, or configure? | `packages/app/src/components/plugin/` | Plugin-owned surfaces can diverge from the host visual language |
| Error and connection states | What failed, and what can I do? | `packages/app/src/pages/error.tsx`, `packages/app/src/components/app-shell/connection-banner.tsx` | Error, offline, and permission states need consistent priority and recovery actions |

## State coverage matrix

Every visual PR must review these states for each affected surface:

| State family | Required cases |
| --- | --- |
| Navigation | no project, project selected, session selected, unread session, narrow layout |
| Session | empty, idle, running, waiting, completed, failed, disconnected |
| Tool activity | collapsed, expanded, running, success, error, long output |
| User action | default, hover, focus-visible, pressed, disabled, pending |
| Data | loading, empty, stale or reconnecting, partially loaded |
| Theme | light, dark, same-mode theme switch |
| Layout | desktop, narrow desktop, mobile drawer, keyboard-only navigation |
| Motion | normal motion, reduced motion |

## Initial observations

1. Surface hierarchy is the highest-leverage issue: ordinary content, cards, tool output, dialogs, and floating controls need fewer competing containers.
2. The shell has several legitimate navigation responsibilities, but their grouping is not yet a sufficiently stable mental model for project, session, workspace, and global settings.
3. Session output is a work record rather than a chat transcript; ordinary messages should read as content while tool activity should read as secondary progress with escalation only for errors or required actions.
4. The composer is the primary work surface and should expose advanced controls progressively instead of showing every capability at the same visual level.
5. The existing semantic theme contract is a strong foundation; the redesign should first improve hierarchy, density, and state expression rather than replacing the palette.
6. Notes, Blueprints, Workbench, Settings, and plugin surfaces need shared shell and toolbar rules so that entering a new workspace does not feel like entering a different product.

## Screenshot capture set

The following captures are the required comparison set. The first implementation pass should populate these with dated screenshots from an isolated development instance without changing the user's active Synergy runtime.

| ID | Capture |
| --- | --- |
| H-01 | Home, light, wide desktop |
| H-02 | Home, dark, wide desktop |
| N-01 | Project with populated session list, light |
| N-02 | Project with selected session and unread state, dark |
| S-01 | Session with ordinary conversation |
| S-02 | Session with running tool activity |
| S-03 | Session with permission request |
| S-04 | Session with error and recovery action |
| S-05 | Session with long tool output and expanded detail |
| C-01 | Composer empty and focused |
| C-02 | Composer with attachment and advanced controls |
| C-03 | Composer while agent is running |
| W-01 | Notes detail and editing surface |
| W-02 | Blueprint detail and active run state |
| W-03 | Workbench or Browser surface |
| A-01 | Settings landing page |
| A-02 | Plugin marketplace and plugin settings |
| M-01 | Mobile drawer, 375px |
| M-02 | Mobile session, 375px |
| E-01 | Connection or server error |

## Review questions

Each PR reviewer should answer these questions using the affected screenshots and interaction path:

1. Is the current project and current session identifiable within three seconds?
2. Is the primary work content visually stronger than navigation and secondary controls?
3. Can ordinary progress be distinguished from states that require user intervention?
4. Are any borders, cards, badges, or buttons present only because a component has a feature rather than because the user needs a boundary?
5. Do light, dark, desktop, mobile, focus, error, and reduced-motion states preserve the same information hierarchy?
6. Does the surface look like Synergy rather than a collection of independently styled components?

## Out of scope for the baseline

This baseline does not change routes, server contracts, session data, plugin contracts, model behavior, or the active installed Synergy runtime.
