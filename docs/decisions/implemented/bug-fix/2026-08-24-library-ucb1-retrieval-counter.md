# Decision Record: UCB1 recall exploration counts actual pulls, not reward updates

Status: implemented

## Problem

The experience recall ranking in `packages/synergy/src/library/experience-recall.ts` used `q_visits` for both the `N` and `n` terms of the UCB1 exploration bonus (`√(ln N / n)`). But `q_visits` is only incremented on the reward path — inside `updateQValues` during Q-learning credit assignment — never when an experience is actually selected and injected into a session. An experience that is retrieved many times without receiving a reward update stays at `q_visits = 0`, so `n` was floored to `1` and it received a perpetual maximal exploration bonus. The result was a Matthew effect: never-rewarded (often newly-encoded) experiences crowded out better-evidenced ones, and the exploration term never decayed no matter how often they were surfaced (#1252).

## Decision

Add a dedicated `retrieval_count` column to the `experience` table, incremented in `ExperienceRecall.trackRetrieval` when experiences are selected for injection — deliberately separate from `q_visits`, which keeps counting reward-path credit updates. The UCB1 term now uses `retrieval_count` for both `N` (total pulls across candidates) and `n` (per-arm pulls). On a fully cold candidate set (nothing ever selected), the exploration bonus is `0` instead of the old `ln(1) = 0`-with-`n`-floored-to-1 fallback that handed every never-pulled experience a maximal bonus.

A versioned library migration (`20260824-library-experience-retrieval-count`) adds the column with default `0` and seeds `retrieval_count = q_visits` for previously-rewarded experiences (`q_visits > 0`), so they do not read as never-pulled post-upgrade; unrewarded experiences stay at `0`, which is correct because the new counter had genuinely never counted them. The CLI `data merge` path carries the new column so merged libraries keep their pull counts.

The counter increments in `trackRetrieval`, which is only called from the session recall path for experiences that actually have scripts and are injected (`packages/synergy/src/session/recall.ts`); the server search endpoint and boss-runtime reads call `retrieve` directly and do not count as pulls, matching the intended "arm was pulled" semantics.

## Alternatives considered

- **Reuse `q_visits` as the pull counter** — rejected: it conflates two different events (being rewarded vs being selected). An experience selected many times but never rewarded is exactly the case that must decay exploration, and repurposing the reward counter would destroy the reward-frequency signal the stats rollup and the `visits` list sort rely on.
- **Reuse `retrieved_experience_ids`** — rejected: that JSON field records which experiences a given experience's reward should credit (credit assignment), not how often an experience itself was pulled; it is overwritten on re-encode and has no counting semantics.
- **Keep `ln(1)` as the cold-start fallback with `n` floored to 1** — rejected: that is precisely the bug — every arm in a cold set gets the same maximal bonus forever, and it made `q_visits = 0` arms dominate. A `0` bonus on a fully cold set defers exploration to the ε-greedy probability, which already provides exploration pressure.
- **In-memory counter only** — rejected: the counter must survive restarts to decay correctly across sessions, so it belongs in the persisted experience row.

## Consequences

Exploration in recall now decays as arms are actually pulled, so ranking converges toward well-evidenced experiences; never-rewarded experiences lose their artificial perpetual bonus while still being explored via ε-greedy and via the UCB1 term until they accumulate pulls. Existing databases get one migration that adds the column and seeds from `q_visits`; the seeding is intentionally approximate (reward-path visits, not true pulls) because pre-fix databases have no pull evidence. The `visits` list sort and stats remain on `q_visits` — this change does not alter what "visits" means anywhere else. Behavioral coverage lives in `packages/synergy/test/library/experience-recall.test.ts` (cold set gets no bonus; bonus decays with pulls and ignores `q_visits`) plus migration and DB counter tests.
