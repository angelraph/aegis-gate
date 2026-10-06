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
- **Key custody (self-custody deals, the default).** Buyer and seller shares are created
  and stored in their own browsers (WebAssembly). The engine holds only the arbiter's
  share. Round-2 key-ceremony packages carry secret shares, so they are sealed end to end
  (ECDH P-256 + HKDF-SHA256 + AES-256-GCM); a relay that could read them could rebuild the
  whole key from its own share plus the two packages addressed to it.
- **Signing checks (done).** Before signing, the browser downloads the PCZT and, in WASM,
  re-derives the escrow from its own group key and the deal ID; checks each action's
  `cv_net`, each output's note commitment, and that each output's encrypted note decrypts
  (via the escrow OVK) to the claimed recipient and value; checks each real spend's
  nullifier and `rk` against the escrow FVK; rejects transparent or Sapling parts and
  non-zero lock times; recomputes the sighash and randomizers itself; and refuses unless
  every value-carrying output pays the agreed receiver or returns change to the escrow,
  with a fee of at most 0.001 ZEC. The signing package's message must equal its own
  sighash. Tested on real mined PCZTs with 306 single-byte tamperings each: none accepted
  with a different payout, fee or output.
- **Engine-signed deals (opt-out).** All three shares run in the engine, which signs only
  on two matching approvals from different people. The operator is trusted.
- **Key loss.** Clearing browser storage deletes the share. The page offers a backup file;
  with 2-of-3 the other two parties can still complete the deal.
- **Active relay attack on box keys (mitigated).** The engine relays each party's box
  public key; a malicious engine could substitute its own and read round-2 packages. Each
  browser shows a deal security code over all three box keys and its own group key, to be
  compared out of band before paying, and automatically warns if its own box key was
  altered. A swap that goes unnoticed before funding is the residual risk.
- **Mainnet beta limits.** Mainnet deals are priced between 0.0002 and 0.00045 ZEC (about
  $0.26 to $0.60) while the system is unaudited and the engine runs as a single hosted instance.
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
