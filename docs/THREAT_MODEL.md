# Aegis Gate threat model (draft, Week 1)

## What Aegis Gate promises

1. **No custody.** No single party, Aegis included, can move escrowed funds. Spending
   needs a 2-of-3 FROST signature over the exact transaction.
2. **Shielded throughout.** Funding, release and refund are Ironwood shielded
   transactions. Observers see that shielded transactions happened, not who, what or how much.
3. **Verifiable escrow.** Every participant recomputes the escrow address and viewing key
   from the group key and deal ID, and can check funding without trusting anyone.

## Parties and what each can do

| Actor | Can | Cannot |
|---|---|---|
| Buyer + seller together | Release or refund without the arbiter | — |
| Arbiter + one side | Resolve a dispute | Act alone |
| Arbiter alone | See the deal (holds the viewing key) | Move funds |
| Relay (frostd) | See who is in a session and when; drop messages (DoS) | Forge signatures or learn key shares (messages are end-to-end encrypted between participants) |
| Chain observer | See that shielded transactions occurred, plus fees | Link buyer, seller, escrow or amounts |

## Known risks and decisions

- **Arbiter collusion.** The arbiter plus either side can take the funds. This is
  inherent to 2-of-3 escrow. Mitigations: public arbiter policy, signed dispute evidence,
  and (later) a choice of independent arbiters per deal.
- **Blind signing (open, must fix in Week 2).** The CLI `frost-client participant` shows
  only the sighash. The Aegis signer must receive the PCZT itself, show recipient, amount
  and memo, recompute the sighash locally, and refuse to sign if anything differs.
- **Viewing key reach.** All three participants hold the escrow UFVK and can see its
  activity. Anyone who learns the group key *and* the deal ID can derive the same UFVK.
  Neither is published.
- **Quantum recoverability.** Orchard-protocol FVKs built from an external `ak`
  (`from_sk_ak_incompatible_with_quantum_recoverability_and_will_be_removed`) are not
  quantum-recoverable, and future wallets may not support them. Escrows are short-lived
  by design: funds sit in them only for the length of a trade.
- **Relay metadata.** The relay sees session timing and participant communication keys.
  Use fresh communication keys per deal and allow Tor for relay connections.
- **Deal-link leakage.** Whoever holds a deal link can join as that role before the
  intended party does. DKG binds roles to communication keys, which participants confirm
  out of band (Week 2 UX).
- **Timing correlation.** Funding and payout timing can be correlated with off-chain
  events. Payouts can be delayed by a randomized interval.
