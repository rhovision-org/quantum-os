//! WASM bindings — compiled when feature = "wasm".
//! Exposes the ZFA core to TypeScript with zero-copy where possible.

use wasm_bindgen::prelude::*;

use crate::capability::Capability;
use crate::coupling::coupling_json;
use crate::history::{achieves_zfa, achieves_zfa_pairwise, charge, div_b, is_pairwise_balanced, spectral_gap};
use crate::lint::lint;
use crate::pauli::is_pauli_closed;
use crate::twist::Twist;

/// Parse a twist sequence from a Uint8Array (0..7 encoding).
fn parse_twists(bytes: &[u8]) -> Vec<Twist> {
    bytes.iter().filter_map(|&b| Twist::from_u8(b)).collect()
}

#[wasm_bindgen]
pub fn wasm_achieves_zfa(twist_bytes: &[u8]) -> bool {
    achieves_zfa(&parse_twists(twist_bytes))
}

/// Test only the Pauli-fold closure half of ZFA (without count-balance).
/// Provided for parity with the QLF Python core's `is_pauli_closed`.
#[wasm_bindgen]
pub fn wasm_is_pauli_closed(twist_bytes: &[u8]) -> bool {
    is_pauli_closed(&parse_twists(twist_bytes))
}

/// QLF's count balance: the signed action vector `(#^-#v, #>-#<, #/-#\\, #+-#-)`
/// vanishes. Strictly stronger than the aggregate balance inside
/// [`wasm_achieves_zfa`] — see the note on `history::achieves_zfa`.
#[wasm_bindgen]
pub fn wasm_is_pairwise_balanced(twist_bytes: &[u8]) -> bool {
    is_pairwise_balanced(&parse_twists(twist_bytes))
}

/// QLF's ZFA exactly: pairwise count balance and Pauli closure.
#[wasm_bindgen]
pub fn wasm_achieves_zfa_pairwise(twist_bytes: &[u8]) -> bool {
    achieves_zfa_pairwise(&parse_twists(twist_bytes))
}

/// Classify a room's joint closure by how its per-peer factors relate to it.
///
/// `parts` is the peers' twist histories as digit strings (`0`-`7`), separated
/// by `|` — the order is the order the room composed them. Returns JSON:
/// `{"verdict":"coupled","shared":true,"open":[0,1],"baseline":0.802893}`.
#[wasm_bindgen]
pub fn wasm_coupling(parts: &str) -> String {
    coupling_json(parts)
}

#[wasm_bindgen]
pub fn wasm_spectral_gap(twist_bytes: &[u8]) -> i32 {
    spectral_gap(&parse_twists(twist_bytes)) as i32
}

#[wasm_bindgen]
pub fn wasm_div_b(twist_bytes: &[u8]) -> i32 {
    div_b(&parse_twists(twist_bytes)) as i32
}

#[wasm_bindgen]
pub fn wasm_charge(twist_bytes: &[u8]) -> i32 {
    charge(&parse_twists(twist_bytes)) as i32
}

/// Generate a capability from random bytes supplied by JS (via crypto.getRandomValues).
#[wasm_bindgen]
pub fn wasm_capability_from_entropy(bytes: &[u8], label: &str) -> String {
    Capability::from_entropy(bytes, label).to_string()
}

/// Opt-in research candidate; not used by deployed room issuance.
#[wasm_bindgen]
pub fn wasm_capability_v2_candidate(label: &str) -> String {
    Capability::generate_v2_candidate(label).to_string()
}

/// Verify that a hex-encoded capability string is ZFA-balanced.
#[wasm_bindgen]
pub fn wasm_capability_valid(hex: &str) -> bool {
    // Parse cap:label:hextwists format
    let parts: Vec<&str> = hex.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0] != "cap" {
        return false;
    }
    let twist_bytes: Vec<u8> = parts[2]
        .chars()
        .filter_map(|c| c.to_digit(16).map(|d| d as u8))
        .collect();
    achieves_zfa(&parse_twists(&twist_bytes))
}

/// Lint a rholang source string; true when it has no findings.
#[wasm_bindgen]
pub fn wasm_lint_ok(source: &str) -> bool {
    lint(source).is_empty()
}

/// Lint a rholang source string; returns findings joined by newlines ("" = clean).
#[wasm_bindgen]
pub fn wasm_lint_errors(source: &str) -> String {
    lint(source)
        .into_iter()
        .map(|f| f.message)
        .collect::<Vec<_>>()
        .join("\n")
}
