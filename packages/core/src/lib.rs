//! Aegis Gate core: 2-of-3 FROST escrow on the Ironwood shielded pool.
//!
//! - [`escrow`] turns a FROST group key into an escrow address and viewing key that
//!   every deal participant can recompute independently.
//! - [`signing`] extracts what the FROST group must sign from a PCZT and applies the
//!   resulting signatures.
//!
//! The crate is plain Rust with no I/O so the same code backs the CLI and, later, the
//! browser build.

pub mod escrow;
pub mod signing;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a valid FROST group key for Orchard/Ironwood (must be a 32-byte even-Y point)")]
    InvalidGroupKey,
    #[error("key error: {0}")]
    Key(String),
    #[error("PCZT error: {0}")]
    Pczt(String),
    #[error("only v6 (Ironwood) and v5 shielded-Orchard transactions are supported")]
    UnsupportedTransaction,
    #[error("randomizer is not a canonical 32-byte Pallas scalar")]
    InvalidRandomizer,
    #[error("signature for action {0} is not 64 hex-encoded bytes")]
    InvalidSignature(usize),
    #[error("no action {0} in bundle")]
    NoSuchSpend(usize),
    #[error("signature for action {0} rejected: {1}")]
    SignatureRejected(usize, String),
}
