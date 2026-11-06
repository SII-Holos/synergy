# Decision Record: Diagnostic and usage surface hierarchy

Status: implemented

## Problem

Performance resource metrics inherit the complete summary-card border even after their layout changes to rows. The grouping grid retains an enclosing frame, an obsolete direct-child selector misses the new group wrappers, and default grid stretching gives short groups the tallest group's height. Usage statistics similarly combine filled section containers, inner chart surfaces and boxed supporting values, obscuring information hierarchy.

The existing Performance browser fixture lacks the real theme provider. Its unresolved border tokens produce zero computed border widths, so it does not expose the residual frames.

## Decision

Performance renders resource metrics through an explicit row variant without the summary-card class. Resource groups have natural heights, consistent gaps and label/value alignment, with source and coverage on a supporting line. The four primary summary cards and independently readable chart cards remain. The toolbar and resource grouping grid have no enclosing frame.

Usage overview metrics retain one card surface each. Trends, activity, token composition and code changes use the page canvas, section headings and weak separators. Peak values, legends and code counters remain unframed; heatmap cells and a proportional code-composition bar retain their data-encoding role. The code-flow summary keeps the total changed-line description without repeating the net-growth counter. Container queries adapt overview, code and token layouts to the actual content width, and dense hourly data scrolls locally.

The standing contract lives in [the product specification](../../../../apps/web/PRODUCT.md#feature-pages). This refines the presentation layer of [the feature-page decision](../feature/2026-10-01-feature-page-optimization.md) without changing snapshot ownership, accounting, request boundaries or data contracts.

Browser regressions use the actual ThemeProvider, workbench roots, components and CSS. They measure complete border sides, painted ancestor layers, natural group heights and available-width behavior in light and dark modes while exercising the existing range controls and preserving unavailable-versus-zero and memory-provenance assertions.

## Alternatives considered

**More scoped CSS overrides.** Resetting only selected borders or fills leaves the original card contract and dead selectors in place, making the next layout change fragile.

**Removing all cards and data boundaries.** Primary summary cards remain useful independent objects, while heatmap cell boundaries encode activity. Removing those as well would flatten useful distinctions.

## Consequences

The page hierarchy relies more on spacing and typography and has fewer independently boxed supporting values. Resource groups no longer align their bottom edges when their row counts differ. Existing metrics, chart datasets, tooltips, snapshot state and range selection remain accessible without a new backend API or shared component system.

Visual tests must provide the real theme and layout context and allow chart resize to settle. They distinguish decorative ancestor frames from meaningful chart marks and locally scrolling data regions; component evidence is supplemented with whole-page production-build inspection.
