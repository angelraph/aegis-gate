//! Independent review of a payout before signing.
//!
//! A signer must not trust the coordinator's description of a transaction. Given only
//! the PCZT bytes plus what the signer already knows (its FROST group key and the deal
//! ID), this module re-derives the escrow, checks every Orchard/Ironwood action against
//! its commitments, and reports where the money really goes, the fee, and the sighash
//! and randomizers to sign. Plaintext PCZT fields (recipient, value) are only reported
//! after `cmx` and `cv_net` prove they match what the chain will see.

use orchard::{keys::Scope, pczt::Bundle};
use pczt::{roles::verifier::Verifier, Pczt};
use serde::Serialize;
use zcash_protocol::consensus::NetworkType;

use crate::{escrow, signing, Error};

#[derive(Clone, Debug, Serialize)]
pub struct ReviewedOutput {
    pub pool: signing::Pool,
    pub index: usize,
    pub address: String,
    /// Hex of the raw 43-byte Orchard/Ironwood receiver; compare this, not `address`.
    pub receiver: String,
    pub value: u64,
    /// True when the output returns to this deal's escrow (change).
    pub to_escrow: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Review {
    pub tx_version: u32,
    pub sighash: String,
    /// Spends needing a FROST signature, with randomizers computed from the PCZT itself.
    pub spends: Vec<signing::PendingSpend>,
    /// Non-zero outputs, each verified against its note commitment.
    pub outputs: Vec<ReviewedOutput>,
    /// Escrow address re-derived from the signer's own group key and the deal ID.
    pub escrow_address: String,
    pub spent: u64,
    pub fee: u64,
}

/// Review `pczt_bytes` for the escrow defined by `group_key` (the even-Y FROST group key
/// the signer computed itself) and `deal_id`. Fails on anything it can't fully account for.
pub fn review(pczt_bytes: &[u8], group_key: &[u8], deal_id: &[u8], network: NetworkType) -> Result<Review, Error> {
    let fvk = escrow::full_viewing_key(group_key, deal_id)?;
    // Outgoing viewing keys: the escrow encrypts a recoverable copy of every output it
    // creates, so the signer can check each ciphertext decrypts to what is claimed.
    let ovks = [fvk.to_ovk(Scope::External), fvk.to_ovk(Scope::Internal)];
    let escrow_address = escrow::derive(group_key, deal_id, network)?.address;
    let escrow_receiver = escrow::orchard_receiver_of(&escrow_address)?;
    let request = signing::inspect(pczt_bytes)?;

    let pczt = Pczt::parse(pczt_bytes).map_err(|e| Error::Pczt(format!("parse: {e:?}")))?;

    // Nothing may leave the shielded Orchard-protocol pools unchecked.
    let effects = pczt.clone().into_effects().map_err(|e| Error::Pczt(format!("effects: {e:?}")))?;
    if effects.transparent_bundle().is_some() {
        return Err(Error::Review("the payout has a transparent part; refusing".into()));
    }
    if effects.sapling_bundle().is_some() {
        return Err(Error::Review("the payout has a Sapling part; refusing".into()));
    }
    // A non-zero lock time could hold a payout hostage; escrow payouts never need one.
    if effects.lock_time() != 0 {
        return Err(Error::Review(format!("the payout is time-locked ({}); refusing", effects.lock_time())));
    }

    let mut outputs = vec![];
    let mut spent: u64 = 0;
    let mut produced: u64 = 0;
    let mut problem: Option<String> = None;

    let mut check = |pool: signing::Pool, bundle: &Bundle| {
        for (index, action) in bundle.actions().iter().enumerate() {
            let spend = action.spend();
            let output = action.output();
            let fail = |what: &str, e: &dyn std::fmt::Debug| format!("{pool:?} action {index}: {what} ({e:?})");
            if let Err(e) = action.verify_cv_net() { return Err(fail("value commitment doesn't match", &e)); }
            if let Err(e) = output.verify_note_commitment(spend) { return Err(fail("output doesn't match its note commitment", &e)); }
            let spend_value = spend.value().map(|v| v.inner()).ok_or_else(|| fail("spend value missing", &()))?;
            if spend_value > 0 {
                // A real spend must be this escrow's note, signed under this escrow's key.
                if let Err(e) = spend.verify_nullifier(Some(&fvk)) { return Err(fail("spend isn't from this escrow", &e)); }
                if let Err(e) = spend.verify_rk(Some(&fvk)) { return Err(fail("spend key isn't this escrow's", &e)); }
                spent = spent.checked_add(spend_value).ok_or_else(|| fail("overflow", &()))?;
            }
            let value = output.value().map(|v| v.inner()).ok_or_else(|| fail("output value missing", &()))?;
            if value > 0 {
                let recipient = output.recipient().ok_or_else(|| fail("output recipient missing", &()))?;
                // The recipient's wallet finds a note only through its ciphertext. A
                // ciphertext that doesn't decrypt to this exact note would strand the funds.
                let recovered = ovks.iter().find_map(|ovk| action.recover_output_with_ovk(ovk, *bundle.bundle_version()).ok().flatten());
                match recovered {
                    Some((note, addr, _memo)) if note.value().inner() == value && addr == recipient => {}
                    Some(_) => return Err(fail("encrypted note doesn't match the claimed output", &())),
                    None => return Err(fail("encrypted note can't be recovered, so the recipient might never see it", &())),
                }
                let raw = recipient.to_raw_address_bytes();
                let address = escrow::encode_receiver(raw, network).map_err(|e| fail("address", &e))?;
                produced = produced.checked_add(value).ok_or_else(|| fail("overflow", &()))?;
                outputs.push(ReviewedOutput { pool, index, to_escrow: raw == escrow_receiver, receiver: hex::encode(raw), address, value });
            }
        }
        Ok(())
    };

    let verifier = Verifier::new(pczt);
    let verifier = verifier
        .with_orchard::<String, _>(|b| check(signing::Pool::Orchard, b).map_err(pczt::roles::verifier::OrchardError::Custom))
        .map_err(|e| { problem.get_or_insert(format!("{e:?}")); Error::Review(format!("{e:?}")) });
    if let Ok(v) = verifier {
        v.with_ironwood::<String, _>(|b| check(signing::Pool::Ironwood, b).map_err(pczt::roles::verifier::OrchardError::Custom))
            .map_err(|e| Error::Review(format!("{e:?}")))?;
    } else if let Some(p) = problem {
        return Err(Error::Review(p));
    }

    let fee = spent.checked_sub(produced).ok_or_else(|| Error::Review("outputs exceed spends".into()))?;
    Ok(Review { tx_version: request.tx_version, sighash: request.sighash, spends: request.spends, outputs, escrow_address, spent, fee })
}
