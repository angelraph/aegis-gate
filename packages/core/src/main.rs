use std::{fs, path::PathBuf};

use aegis_core::{escrow, review, signing};
use clap::{Parser, Subcommand};
use eyre::{eyre, Result, WrapErr};
use zcash_protocol::consensus::NetworkType;

/// Aegis Gate escrow tooling. All output is JSON on stdout.
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Derive the escrow address and UFVK from a FROST group key.
    Escrow {
        /// Hex-encoded FROST group verifying key (`frost-client groups`).
        #[arg(long)]
        ak: String,
        /// Deal identifier agreed by all participants.
        #[arg(long)]
        deal: String,
        /// "main" or "test".
        #[arg(long, default_value = "test")]
        network: String,
    },
    /// Print the sighash and per-spend randomizers the FROST group must sign.
    Inspect {
        pczt: PathBuf,
    },
    /// Independently review a payout PCZT for an escrow before signing it.
    Review {
        pczt: PathBuf,
        /// Hex FROST group key (the signer's own).
        #[arg(long)]
        ak: String,
        #[arg(long)]
        deal: String,
        #[arg(long, default_value = "test")]
        network: String,
    },
    /// Verify a FROST signature against the group key randomized by alpha.
    VerifySig {
        #[arg(long)]
        ak: String,
        /// Hex randomizer.
        #[arg(long)]
        alpha: String,
        /// Hex message (the sighash).
        #[arg(long)]
        message: String,
        /// Hex 64-byte signature.
        #[arg(long)]
        signature: String,
    },
    /// Apply FROST signatures (JSON array of {pool, index, signature}) to a PCZT.
    Apply {
        pczt: PathBuf,
        #[arg(long)]
        signatures: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Escrow { ak, deal, network } => {
            let network = match network.as_str() {
                "main" => NetworkType::Main,
                "test" => NetworkType::Test,
                other => return Err(eyre!("unknown network {other:?}")),
            };
            let ak = hex::decode(ak.trim()).wrap_err("ak is not hex")?;
            print(&escrow::derive(&ak, deal.as_bytes(), network)?)
        }
        Command::Inspect { pczt } => print(&signing::inspect(&read(&pczt)?)?),
        Command::Review { pczt, ak, deal, network } => {
            let network = if network == "main" { NetworkType::Main } else { NetworkType::Test };
            let ak = hex::decode(ak.trim()).wrap_err("ak is not hex")?;
            print(&review::review(&read(&pczt)?, &ak, deal.as_bytes(), network)?)
        }
        Command::VerifySig { ak, alpha, message, signature } => {
            let h = |s: &str| hex::decode(s.trim()).wrap_err("not hex");
            signing::verify(&h(&ak)?, &h(&alpha)?, &h(&message)?, &h(&signature)?)?;
            print(&serde_json::json!({ "valid": true }))
        }
        Command::Apply { pczt, signatures, out } => {
            let sigs: Vec<signing::SpendSignature> =
                serde_json::from_slice(&read(&signatures)?).wrap_err("bad signatures JSON")?;
            fs::write(&out, signing::apply(&read(&pczt)?, &sigs)?)
                .wrap_err_with(|| format!("writing {}", out.display()))?;
            print(&serde_json::json!({ "signed": out }))
        }
    }
}

fn read(path: &PathBuf) -> Result<Vec<u8>> {
    fs::read(path).wrap_err_with(|| format!("reading {}", path.display()))
}

fn print(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
