# Decision Record: Include the Web HTML entry in style generation

Status: implemented

## Problem

The Web HTML entry declares the viewport height of the application root. Omitting that entry from Tailwind source discovery drops its height utility from production CSS, allowing a long sidebar to expand the entire document. Composer focus can then scroll the document and move navigation outside the viewport.

## Decision

The Web stylesheet explicitly includes its HTML entry as a Tailwind source. The production build test mounts the emitted root markup with emitted CSS and overflowing sidebar content, then checks viewport height, composer focus, and independent list scrolling in both color schemes and at multiple window heights.

## Alternatives considered

**Patch sidebar height or scrolling.** The sidebar already has an independent scroll container. Local constraints would conceal the missing application-root style and leave other HTML-only utilities outside source discovery.

**Expand shared UI scanning to the entire repository.** This includes unrelated sources and couples shared style generation to more repository content. The HTML entry belongs to the Web app and can be declared beside its stylesheet.

## Consequences

The root retains its viewport constraint after package moves without changing sidebar behavior or stored project data. A browser layout regression check adds a small amount of work to the existing production-build suite and uses the emitted entry markup so test literals cannot conceal a missing scan input.
