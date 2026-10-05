//! The browser signer must produce exactly what Zcash consensus accepts: a 2-of-3
//! key whose group key is a valid Orchard/Ironwood `ak`, and signatures that verify
//! under `rk = ak + [alpha]G`. Checked here with aegis-core's consensus verifier.

use aegis_wasm::*;
use serde_json::{json, Value};
use zcash_protocol::consensus::NetworkType;

fn v(s: String) -> Value { serde_json::from_str(&s).unwrap() }

/// Run the full 3-party key ceremony as three separate parties would.
fn ceremony() -> Vec<Value> {
    let p1: Vec<Value> = (1..=3).map(|n| v(dkg_part1(n).unwrap())).collect();
    let r1_for = |me: usize| {
        let mut m = serde_json::Map::new();
        for (i, p) in p1.iter().enumerate() { if i != me { m.insert((i + 1).to_string(), p["package"].clone()); } }
        Value::Object(m).to_string()
    };
    let p2: Vec<Value> = (0..3).map(|i| v(dkg_part2(&p1[i]["secret"].to_string(), &r1_for(i)).unwrap())).collect();
    (0..3).map(|me| {
        let mut r2 = serde_json::Map::new();
        for (i, p) in p2.iter().enumerate() {
            if i != me { r2.insert((i + 1).to_string(), p["packages"][(me + 1).to_string()].clone()); }
        }
        v(dkg_part3(&p2[me]["secret"].to_string(), &r1_for(me), &Value::Object(r2).to_string()).unwrap())
    }).collect()
}

fn sign_with(keys: &[Value], who: [usize; 2], msg: &str, alpha: &str) -> String {
    let rounds: Vec<Value> = who.iter().map(|&i| v(sign_commit(&keys[i]["keyPackage"].to_string()).unwrap())).collect();
    let commitments = json!({ (who[0] + 1).to_string(): rounds[0]["commitments"], (who[1] + 1).to_string(): rounds[1]["commitments"] });
    let sp = signing_package(&commitments.to_string(), msg).unwrap();
    let shares: Vec<Value> = who.iter().zip(&rounds).map(|(&i, r)| v(sign_share(&sp, &r["nonces"].to_string(), &keys[i]["keyPackage"].to_string(), alpha).unwrap())).collect();
    let all = json!({ (who[0] + 1).to_string(): shares[0], (who[1] + 1).to_string(): shares[1] });
    aggregate(&sp, &all.to_string(), &keys[0]["publicKeyPackage"].to_string(), alpha).unwrap()
}

// A canonical Pallas scalar and a 32-byte message.
const ALPHA: &str = "0700000000000000000000000000000000000000000000000000000000000000";
const MSG: &str = "7d48149e6ae74a301bc74c7e1a5af48c52c0d20550a086899db07555e73f53a5";

#[test]
fn all_three_parties_agree_on_one_even_y_group_key() {
    let keys = ceremony();
    let g = keys[0]["groupKey"].as_str().unwrap();
    assert!(keys.iter().all(|k| k["groupKey"] == keys[0]["groupKey"]));
    let ak = hex::decode(g).unwrap();
    assert_eq!(ak[31] & 0x80, 0, "Orchard requires an even-Y ak");
    let escrow = aegis_core::escrow::derive(&ak, b"browser-deal", NetworkType::Test).unwrap();
    assert!(escrow.address.starts_with("utest1"));
}

#[test]
fn any_two_signers_pass_the_consensus_check() {
    let keys = ceremony();
    let ak = hex::decode(keys[0]["groupKey"].as_str().unwrap()).unwrap();
    for pair in [[0, 1], [1, 2], [0, 2]] {
        let sig = sign_with(&keys, pair, MSG, ALPHA);
        assert!(verify(&keys[0]["publicKeyPackage"].to_string(), ALPHA, MSG, &sig).unwrap());
        aegis_core::signing::verify(&ak, &hex::decode(ALPHA).unwrap(), &hex::decode(MSG).unwrap(), &hex::decode(&sig).unwrap())
            .unwrap_or_else(|e| panic!("signers {pair:?}: Orchard spend-auth check failed: {e}"));
    }
}

#[test]
fn one_signer_alone_cannot_sign() {
    let keys = ceremony();
    let r = v(sign_commit(&keys[0]["keyPackage"].to_string()).unwrap());
    let only_one = json!({ "1": r["commitments"] });
    assert!(signing_package(&only_one.to_string(), MSG).is_err());
}

#[test]
fn signature_does_not_transfer_to_another_message() {
    let keys = ceremony();
    let sig = sign_with(&keys, [0, 1], MSG, ALPHA);
    let other = "00".repeat(32);
    assert!(!verify(&keys[0]["publicKeyPackage"].to_string(), ALPHA, &other, &sig).unwrap());
}
