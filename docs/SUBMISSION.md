# ZECATHON submission: Aegis Gate (Wildcard)

**Project name:** Aegis Gate

**One-liner:** Private escrow for strangers on shielded Zcash. Buyer, seller and an arbiter each hold one share of a 2-of-3 FROST key; any two can move the funds, no one alone can, and the money never leaves the Ironwood shielded pool.

**Repo:** https://github.com/angelraph/aegis-gate
**Live app:** https://aegis-gate-zec.vercel.app

## The problem
Zcash has no smart contracts, so it has no escrow. Every private trade between two people who don't know each other comes down to "you send first and hope." That is why private commerce on Zcash barely exists, and why most people have no reason to make a shielded transaction to someone else.

## What we built
- **2-of-3 FROST escrow on Ironwood.** Buyer, seller and arbiter run a RedPallas FROST key generation (ZIP 312). The group key becomes the spend authority of an Ironwood shielded address. Nobody ever holds the full spending key.
- **Verifiable escrow address.** Each party derives the escrow address and viewing key independently from the group key and the deal ID, so nobody has to be trusted to hand out the address. All three derivations were byte-identical in our run.
- **External signing for PCZTs.** `aegis inspect` extracts the sighash and per-spend randomizers the FROST group must sign; `aegis apply` injects the signatures and verifies each one against its `rk` before broadcast.
- **Working on testnet after NU7.** Testnet activated NU7 at block 4,465,026, hours before our escrow was funded. No released tool could build NU7 transactions, so we pinned the newest librustzcash and ported zcash-devtool to it (patch included).

## Proof (on-chain)
- Escrow funded with 0.125 TAZ: tx `669e43e2fb27cf15f7a0eb098eb17efe56dc3bd8b3443abc656697359bcdcfef` (testnet block 4,465,795)
- 2-of-3 release (buyer + seller) to the seller: tx `1b980aaa5dfd2ee811f824688c7c5b264aaa1b87aa940dddc99d3697b11e8bdf` (testnet block 4,465,954)
- A complete deal through the live web app: tx `af093f5660469a67369d776a45674b17971a16f96f4231f6196800fc095f4526` (testnet block 4,466,046)
- Self-custody release, key shares only in the buyer's and seller's browsers: tx `bf754298f5d01723ab04f936461677c48d31f711ea3a910b51cb4a16044a5447` (testnet block 4,466,532)
- Dispute refunded by buyer + arbiter after a deliberate engine crash: tx `ae74bc7347d3960fefb6740db7b2a77f66771831b35cc88cd64a0e442cc4addf` (testnet block 4,466,552)
- Two browsers end to end, each verifying the payout before signing: tx `09ac6e494fa78e97730b20bdf61204fdac9306ad2eb0443bd513107ee4c3627d` (testnet block 4,466,944)
- **First Aegis Gate escrow on mainnet**: tx `766ca9869bdafa5c9235d7117abb25bba35c7f8ced1043282cd08a6aaa31c374` (mainnet block 3,506,939)

## Why it fits Wildcard
It makes a shielded transaction worth making: the payment in a real trade between strangers, protected without a custodian. It is not content or a one-off game. It is the trust layer of Aegis Market, a private marketplace we are building on top of it.

## Built since the submission post
- **Self-custody browser signer** (Rust → WebAssembly): buyer and seller key shares are created and kept in their own browsers; the engine holds only the arbiter's share. Key-ceremony secrets are sealed end to end.
- **In-browser payout check**: before signing, each browser downloads the transaction, rebuilds the escrow from its own key, verifies every output against its on-chain commitment and encrypted note, checks the fee and lock time, and computes the sighash itself. 612 tampered transactions were refused in testing.
- **Deal security codes** that must match on both screens, so a relay that swaps a key during setup is caught.
- **Onboarding inside the first purchase**: key backup before payment details appear, then a guided first shielded payment.
- **Mainnet beta** capped at about $0.60 per deal, so anyone can try it with real ZEC.
- **Restart signing** for an interrupted signature, and an engine supervisor that restarts services and keeps the site pointed at the live engine.

## Honest scope
The escrow engine runs on one machine behind a tunnel, so mainnet deals are capped while it stays a beta. See docs/THREAT_MODEL.md.
