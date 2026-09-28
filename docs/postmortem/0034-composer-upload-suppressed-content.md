# Composer uploads suppressed attachment content

## Executive summary

Actual Desktop acceptance found that uploading a text file produced a valid managed attachment but delivered only its filename to the model. The composer invented a summary policy that the server treated as an explicit instruction to omit content. Backend tests using ordinary inputs and frontend tests expecting that summary both passed independently. Product tests must follow uploaded bytes through the real composer to the provider request.

## Summary

Text, JSON, PDF and Office uploads shared the non-image submission branch. Upload storage and the visible attachment card worked; preparation skipped decoding or extraction because the input already carried a summary policy. A random identifier contained only in an uploaded text file did not reach the model.

## Timeline

- On 2026-09-28, isolated production Desktop acceptance failed its first attachment-recognition check.
- The saved input retained the correct managed bytes but its provider request contained only the attachment summary.
- Focused payload regressions reproduced the policy override for images and four document MIME types before the composer fix.

## Root cause

The frontend treated model policy as presentation metadata. The backend correctly interpreted an explicit summary as intentional content exclusion. Existing frontend tests encoded the incorrect payload, while backend extraction tests did not pass through the composer.

## Guardrails added

- [Composer payload tests](../../apps/web/test/components/prompt-input/attachments.test.ts) preserve file identity and metadata without overriding server preparation.
- [Product acceptance](../../packages/presets/test/acceptance/product-ui.test.ts) follows real uploaded bytes through the actual Desktop shell.
- The [frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) requires provider-visible content checks; the [decision](../decisions/implemented/bug-fix/2026-09-28-composer-attachment-policy.md) keeps policy ownership in one place.

## Lessons

Two individually correct layers can still disagree on the meaning of a field. An uploaded file's storage, presentation and model-visible content require separate observations.
