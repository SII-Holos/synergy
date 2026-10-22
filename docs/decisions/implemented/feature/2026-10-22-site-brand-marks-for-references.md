# Decision Record: Site brand marks for web references

Status: implemented

## Problem

Every web reference in a message rendered the same neutral globe. `resourceDisplay` special-cased exactly one host — `github.com` — and returned the `browser.main` semantic token for everything else, so an arXiv paper, a Notion page, a Figma file and an unknown blog were visually indistinguishable. In a transcript where citations carry much of the meaning, the icon cost attention without conveying any: readers had to parse the host text to tell a paper from a design file.

## Decision

A recognized host renders its owner's brand mark; any other host keeps the globe. The mark set is vendored from Simple Icons 13.0.0 (CC0) into `packages/ui/src/assets/icons/site`, and the host table lives in `packages/ui/src/components/site-icons/model.ts` next to the generated name union.

The icons reuse the host's existing sprite pipeline rather than adding a parallel one: `packages/ui/vite.config.ts` gains a third `iconsSpritesheet` target over `src/assets/icons/site`, producing `src/components/site-icons/{sprite.svg,types.ts}` exactly as the file-type and provider targets do. `SiteIcon` mirrors `FileIcon` and `ProviderIcon`: an inline `<svg>` with `<use href="sprite#name">`, sized by CSS. Names are a closed union generated from the sprite, so a mark cannot reference a missing symbol.

`resourceDisplay` takes one brand lookup for a URL and emits exactly one visual — `site` when the host is known, otherwise the `browser.main` token. It never emits both.

Host matching is a label-suffix lookup over a map, never a substring test. Each entry is registered on the site's own registrable domain and resolves for its subdomains, so `en.wikipedia.org` and `api.github.com` inherit without an entry per subdomain, while `github.example.org`, `github.com.evil.test` and `notgithub.com` resolve to nothing. Domain strings that only host user content (`*.vercel.app`, `*.netlify.app`) are deliberately absent: a deployment under someone's own domain is not the platform's site.

Fill color is resolved once at vendoring time by one rule. The glyph sits on `--surface-base`, which is `#FFFFFF` in the light theme and `#242424` in the dark one, and a single static fill is drawn on either, so a mark must clear 3.1:1 against both (3.0 alone loses to 8-bit rounding). An official brand color already inside that range is used unchanged; a chromatic brand outside it has its HSL lightness moved just far enough to re-enter the range, which preserves the hue that makes the mark recognizable. Brands whose official mark is black or near-black are the exception: their identity is the silhouette, so they are pinned to `currentColor` and follow the surrounding text color rather than being recolored into a hue the owner never used. `packages/ui/src/assets/icons/simple-icons-CC0.txt` records the source, license and this rule.

## Alternatives considered

**Hand-draw the marks as Lucide icon nodes inside `icon.tsx`.** Rejected because the sprite pipeline already exists for exactly this job, and putting dozens of brand geometries into the shared component module would grow the main bundle with paths most sessions never render.

**Use one monochrome treatment for every mark.** Rejected because a 1em glyph in body text carries no shape detail at that size; color is the only cue that survives, so flattening every brand to text color restores the original problem in a different form.

**Ask each owner's site for a favicon at render time.** Rejected because it turns a local render into a network request per host, leaks the set of referenced hosts to third parties, and makes the icon depend on a remote service staying reachable and unchanged.

**Fall back to a colored initial block for unknown hosts.** Rejected because it invents an identity the site does not have, degrades badly for Chinese hostnames, and would need its own component and color assignment; the neutral globe states "a website" without guessing.

**Resolve brands by matching a substring of the hostname.** Ruled out on correctness: `github.example.org` and `github.com@hostile.test` would inherit the GitHub mark from a host its owner does not control. The label-suffix map makes that unrepresentable.

## Consequences

The reference icon now distinguishes a paper, a design file, a repository and an unknown blog at a glance, using the same resolution path Markdown citations already take, so nothing in the open/preview flow changes. The sprite adds 48 symbols and about 57 KB of SVG to the module graph, loaded once per window; one glyph renders only when a transcript actually cites that host, and the host table costs a few hundred bytes.

Colors are adjusted for nine brands whose official value fell outside the legible band (for example arXiv `#b31b1b` → `#da2121`, LinkedIn `#0a66c2` → `#0b6fd2`), so those marks are not byte-identical to the owner's published swatch — a deliberate trade for legibility on both themes. Twenty-two marks follow the text color instead of their brand color for the same reason. Adding a site means dropping one SVG into the asset directory and one line into the host table; the sprite and union regenerate on the next dev/build run. Coverage is limited to hosts in that table, and a site Simple Icons does not carry stays a globe rather than being approximated.

Validation covers the sprite/type/asset parity, that every registered host resolves to an existing symbol and every symbol is reachable, subdomain inheritance, lookalike-host rejection, both-surface contrast for every fixed fill, the monochrome exceptions, the single-visual invariant, and a real isolated runtime where a seeded transcript rendered 23 brand marks and kept the globe for an unknown host, a lookalike host and an unlisted site.
