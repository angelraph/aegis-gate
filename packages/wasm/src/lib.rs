//! Aegis Gate browser signer.
//!
//! Every function takes and returns JSON strings so it can be called from JavaScript
//! (browser or Node) without shared types. Secret material (round secrets, key packages,
//! nonces) is returned to the caller and never leaves the caller's device unless the
//! caller sends it somewhere.
//!
//! Escrows are always 2-of-3: buyer = 1, seller = 2, arbiter = 3.

use std::collections::BTreeMap;

use rand_core::OsRng;
use reddsa::frost::redpallas::{
    self as frost,
    keys::{dkg, KeyPackage, PublicKeyPackage},
    round1::{SigningCommitments, SigningNonces},
    round2::SignatureShare,
    Identifier, RandomizedParams, Randomizer, Signature, SigningPackage,
};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

const MAX_SIGNERS: u16 = 3;
const MIN_SIGNERS: u16 = 2;

type R<T> = Result<T, String>;

fn err<E: std::fmt::Debug>(what: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{what}: {e:?}")
}
fn parse<T: serde::de::DeserializeOwned>(what: &str, s: &str) -> R<T> {
    serde_json::from_str(s).map_err(err(what))
}
fn to_json<T: serde::Serialize>(v: &T) -> R<Value> {
    serde_json::to_value(v).map_err(err("serialize"))
}
fn id(n: u16) -> R<Identifier> {
    Identifier::try_from(n).map_err(err("identifier"))
}
fn hex32(what: &str, s: &str) -> R<Vec<u8>> {
    let b = hex::decode(s.trim()).map_err(err(what))?;
    if b.len() != 32 { return Err(format!("{what}: expected 32 bytes")); }
    Ok(b)
}
fn randomizer(hex_alpha: &str) -> R<Randomizer> {
    Randomizer::deserialize(&hex32("randomizer", hex_alpha)?).map_err(err("randomizer"))
}
/// Maps keyed by participant number ("1", "2", "3") → maps keyed by FROST identifier.
fn by_identifier<T: serde::de::DeserializeOwned>(what: &str, s: &str) -> R<BTreeMap<Identifier, T>> {
    let raw: BTreeMap<String, Value> = parse(what, s)?;
    raw.into_iter()
        .map(|(k, v)| {
            let n: u16 = k.parse().map_err(err(what))?;
            Ok((id(n)?, serde_json::from_value(v).map_err(err(what))?))
        })
        .collect()
}
fn by_number<T: serde::Serialize>(m: &BTreeMap<Identifier, T>) -> R<Value> {
    let mut out = serde_json::Map::new();
    for (k, v) in m {
        let n = (1..=MAX_SIGNERS).find(|n| id(*n).ok().as_ref() == Some(k)).ok_or("unknown identifier")?;
        out.insert(n.to_string(), to_json(v)?);
    }
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------- key ceremony

/// Round 1 for participant `me` (1 buyer, 2 seller, 3 arbiter).
/// Returns `{ secret, package }`. Keep `secret`; broadcast `package`.
pub fn dkg_part1(me: u16) -> R<String> {
    let (secret, package) = dkg::part1(id(me)?, MAX_SIGNERS, MIN_SIGNERS, OsRng).map_err(err("dkg part1"))?;
    Ok(json!({ "secret": to_json(&secret)?, "package": to_json(&package)? }).to_string())
}

/// Round 2. `round1` maps the *other* participants' numbers to their round-1 packages.
/// Returns `{ secret, packages }`; send `packages[n]` privately to participant n.
pub fn dkg_part2(secret1: &str, round1: &str) -> R<String> {
    let secret: dkg::round1::SecretPackage = parse("round-1 secret", secret1)?;
    let r1: BTreeMap<Identifier, dkg::round1::Package> = by_identifier("round-1 packages", round1)?;
    let (secret2, out) = dkg::part2(secret, &r1).map_err(err("dkg part2"))?;
    Ok(json!({ "secret": to_json(&secret2)?, "packages": by_number(&out)? }).to_string())
}

/// Round 3. Returns `{ keyPackage, publicKeyPackage, groupKey }`. `groupKey` is the
/// even-Y RedPallas group key, i.e. the escrow's spend validating key `ak`.
pub fn dkg_part3(secret2: &str, round1: &str, round2: &str) -> R<String> {
    let secret: dkg::round2::SecretPackage = parse("round-2 secret", secret2)?;
    let r1: BTreeMap<Identifier, dkg::round1::Package> = by_identifier("round-1 packages", round1)?;
    let r2: BTreeMap<Identifier, dkg::round2::Package> = by_identifier("round-2 packages", round2)?;
    let (kp, pkp) = dkg::part3(&secret, &r1, &r2).map_err(err("dkg part3"))?;
    let group = hex::encode(pkp.verifying_key().serialize().map_err(err("group key"))?);
    Ok(json!({ "keyPackage": to_json(&kp)?, "publicKeyPackage": to_json(&pkp)?, "groupKey": group }).to_string())
}

// ---------------------------------------------------------------- signing

/// Signing round 1. Returns `{ nonces, commitments }`. Keep `nonces` secret and use
/// them once; send `commitments` to the coordinator.
pub fn sign_commit(key_package: &str) -> R<String> {
    let kp: KeyPackage = parse("key package", key_package)?;
    let (nonces, commitments) = frost::round1::commit(kp.signing_share(), &mut OsRng);
    Ok(json!({ "nonces": to_json(&nonces)?, "commitments": to_json(&commitments)? }).to_string())
}

/// Coordinator: build the signing package from the signers' commitments
/// (`{ "1": …, "2": … }`) and the 32-byte message (the transaction sighash).
pub fn signing_package(commitments: &str, message_hex: &str) -> R<String> {
    let c: BTreeMap<Identifier, SigningCommitments> = by_identifier("commitments", commitments)?;
    if c.len() < MIN_SIGNERS as usize { return Err("need commitments from two signers".into()); }
    let msg = hex32("message", message_hex)?;
    Ok(to_json(&SigningPackage::new(c, &msg))?.to_string())
}

/// Signing round 2: this participant's signature share under randomizer `alpha`
/// (the spend's randomizer from the PCZT).
pub fn sign_share(signing_pkg: &str, nonces: &str, key_package: &str, alpha_hex: &str) -> R<String> {
    let sp: SigningPackage = parse("signing package", signing_pkg)?;
    let n: SigningNonces = parse("nonces", nonces)?;
    let kp: KeyPackage = parse("key package", key_package)?;
    let share = frost::round2::sign(&sp, &n, &kp, randomizer(alpha_hex)?).map_err(err("sign"))?;
    Ok(to_json(&share)?.to_string())
}

/// Coordinator: verify and aggregate the shares into one RedPallas signature (hex, 64 bytes).
pub fn aggregate(signing_pkg: &str, shares: &str, public_key_package: &str, alpha_hex: &str) -> R<String> {
    let sp: SigningPackage = parse("signing package", signing_pkg)?;
    let s: BTreeMap<Identifier, SignatureShare> = by_identifier("signature shares", shares)?;
    let pkp: PublicKeyPackage = parse("public key package", public_key_package)?;
    let params = RandomizedParams::from_randomizer(pkp.verifying_key(), randomizer(alpha_hex)?);
    let sig = frost::aggregate(&sp, &s, &pkp, &params).map_err(err("aggregate"))?;
    Ok(hex::encode(sig.serialize().map_err(err("signature"))?))
}

/// Check a signature against the group key randomized by `alpha` (what consensus checks).
pub fn verify(public_key_package: &str, alpha_hex: &str, message_hex: &str, sig_hex: &str) -> R<bool> {
    let pkp: PublicKeyPackage = parse("public key package", public_key_package)?;
    let params = RandomizedParams::from_randomizer(pkp.verifying_key(), randomizer(alpha_hex)?);
    let sig = Signature::deserialize(&hex::decode(sig_hex.trim()).map_err(err("signature"))?).map_err(err("signature"))?;
    let msg = hex32("message", message_hex)?;
    Ok(params.randomized_verifying_key().verify(&msg, &sig).is_ok())
}

// ---------------------------------------------------------------- payout review

/// Highest fee a signer will accept, in zatoshis (0.001 ZEC). ZIP 317 fees for an escrow
/// payout are around 0.0001 ZEC.
pub const MAX_FEE_ZATS: u64 = 100_000;

/// Review a payout PCZT entirely on this device and apply the signing policy.
///
/// `group_key` is the FROST group key this signer computed itself; `expected_to` is the
/// payout address agreed for the outcome being signed. Returns the review plus `ok` and,
/// if not ok, the reasons. Only `ok == true` reviews may be signed, and only the sighash
/// and randomizers returned here may be used.
pub fn review_payout(pczt_b64: &str, group_key: &str, deal_id: &str, network: &str, expected_to: &str) -> R<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(pczt_b64.trim()).map_err(err("pczt encoding"))?;
    let net = match network { "main" => zcash_protocol::consensus::NetworkType::Main, "test" => zcash_protocol::consensus::NetworkType::Test, _ => return Err("unknown network".into()) };
    let ak = hex::decode(group_key.trim()).map_err(err("group key"))?;
    let r = aegis_core::review::review(&bytes, &ak, deal_id.as_bytes(), net).map_err(|e| e.to_string())?;
    let want = hex::encode(aegis_core::escrow::orchard_receiver_of(expected_to).map_err(|e| e.to_string())?);

    let mut reasons = vec![];
    let mut payout: u64 = 0;
    for o in &r.outputs {
        if o.receiver == want { payout += o.value; }
        else if !o.to_escrow { reasons.push(format!("{} zats would go to an address nobody agreed to ({})", o.value, o.address)); }
    }
    if payout == 0 { reasons.push("nothing is paid to the agreed address".into()); }
    if r.fee > MAX_FEE_ZATS { reasons.push(format!("the fee ({} zats) is too high", r.fee)); }
    if r.spends.is_empty() { reasons.push("there is nothing to sign".into()); }
    Ok(json!({ "ok": reasons.is_empty(), "reasons": reasons, "payout": payout, "review": to_json(&r)? }).to_string())
}

// ---------------------------------------------------------------- JS bindings

fn js<T>(r: R<T>) -> Result<T, JsError> { r.map_err(|e| JsError::new(&e)) }

#[wasm_bindgen(js_name = dkgPart1)]
pub fn js_dkg_part1(me: u16) -> Result<String, JsError> { js(dkg_part1(me)) }
#[wasm_bindgen(js_name = dkgPart2)]
pub fn js_dkg_part2(secret1: &str, round1: &str) -> Result<String, JsError> { js(dkg_part2(secret1, round1)) }
#[wasm_bindgen(js_name = dkgPart3)]
pub fn js_dkg_part3(secret2: &str, round1: &str, round2: &str) -> Result<String, JsError> { js(dkg_part3(secret2, round1, round2)) }
#[wasm_bindgen(js_name = signCommit)]
pub fn js_sign_commit(key_package: &str) -> Result<String, JsError> { js(sign_commit(key_package)) }
#[wasm_bindgen(js_name = signingPackage)]
pub fn js_signing_package(commitments: &str, message_hex: &str) -> Result<String, JsError> { js(signing_package(commitments, message_hex)) }
#[wasm_bindgen(js_name = signShare)]
pub fn js_sign_share(signing_pkg: &str, nonces: &str, key_package: &str, alpha_hex: &str) -> Result<String, JsError> { js(sign_share(signing_pkg, nonces, key_package, alpha_hex)) }
#[wasm_bindgen(js_name = aggregate)]
pub fn js_aggregate(signing_pkg: &str, shares: &str, public_key_package: &str, alpha_hex: &str) -> Result<String, JsError> { js(aggregate(signing_pkg, shares, public_key_package, alpha_hex)) }
#[wasm_bindgen(js_name = reviewPayout)]
pub fn js_review_payout(pczt_b64: &str, group_key: &str, deal_id: &str, network: &str, expected_to: &str) -> Result<String, JsError> { js(review_payout(pczt_b64, group_key, deal_id, network, expected_to)) }
#[wasm_bindgen(js_name = verify)]
pub fn js_verify(public_key_package: &str, alpha_hex: &str, message_hex: &str, sig_hex: &str) -> Result<bool, JsError> { js(verify(public_key_package, alpha_hex, message_hex, sig_hex)) }
