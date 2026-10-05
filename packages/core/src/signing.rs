//! External (FROST) signing of Orchard-protocol spends in a PCZT.
//!
//! Adapted from ZcashFoundation/frost-tools `zcash-sign` (MIT OR Apache-2.0), split into
//! two non-interactive steps so signing can be driven by a relay or a browser:
//!
//! 1. [`inspect`] returns the sighash and, for every spend awaiting authorization, its
//!    pool, action index and randomizer `alpha`. Each `(sighash, alpha)` pair is what
//!    the FROST coordinator signs (`frost-client coordinator -m <sighash> -r <alpha>`).
//! 2. [`apply`] injects the resulting 64-byte RedPallas signatures. Each one is verified
//!    against the spend's `rk` before it is accepted.

use ff::PrimeField;
use orchard::primitives::redpallas::{self, SpendAuth};
use pczt::{
    roles::low_level_signer::{OrchardParseError, Signer},
    Pczt,
};
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::{
    sighash::SignableInput, sighash_v5::v5_signature_hash, sighash_v6::v6_signature_hash,
    txid::TxIdDigester, TxVersion,
};

use crate::Error;

/// Which Orchard-protocol bundle a spend lives in. A v6 transaction carries both, and a
/// ZIP 318 migration spends from Orchard while paying into Ironwood, so the pool has to
/// travel with the action index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pool {
    Orchard,
    Ironwood,
}

/// A spend that still needs a spend authorization signature.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingSpend {
    pub pool: Pool,
    pub index: usize,
    /// Hex-encoded randomizer, passed to the FROST coordinator as `-r`.
    pub alpha: String,
}

/// What the FROST group has to sign for this PCZT.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SigningRequest {
    pub tx_version: u32,
    /// Hex-encoded sighash, passed to the FROST coordinator as `-m`.
    pub sighash: String,
    pub spends: Vec<PendingSpend>,
}

/// A FROST-produced signature for one pending spend.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpendSignature {
    pub pool: Pool,
    pub index: usize,
    /// Hex-encoded 64-byte RedPallas signature.
    pub signature: String,
}

pub fn inspect(pczt_bytes: &[u8]) -> Result<SigningRequest, Error> {
    let pczt = parse(pczt_bytes)?;
    let (version, sighash) = sighash(&pczt)?;

    let mut spends = vec![];
    for &pool in pools_for(version) {
        let mut found = vec![];
        with_bundle(pczt.clone(), pool, |bundle| {
            for (index, action) in bundle.actions_mut().iter().enumerate() {
                // Dummy spends were already signed by the IO finalizer during
                // `pczt create`; only real spends are left without a signature.
                if action.spend().spend_auth_sig().is_some() {
                    continue;
                }
                if let Some(alpha) = action.spend().alpha() {
                    found.push((index, hex::encode(alpha.to_repr())));
                }
            }
            Ok(())
        })?;
        spends.extend(found.into_iter().map(|(index, alpha)| PendingSpend { pool, index, alpha }));
    }

    Ok(SigningRequest {
        tx_version: version_number(version),
        sighash: hex::encode(sighash),
        spends,
    })
}

pub fn apply(pczt_bytes: &[u8], signatures: &[SpendSignature]) -> Result<Vec<u8>, Error> {
    let pczt = parse(pczt_bytes)?;
    let (version, sighash) = sighash(&pczt)?;

    let mut decoded = Vec::with_capacity(signatures.len());
    for s in signatures {
        let bytes: [u8; 64] = hex::decode(&s.signature)
            .map_err(|_| Error::InvalidSignature(s.index))?
            .try_into()
            .map_err(|_| Error::InvalidSignature(s.index))?;
        decoded.push((s.pool, s.index, bytes));
    }

    let mut signer = Signer::new(pczt);
    for &pool in pools_for(version) {
        let for_pool: Vec<_> = decoded.iter().filter(|(p, _, _)| *p == pool).collect();
        if for_pool.is_empty() {
            continue;
        }
        signer = sign_bundle(signer, pool, |bundle| {
            let actions = bundle.actions_mut();
            for (_, index, sig) in &for_pool {
                let action = actions.get_mut(*index).ok_or(Error::NoSuchSpend(*index))?;
                action
                    .apply_signature(sighash, redpallas::Signature::<SpendAuth>::from(*sig))
                    .map_err(|e| Error::SignatureRejected(*index, format!("{e:?}")))?;
            }
            Ok(())
        })?;
    }

    signer
        .finish()
        .serialize()
        .map_err(|e| Error::Pczt(format!("serialize: {e:?}")))
}

/// Check a spend authorization signature the way consensus does: against
/// `rk = ak + [alpha]G`, where `ak` is the FROST group key.
pub fn verify(ak: &[u8], alpha: &[u8], message: &[u8], signature: &[u8]) -> Result<(), Error> {
    let ak = orchard::keys::SpendValidatingKey::from_bytes(ak).ok_or(Error::InvalidGroupKey)?;
    let alpha: [u8; 32] = alpha.try_into().map_err(|_| Error::InvalidRandomizer)?;
    let alpha = Option::<pasta_curves::pallas::Scalar>::from(
        pasta_curves::pallas::Scalar::from_repr(alpha),
    )
    .ok_or(Error::InvalidRandomizer)?;
    let sig: [u8; 64] = signature.try_into().map_err(|_| Error::InvalidSignature(0))?;
    ak.randomize(&alpha)
        .verify(message, &redpallas::Signature::<SpendAuth>::from(sig))
        .map_err(|e| Error::SignatureRejected(0, format!("{e:?}")))
}

fn parse(bytes: &[u8]) -> Result<Pczt, Error> {
    Pczt::parse(bytes).map_err(|e| Error::Pczt(format!("parse: {e:?}")))
}

/// The version-appropriate sighash. Ironwood spends live in v6 transactions; signing a v6
/// transaction against the v5 hash passes local verification and only fails at
/// broadcast, so the dispatch is pinned by a test against a real testnet transaction.
fn sighash(pczt: &Pczt) -> Result<(TxVersion, [u8; 32]), Error> {
    let tx_data = pczt
        .clone()
        .into_effects()
        .map_err(|e| Error::Pczt(format!("effects: {e:?}")))?;
    let txid_parts = tx_data.digest(TxIdDigester);
    let version = tx_data.version();
    let hash = match version {
        TxVersion::V6 => v6_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts),
        TxVersion::V5 if tx_data.orchard_bundle().is_some() => {
            v5_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts)
        }
        _ => return Err(Error::UnsupportedTransaction),
    };
    let hash: [u8; 32] = hash.as_ref().try_into().expect("sighash is 32 bytes");
    Ok((version, hash))
}

fn pools_for(version: TxVersion) -> &'static [Pool] {
    match version {
        TxVersion::V6 => &[Pool::Orchard, Pool::Ironwood],
        _ => &[Pool::Orchard],
    }
}

fn version_number(version: TxVersion) -> u32 {
    match version {
        TxVersion::V6 => 6,
        TxVersion::V5 => 5,
        _ => 0,
    }
}

/// Closure error for the low-level signer, which requires `E: From<OrchardParseError>`.
impl From<OrchardParseError> for Error {
    fn from(e: OrchardParseError) -> Self {
        Error::Pczt(format!("orchard bundle: {e:?}"))
    }
}

fn sign_bundle(
    signer: Signer,
    pool: Pool,
    f: impl FnOnce(&mut orchard::pczt::Bundle) -> Result<(), Error>,
) -> Result<Signer, Error> {
    match pool {
        Pool::Ironwood => signer.sign_ironwood_with(|_, bundle, _| f(bundle)),
        Pool::Orchard => signer.sign_orchard_with(|_, bundle, _| f(bundle)),
    }
}

fn with_bundle(
    pczt: Pczt,
    pool: Pool,
    f: impl FnOnce(&mut orchard::pczt::Bundle) -> Result<(), Error>,
) -> Result<(), Error> {
    sign_bundle(Signer::new(pczt), pool, f).map(|_| ())
}
