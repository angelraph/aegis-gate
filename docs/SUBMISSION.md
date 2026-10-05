# ZECATHON submission: Aegis Gate (Wildcard)

**Project name:** Aegis Gate

**One-liner:** Private escrow for strangers on shielded Zcash. Buyer, seller and an arbiter each hold one share of a 2-of-3 FROST key; any two can move the funds, no one alone can, and the money never leaves the Ironwood shielded pool.

**Repo:** https://github.com/angelraph/aegis-gate
**Demo page:** DEMO_URL

## The problem
Zcash has no smart contracts, so it has no escrow. Every private trade between two people who don't know each other comes down to "you send first and hope." That is why private commerce on Zcash barely exists, and why most people have no reason to make a shielded transaction to someone else.

## What we built
- **2-of-3 FROST escrow on Ironwood.** Buyer, seller and arbiter run a RedPallas FROST key generation (ZIP 312). The group key becomes the spend authority of an Ironwood shielded address. Nobody ever holds the full spending key.
- **Verifiable escrow address.** Each party derives the escrow address and viewing key independently from the group key and the deal ID, so nobody has to be trusted to hand out the address. All three derivations were byte-identical in our run.
- **External signing for PCZTs.** `aegis inspect` extracts the sighash and per-spend randomizers the FROST group must sign; `aegis apply` injects the signatures and verifies each one against its `rk` before broadcast.
- **Working on testnet after NU7.** Testnet activated NU7 at block 4,465,026, hours before our escrow was funded. No released tool could build NU7 transactions, so we pinned the newest librustzcash and ported zcash-devtool to it (patch included).

## Proof (Zcash testnet)
- Escrow funded with 0.125 TAZ: tx `669e43e2fb27cf15f7a0eb098eb17efe56dc3bd8b3443abc656697359bcdcfef` (block 4,465,795)
- 2-of-3 release (buyer + seller) to the seller: tx `1b980aaa5dfd2ee811f824688c7c5b264aaa1b87aa940dddc99d3697b11e8bdf` (block 4,465,954)
- The escrow's viewing key is published in the README and on the demo page, so anyone can audit both transactions view-only.

## Why it fits Wildcard
It makes a shielded transaction worth making: the payment in a real trade between strangers, protected without a custodian. It is not content or a one-off game. It is the trust layer of Aegis Market, a private marketplace we are building on top of it.

## What's next
Browser signer (each key share stays in its owner's browser and shows "pay X to Y" before signing), deal links with QR funding from Zashi/Zodl, an arbiter dashboard, onboarding inside the first purchase, and small mainnet deals with the community.

## Honest scope
Testnet prototype. The escrow mechanism is complete and demonstrated on-chain; the consumer web app is the next milestone. See docs/THREAT_MODEL.md.
