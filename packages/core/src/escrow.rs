//! Escrow addresses controlled by a FROST group key.
//!
//! The FROST group verifying key (RedPallas) becomes the Orchard-protocol spend
//! validating key `ak`. Nobody ever holds the matching `ask`; spends are authorized
//! by a t-of-n FROST signing session instead.
//!
//! The remaining viewing components (`nk`, `rivk`) come from a throwaway spending key.
//! Upstream (`zcash-sign generate`) draws that key at random, which forces one party to
//! hand the UFVK to the others and be trusted about it. Here it is derived from
//! `ak || deal_id` instead, so every participant independently recomputes the same
//! UFVK and address and can check that the escrow is the one they agreed to.
//!
//! Knowing the derived spending key does not let anyone spend: an Orchard spend must be
//! signed under `rk = ak + [alpha]G`, and `ak` belongs to the FROST group.
//!
//! Such FVKs are not quantum-recoverable (their `ak` is not derived from the spending
//! key), so escrows are meant to be short-lived. See docs/THREAT_MODEL.md.

use blake2b_simd::Params;
use orchard::keys::{FullViewingKey, Scope, SpendValidatingKey, SpendingKey};
use serde::Serialize;
use zcash_address::{
    unified::{self, Encoding, Uitem},
    ToAddress, ZcashAddress,
};
use zcash_protocol::consensus::NetworkType;

use crate::Error;

const SK_PERSONALIZATION: &[u8; 16] = b"AegisGate_EscrSK";

/// A FROST-controlled escrow: the address buyers fund and the key that lets every
/// participant watch it.
#[derive(Clone, Debug, Serialize)]
pub struct EscrowKeys {
    /// Orchard-receiver-only unified address. Ironwood shares the Orchard receiver.
    pub address: String,
    /// Unified full viewing key, imported view-only into each participant's wallet.
    pub ufvk: String,
}

/// Derive the escrow address and viewing key for the FROST group key `ak` of a deal.
///
/// `ak` is the 32-byte serialized FROST group verifying key. It must already be in the
/// even-Y form Orchard requires, which `frost-client dkg -C redpallas` guarantees.
///
/// Encodings use the original ZIP 316 format (`Revision::R0`, `u1…`/`utest1…`), which
/// every current wallet and faucet accepts; Revision 2 uses a new `zu` prefix.
/// The receiver bytes are what bind funds, so a later switch to Revision 2 changes the
/// string, not the escrow.
pub fn derive(ak: &[u8], deal_id: &[u8], network: NetworkType) -> Result<EscrowKeys, Error> {
    let fvk = full_viewing_key(ak, deal_id)?;

    let receiver = fvk.address_at(0u64, Scope::External).to_raw_address_bytes();
    let ua = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![Uitem::Data(unified::Receiver::Orchard(receiver))],
    )
    .map_err(|e| Error::Key(format!("unified address: {e}")))?;
    let address = ZcashAddress::from_unified(network, ua).encode();

    let ufvk = unified::Ufvk::try_from_items(
        unified::Revision::R0,
        vec![Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))],
    )
    .map_err(|e| Error::Key(format!("unified viewing key: {e}")))?
    .encode(&network);

    Ok(EscrowKeys { address, ufvk })
}

/// The Orchard/Ironwood receiver inside a unified address (any revision), as raw bytes.
/// Two different unified-address strings can share the same receiver, so payouts are
/// matched on this, never on the string.
pub fn orchard_receiver_of(address: &str) -> Result<[u8; 43], Error> {
    use zcash_address::unified::Container;
    let (_, _, ua) = unified::Address::decode(address.trim()).map_err(|e| Error::Key(format!("not a unified address: {e}")))?;
    ua.items()
        .into_iter()
        .find_map(|item| match item { unified::Receiver::Orchard(r) => Some(r), _ => None })
        .ok_or_else(|| Error::Key("that address has no Orchard/Ironwood receiver".into()))
}

/// Encode a raw 43-byte Orchard/Ironwood receiver as a ZIP 316 Revision 0 unified address.
pub fn encode_receiver(receiver: [u8; 43], network: NetworkType) -> Result<String, Error> {
    let ua = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![Uitem::Data(unified::Receiver::Orchard(receiver))],
    )
    .map_err(|e| Error::Key(format!("unified address: {e}")))?;
    Ok(ZcashAddress::from_unified(network, ua).encode())
}

/// The escrow's Orchard full viewing key: `ak` from the FROST group, `nk` and `rivk`
/// from the deterministic throwaway spending key. Assembled through the 96-byte
/// `ak || nk || rivk` encoding, which `FullViewingKey::from_bytes` validates.
pub fn full_viewing_key(ak: &[u8], deal_id: &[u8]) -> Result<FullViewingKey, Error> {
    let ak = SpendValidatingKey::from_bytes(ak).ok_or(Error::InvalidGroupKey)?;
    let mut bytes = FullViewingKey::from(&viewing_sk(&ak, deal_id)).to_bytes();
    bytes[..32].copy_from_slice(&ak.to_bytes());
    FullViewingKey::from_bytes(&bytes).ok_or(Error::InvalidGroupKey)
}

/// Deterministic throwaway spending key supplying `nk` and `rivk`. Retries with a
/// counter because some 32-byte strings are not valid Orchard spending keys.
fn viewing_sk(ak: &SpendValidatingKey, deal_id: &[u8]) -> SpendingKey {
    let ak_bytes = ak.to_bytes();
    (0u32..)
        .find_map(|counter| {
            let hash = Params::new()
                .hash_length(32)
                .personal(SK_PERSONALIZATION)
                .to_state()
                .update(&ak_bytes)
                .update(&(deal_id.len() as u64).to_le_bytes())
                .update(deal_id)
                .update(&counter.to_le_bytes())
                .finalize();
            let bytes: [u8; 32] = hash.as_bytes().try_into().expect("32-byte hash");
            Option::<SpendingKey>::from(SpendingKey::from_bytes(bytes))
        })
        .expect("a valid spending key is found within a few attempts")
}
