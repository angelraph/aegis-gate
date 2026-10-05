use aegis_core::{
    escrow,
    signing::{self, Pool, SpendSignature},
    Error,
};
use orchard::keys::{FullViewingKey, SpendValidatingKey, SpendingKey};
use zcash_protocol::consensus::NetworkType;

/// Proven, unsigned v6 Ironwood PCZT from ZcashFoundation/frost-tools. It became testnet
/// transaction a5533fe75575b09d8986a05005d2c0528cf45a1a7e4cc71b304ae76a9e14487d, whose
/// spend was authorized by a 2-of-3 rerandomized FROST signature.
const IRONWOOD_V6_PCZT: &[u8] = include_bytes!("fixtures/ironwood_v6.pczt");
const IRONWOOD_V6_SIGHASH: &str =
    "7d48149e6ae74a301bc74c7e1a5af48c52c0d20550a086899db07555e73f53a5";

fn test_ak(seed: u8) -> [u8; 32] {
    let sk = (0u8..=255)
        .find_map(|i| Option::<SpendingKey>::from(SpendingKey::from_bytes([seed, i, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7])))
        .unwrap();
    SpendValidatingKey::from(FullViewingKey::from(&sk)).to_bytes()
}

#[test]
fn inspect_reports_v6_sighash_and_pending_spends() {
    let req = signing::inspect(IRONWOOD_V6_PCZT).unwrap();
    assert_eq!(req.tx_version, 6);
    assert_eq!(req.sighash, IRONWOOD_V6_SIGHASH);
    assert!(!req.spends.is_empty(), "fixture has a real spend awaiting a FROST signature");
    for s in &req.spends {
        assert_eq!(s.alpha.len(), 64, "alpha is a 32-byte scalar");
    }
}

#[test]
fn apply_rejects_a_signature_that_does_not_verify() {
    let req = signing::inspect(IRONWOOD_V6_PCZT).unwrap();
    let spend = &req.spends[0];
    let forged = SpendSignature {
        pool: spend.pool,
        index: spend.index,
        signature: "11".repeat(64),
    };
    let err = signing::apply(IRONWOOD_V6_PCZT, &[forged]).unwrap_err();
    assert!(matches!(err, Error::SignatureRejected(..)), "got {err:?}");
}

#[test]
fn apply_rejects_malformed_signature() {
    let bad = SpendSignature { pool: Pool::Ironwood, index: 0, signature: "abcd".into() };
    assert!(matches!(
        signing::apply(IRONWOOD_V6_PCZT, &[bad]),
        Err(Error::InvalidSignature(0))
    ));
}

#[test]
fn inspect_rejects_garbage() {
    assert!(matches!(signing::inspect(b"not a pczt"), Err(Error::Pczt(_))));
}

#[test]
fn escrow_is_deterministic_per_deal() {
    let ak = test_ak(1);
    let a = escrow::derive(&ak, b"deal-1", NetworkType::Test).unwrap();
    let b = escrow::derive(&ak, b"deal-1", NetworkType::Test).unwrap();
    let c = escrow::derive(&ak, b"deal-2", NetworkType::Test).unwrap();
    assert_eq!(a.address, b.address, "every participant recomputes the same escrow");
    assert_eq!(a.ufvk, b.ufvk);
    assert_ne!(a.address, c.address, "different deals never share an address");
    assert!(a.address.starts_with("utest1"), "{}", a.address);
    assert!(a.ufvk.starts_with("uviewtest1"), "{}", a.ufvk);

    let main = escrow::derive(&ak, b"deal-1", NetworkType::Main).unwrap();
    assert!(main.address.starts_with("u1"), "{}", main.address);
}

/// The first real escrow: group key from the 2-of-3 DKG run on 2026-10-05, funded with
/// 0.125 TAZ on testnet (tx 669e43e2…, block 4,465,795). Any change to derivation or
/// encoding that moves this address would strand funds, so it is pinned exactly.
#[test]
fn escrow_derivation_is_stable_for_funded_testnet_escrow() {
    let ak = hex::decode("897187f9056ad20742d447de5c594ebaff3aad16195d09a31eea2f30dce13936").unwrap();
    let keys = escrow::derive(&ak, b"poc-deal-1", NetworkType::Test).unwrap();
    assert_eq!(
        keys.address,
        "utest1qfcz6w3zdf9pt75y6432fet4l6x9h48r9qh676g8s4334mrjegqzyj44jagfvqsv9s5fch63ugr8saheku0y98vc63l2ww53vvz07gwv"
    );
    assert_eq!(
        keys.ufvk,
        "uviewtest143j06vt05dlepuuvt6p52jm2nthxgk3lnw8a3d2l04ugurpk6zsde26sl2gp28yzs45xsu8xmxtwjsqcg88j4jycdrraeh2kxqv5fjngusxepmkxm453yeqlwd3f4tmt6l4vhw3hve0agxdp0mkhk8g68cxaa8x4dxj6nvldn73cntq8mua2fygwylmra"
    );
}

#[test]
fn escrow_rejects_invalid_group_keys() {
    assert!(matches!(escrow::derive(&[0u8; 32], b"d", NetworkType::Test), Err(Error::InvalidGroupKey)));
    assert!(matches!(escrow::derive(&[1u8; 31], b"d", NetworkType::Test), Err(Error::InvalidGroupKey)));
    let mut odd_y = test_ak(2);
    odd_y[31] |= 0x80;
    assert!(matches!(escrow::derive(&odd_y, b"d", NetworkType::Test), Err(Error::InvalidGroupKey)));
}
