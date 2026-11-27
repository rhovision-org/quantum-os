use crate::history::{achieves_zfa, is_count_balanced, spectral_gap};
use crate::pauli::is_pauli_closed;
use crate::twist::Twist;

/// A capability token: an unforgeable ZFA-balanced identity.
///
/// In QuantumOS, possessing a capability name IS proof of authorization
/// (Curry-Howard for capabilities). Tokens are ZFA-balanced by construction —
/// their spectral gap is always 0, mirroring rho_process_always_zfa.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Capability {
    /// The ZFA-balanced twist sequence encoding this capability.
    /// Always satisfies achieves_zfa(&self.twists).
    twists: Vec<Twist>,
    /// Human-readable label (not part of the security identity).
    label: String,
}

impl Capability {
    /// Candidate issuance profile: 34 independent random bytes per initial
    /// sample, existing alternating twist grammar, scalar-return rejection.
    /// Not the default issuer; existing room identities are not migrated.
    pub fn generate_v2_candidate(label: impl Into<String>) -> Self {
        let mut bytes = [0u8; 34];
        getrandom::getrandom(&mut bytes).expect("getrandom failed");
        Self::from_entropy(&bytes, label)
    }

    /// Generate a new capability from raw bytes (e.g., from getrandom).
    ///
    /// Maps each byte to a twist pair `[pos, neg]` (count-balanced by construction)
    /// and uses rejection sampling to ensure the resulting sequence is also
    /// Pauli-closed (full ZFA). About 25% of random count-balanced sequences are
    /// Pauli-closed, so expected iterations ≈ 4.
    ///
    /// First iteration uses the supplied entropy as-is. On rejection, each retry
    /// XOR-mixes the caller's bytes with a fresh getrandom block — this gives
    /// independent samples per iteration (a counter-derived salt can leave fixed
    /// byte positions for long-enough inputs and fail to converge).
    pub fn from_entropy(bytes: &[u8], label: impl Into<String>) -> Self {
        // First attempt: use caller's bytes directly.
        let twists = Self::bytes_to_twists(bytes);
        if is_pauli_closed(&twists) {
            debug_assert!(is_count_balanced(&twists));
            return Self { twists, label: label.into() };
        }
        // Rejection sampling with fresh entropy mixed in per iteration.
        let mut mixed = bytes.to_vec();
        let mut extra = vec![0u8; bytes.len().max(1)];
        for _ in 0..1_000_000 {
            getrandom::getrandom(&mut extra).expect("getrandom failed");
            for (i, b) in mixed.iter_mut().enumerate() {
                *b = bytes[i] ^ extra[i % extra.len()];
            }
            let twists = Self::bytes_to_twists(&mixed);
            if is_pauli_closed(&twists) {
                debug_assert!(is_count_balanced(&twists));
                debug_assert!(achieves_zfa(&twists), "capability must achieve ZFA");
                return Self { twists, label: label.into() };
            }
        }
        panic!("Pauli closure rejection sampling exceeded budget");
    }

    /// Deterministic byte→twist pair mapping: each byte yields `[pos, neg]`
    /// where pos ∈ {Up, Right, Slash, Plus} and neg ∈ {Down, Left, BSlash, Minus}.
    fn bytes_to_twists(bytes: &[u8]) -> Vec<Twist> {
        let mut twists = Vec::with_capacity(bytes.len() * 2);
        for &b in bytes {
            let pos_idx = ((b >> 4) & 0x3) * 2;       // → 0,2,4,6 (all positive)
            let neg_idx = ((b & 0x3) * 2) + 1;        // → 1,3,5,7 (all negative)
            let pos = Twist::from_u8(pos_idx).unwrap_or(Twist::Plus);
            let neg = Twist::from_u8(neg_idx).unwrap_or(Twist::Minus);
            twists.push(pos);
            twists.push(neg);
        }
        twists
    }

    /// Create a named root capability (for testing / bootstrap).
    /// Uses a fixed minimal ZFA string [+, -].
    pub fn root(label: impl Into<String>) -> Self {
        Self {
            twists: vec![Twist::Plus, Twist::Minus],
            label: label.into(),
        }
    }

    /// Derive a child capability by appending a ZFA-balanced extension.
    /// The child is unforgeable without the parent.
    pub fn derive(&self, extension: &[u8], label: impl Into<String>) -> Self {
        let child_entropy = Self::from_entropy(extension, "");
        let mut twists = self.twists.clone();
        twists.extend_from_slice(&child_entropy.twists);
        debug_assert!(achieves_zfa(&twists));
        Self { twists, label: label.into() }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn twists(&self) -> &[Twist] {
        &self.twists
    }

    pub fn spectral_gap(&self) -> i64 {
        spectral_gap(&self.twists)
    }

    /// Capabilities are always ZFA-balanced. Verifiable at runtime.
    pub fn is_valid(&self) -> bool {
        achieves_zfa(&self.twists)
    }

    /// Encoded as hex string of twist bytes (for signaling / wire format).
    pub fn to_hex(&self) -> String {
        self.twists.iter().map(|t| format!("{:01x}", *t as u8)).collect()
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cap:{}:{}", self.label, self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_capability_valid() {
        let cap = Capability::root("kernel");
        assert!(cap.is_valid());
        assert_eq!(cap.spectral_gap(), 0);
    }

    #[test]
    fn entropy_capability_valid() {
        let bytes = [0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89];
        let cap = Capability::from_entropy(&bytes, "peer-id");
        assert!(cap.is_valid(), "capability from entropy must be ZFA-balanced");
        assert_eq!(cap.spectral_gap(), 0);
    }

    #[test]
    fn entropy_capability_valid_all_nibbles() {
        // Bytes with high nibbles 1,3 (previously mapped to Down/Left = negative)
        // were the failure case. Test every nibble value.
        for hi in 0u8..16 {
            for lo in 0u8..16 {
                let b = (hi << 4) | lo;
                let cap = Capability::from_entropy(&[b], "test");
                assert!(
                    cap.is_valid(),
                    "byte 0x{:02x} produced unbalanced capability: {}",
                    b, cap.to_hex()
                );
            }
        }
    }

    #[test]
    fn derived_capability_valid() {
        let root = Capability::root("root");
        let child = root.derive(&[0x12, 0x34, 0x56], "child");
        assert!(child.is_valid());
        assert_eq!(child.spectral_gap(), 0);
    }

    #[test]
    fn display_format() {
        let cap = Capability::root("test");
        let s = cap.to_string();
        assert!(s.starts_with("cap:test:"));
    }
}
