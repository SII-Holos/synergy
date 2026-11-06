# Decision Record: Browser data dialog layout and action targets

Status: implemented

## Problem

Browser settings presented action rows whose title and description were inert; only the trailing control opened the dialog. Import also stacked the shared dialog, settings wrapper and form insets, leaving excessive whitespace and misaligning the destination picker with the source field. Nested scrolling could hide the footer in short windows.

## Decision

Each Browser settings action uses one shared button spanning its title, description and decorative trailing cue. It retains focus while lazy content loads, ignores repeated activation during loading and returns focus after dismissal. The description remains associated with the button for assistive technology.

The existing import form owns its content inset and scrolling body. Profile-based entry supplies its destination picker inside that body, aligned with the source picker. Footer actions remain outside the scrolling body. Password management uses the same single inset without changing context ownership or credential handling.

## Alternatives considered

**Add a click handler to the settings row around its existing button.** Rejected because it creates competing targets and requires custom keyboard semantics. A single native button makes the whole visible action behave consistently.

**Shrink the dialog or apply negative margins to the form.** Rejected because it preserves nested padding and scrolling ownership. Removing duplicate wrappers fixes both settings and standalone import layout without changing the shared dialog defaults.

## Consequences

The import form accepts an optional destination field, while its data operations and cancellation semantics stay unchanged. Rendered tests cover text activation, keyboard reopening, focus return, aligned insets and reachable actions across wide, short, narrow and RTL layouts in both themes. The shared dialog remains responsible for modal behavior; the form owns only its interior layout.
