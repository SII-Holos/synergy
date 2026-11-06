------------------------------ MODULE ScopeEpochReplay ------------------------------
\* Bounded model of one Scope's epoch/seq watermark, reconnect replay, and
\* resync. The rules are the ones in docs/architecture/frontend-data-sync.md
\* (State Event Sequencing, Replay and Resync). The journal decision follows
\* packages/harness/src/bus/sequencer.ts SyncSequencer.replay. The watermark
\* decision follows apps/web/src/context/sync-watermark.ts observeWatermark.
\*
\* Streaming events are omitted: they carry no seq and do not move the
\* watermark. Payloads are omitted: an ok replay means the journal suffix is
\* applicable, and a reset means a snapshot replaces Scope state. Both
\* establish the server head. The first live event with no watermark seeds
\* that event's seq and does not replay the prefix below it; that matches
\* observeWatermark and is not a gap.
\*
\* Checked with the TLA+ tools (Leslie Lamport, Specifying Systems;
\* https://github.com/tlaplus/tlaplus). This file is the model, not a runtime.

EXTENDS Integers

CONSTANTS MaxSeq, JournalCap, MaxEpoch
ASSUME MaxSeq \in Nat /\ MaxSeq >= 1
ASSUME JournalCap \in Nat /\ JournalCap >= 1 /\ JournalCap <= MaxSeq
ASSUME MaxEpoch \in Nat /\ MaxEpoch >= 2

VARIABLES
  serverEpoch, serverSeq, oldest,
  clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq,
  lastAction, lastKind, prevClientEpoch, prevClientSeq, retiredDrops

vars == <<serverEpoch, serverSeq, oldest,
          clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq,
          lastAction, lastKind, prevClientEpoch, prevClientSeq, retiredDrops>>

\* oldest = 0 means the journal is empty. Otherwise the retained seqs are
\* exactly oldest..serverSeq, a suffix of length at most JournalCap.
KindOf(cEpoch, cSeq) ==
  IF cEpoch = 0 \/ cEpoch # serverEpoch THEN "reset"
  ELSE IF cSeq > serverSeq THEN "reset"
  ELSE IF cSeq = serverSeq THEN "ok"
  ELSE IF oldest = 0 \/ cSeq + 1 < oldest THEN "reset"
  ELSE "ok"

Book(action) ==
  /\ lastAction' = action
  /\ prevClientEpoch' = clientEpoch
  /\ prevClientSeq' = clientSeq

Init ==
  /\ serverEpoch = 1
  /\ serverSeq = 0
  /\ oldest = 0
  /\ clientEpoch = 0
  /\ clientSeq = 0
  /\ phase = "live"
  /\ held = 0
  /\ holdEpoch = 0
  /\ holdSeq = 0
  /\ lastAction = "init"
  /\ lastKind = "none"
  /\ prevClientEpoch = 0
  /\ prevClientSeq = 0
  /\ retiredDrops = 0

Stamp ==
  /\ serverSeq < MaxSeq
  /\ serverSeq' = serverSeq + 1
  /\ oldest' = IF oldest = 0 THEN serverSeq'
               ELSE IF serverSeq' - oldest + 1 > JournalCap
                    THEN serverSeq' - JournalCap + 1
                    ELSE oldest
  /\ Book("stamp")
  /\ UNCHANGED <<serverEpoch, clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Prune ==
  /\ oldest > 0
  /\ oldest' = IF oldest = serverSeq THEN 0 ELSE oldest + 1
  /\ Book("prune")
  /\ UNCHANGED <<serverEpoch, serverSeq, clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Recycle ==
  /\ serverEpoch < MaxEpoch
  /\ serverEpoch' = serverEpoch + 1
  /\ serverSeq' = 0
  /\ oldest' = 0
  /\ Book("recycle")
  /\ UNCHANGED <<clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Disconnect ==
  /\ phase = "live"
  /\ phase' = "down"
  /\ Book("disconnect")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, clientSeq, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Seed ==
  /\ phase = "live"
  /\ clientEpoch = 0
  /\ serverSeq > 0
  /\ clientEpoch' = serverEpoch
  /\ clientSeq' = serverSeq
  /\ held' = 0
  /\ Book("seed")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, phase, holdEpoch, holdSeq, lastKind, retiredDrops>>

Contiguous ==
  /\ phase = "live"
  /\ clientEpoch # 0
  /\ clientEpoch = serverEpoch
  /\ serverSeq = clientSeq + 1
  /\ clientSeq' = serverSeq
  /\ Book("contiguous")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, phase, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Duplicate ==
  /\ phase = "live"
  /\ clientEpoch # 0
  /\ clientEpoch = serverEpoch
  /\ serverSeq <= clientSeq
  /\ Book("duplicate")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq, lastKind, retiredDrops>>

Gap ==
  /\ phase = "live"
  /\ clientEpoch # 0
  /\ clientEpoch = serverEpoch
  /\ serverSeq > clientSeq + 1
  /\ phase' = "hold"
  /\ held' = serverSeq
  /\ holdEpoch' = clientEpoch
  /\ holdSeq' = clientSeq
  /\ Book("gap")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, clientSeq, lastKind, retiredDrops>>

EpochChange ==
  /\ phase = "live"
  /\ clientEpoch # 0
  /\ clientEpoch # serverEpoch
  /\ phase' = "hold"
  /\ held' = -1
  /\ holdEpoch' = clientEpoch
  /\ holdSeq' = clientSeq
  /\ Book("epoch")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, clientSeq, lastKind, retiredDrops>>

\* One retired-epoch delivery after the client has adopted a later epoch.
\* Bounded so the counter cannot enlarge the state space without bound.
DropRetired ==
  /\ phase = "live"
  /\ clientEpoch # 0
  /\ clientEpoch = serverEpoch
  /\ serverEpoch > 1
  /\ retiredDrops = 0
  /\ retiredDrops' = 1
  /\ Book("dropRetired")
  /\ UNCHANGED <<serverEpoch, serverSeq, oldest, clientEpoch, clientSeq, phase, held, holdEpoch, holdSeq, lastKind>>

Recover ==
  /\ phase \in {"down", "hold"}
  /\ LET kind == KindOf(clientEpoch, clientSeq)
     IN /\ phase' = "live"
        /\ held' = 0
        /\ clientEpoch' = serverEpoch
        /\ clientSeq' = serverSeq
        /\ lastKind' = kind
        /\ lastAction' = IF kind = "ok" THEN "recoverOk" ELSE "recoverReset"
        /\ prevClientEpoch' = clientEpoch
        /\ prevClientSeq' = clientSeq
        /\ UNCHANGED <<serverEpoch, serverSeq, oldest, holdEpoch, holdSeq, retiredDrops>>

Next ==
  \/ Stamp
  \/ Prune
  \/ Recycle
  \/ Disconnect
  \/ Seed
  \/ Contiguous
  \/ Duplicate
  \/ Gap
  \/ EpochChange
  \/ DropRetired
  \/ Recover

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Recover)

Actions == {
  "init", "stamp", "prune", "recycle", "disconnect", "seed", "contiguous",
  "duplicate", "gap", "epoch", "dropRetired", "recoverOk", "recoverReset"
}

TypeOK ==
  /\ serverEpoch \in 1..MaxEpoch
  /\ serverSeq \in 0..MaxSeq
  /\ oldest \in 0..MaxSeq
  /\ clientEpoch \in 0..MaxEpoch
  /\ clientSeq \in 0..MaxSeq
  /\ phase \in {"live", "down", "hold"}
  /\ held \in -1..MaxSeq
  /\ holdEpoch \in 0..MaxEpoch
  /\ holdSeq \in 0..MaxSeq
  /\ lastAction \in Actions
  /\ lastKind \in {"none", "ok", "reset"}
  /\ prevClientEpoch \in 0..MaxEpoch
  /\ prevClientSeq \in 0..MaxSeq
  /\ retiredDrops \in 0..1

InvJournal ==
  /\ oldest = 0 \/ (oldest <= serverSeq /\ serverSeq - oldest + 1 <= JournalCap)

InvSameEpochNotAhead ==
  clientEpoch = serverEpoch => clientSeq <= serverSeq

\* Gap and epoch-change freeze the watermark that recovery must replay from,
\* including when the server recycles before recovery runs.
InvHoldFreezesWatermark ==
  phase = "hold" =>
    (/\ clientEpoch # 0
     /\ held # 0
     /\ clientEpoch = holdEpoch
     /\ clientSeq = holdSeq)

InvWatermarkStep ==
  /\ lastAction = "seed" =>
       (/\ phase = "live"
        /\ prevClientEpoch = 0
        /\ clientEpoch = serverEpoch
        /\ clientSeq = serverSeq
        /\ held = 0)
  /\ lastAction = "contiguous" =>
       (/\ phase = "live"
        /\ clientEpoch = serverEpoch
        /\ prevClientEpoch = clientEpoch
        /\ clientSeq = prevClientSeq + 1
        /\ clientSeq = serverSeq)
  /\ lastAction = "duplicate" =>
       (/\ phase = "live"
        /\ clientEpoch = prevClientEpoch
        /\ clientSeq = prevClientSeq
        /\ clientEpoch = serverEpoch
        /\ serverSeq <= clientSeq)
  /\ lastAction = "gap" =>
       (/\ phase = "hold"
        /\ held > clientSeq
        /\ clientEpoch = serverEpoch
        /\ clientEpoch = prevClientEpoch
        /\ clientSeq = prevClientSeq)
  /\ lastAction = "epoch" =>
       (/\ phase = "hold"
        /\ held = -1
        /\ clientEpoch # serverEpoch
        /\ clientEpoch = prevClientEpoch
        /\ clientSeq = prevClientSeq)
  /\ lastAction = "dropRetired" =>
       (/\ phase = "live"
        /\ clientEpoch = serverEpoch
        /\ serverEpoch > 1
        /\ clientEpoch = prevClientEpoch
        /\ clientSeq = prevClientSeq)

InvRecoverKind ==
  /\ lastAction = "recoverOk" => lastKind = "ok"
  /\ lastAction = "recoverReset" => lastKind = "reset"
  /\ (lastAction \in {"recoverOk", "recoverReset"}) =>
       (/\ lastKind = KindOf(prevClientEpoch, prevClientSeq)
        /\ phase = "live"
        /\ clientEpoch = serverEpoch
        /\ clientSeq = serverSeq
        /\ held = 0)

InvOkCovered ==
  lastAction = "recoverOk" =>
    (/\ prevClientEpoch = serverEpoch
     /\ prevClientEpoch # 0
     /\ prevClientSeq <= serverSeq
     /\ (oldest = 0 => prevClientSeq = serverSeq)
     /\ (oldest > 0 => prevClientSeq = serverSeq \/ prevClientSeq + 1 >= oldest))

InvResetJustified ==
  lastAction = "recoverReset" =>
    (\/ prevClientEpoch = 0
     \/ prevClientEpoch # serverEpoch
     \/ prevClientSeq > serverSeq
     \/ (/\ prevClientSeq < serverSeq
         /\ (oldest = 0 \/ prevClientSeq + 1 < oldest)))

RecoveryDone == phase = "live" /\ clientEpoch = serverEpoch /\ clientSeq = serverSeq
CaughtUp == [](phase \in {"down", "hold"} => <>RecoveryDone)

=============================================================================
