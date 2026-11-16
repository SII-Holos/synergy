# Organization controls overrode shared keyboard focus

## Executive summary

Complete Web verification found local focus outlines on organization controls. Actual computed-style regression then showed that removing the outlines alone left publication actions without a visible keyboard cue. Their unlayered background shorthand overrode the shared focus fill; nested label colors also overrode its forced-color foreground.

## Summary

Connection disclosures and publication buttons are ordinary native action controls. They should receive the shared neutral focus surface and system colors without adding another perimeter or palette. Their page-specific styles bypassed the layer ordering that protects shared controls.

## Timeline

The complete package run rejected both outline declarations. A regression importing the actual organization styles reproduced unchanged publication surfaces on focus in light and dark themes. Moving their resting and selected paints into the components layer restored the fill, after which forced-color checks independently exposed the nested label colors.

## Root cause

A shared selector matching an element does not establish that its paint wins the cascade. An equal-specificity later background shorthand resets the background image, while hover and selected selectors have higher specificity. Explicit child text colors also outrank an inherited system foreground.

## Guardrails

Publication paint uses the existing components layer. The shared unlayered focus owner supplies the cue; focused rich labels inherit its foreground in forced colors. Connection disclosure rounding remains part of its resting style. The existing browser suite covers actual control classes and nested labels across light, dark, selected, hover and forced-color states, alongside unchanged geometry and perimeter checks. No local focus palette or relaxed assertion is introduced.

## Lessons

Check the actual component cascade and nested text, not only the presence of a shared selector. Removing an unwanted outline must preserve a visible keyboard cue.
