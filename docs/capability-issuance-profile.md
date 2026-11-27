# Candidate capability issuance profile

## Scope

A research-only, opt-in issuer across Rust/WASM, browser fallback and CLI. Default issuance, validation semantics, room keys, existing links and deployed infrastructure remain unchanged. The candidate is not a security certification.

## Entropy target and assumptions

The candidate uses 34 independent uniform bytes per trial of the existing alternating positive/negative encoding and rejects non-scalar Pauli products. The projective Pauli quotient is the Klein four group: the four positive and four negative twist classes each cover it once. Consequently each pair has 16 equally likely encodings and exactly four encodings per quotient class. After any nonempty number of independent pairs, the final quotient class is uniform. Conditioning on the scalar class retains one quarter of the equiprobable encodings. Thus the candidate has an idealized output min-entropy of 134 bits for a fixed label. This is a mathematical distribution result under ideal independent uniform draws and successful rejection sampling, not a measured CSPRNG guarantee. The existing retry cap fails rather than emitting a rejected sample. No extra entropy is claimed from labels, hashes or key derivation. The native tests compare the quotient model with actual Pauli folding for all one- and two-pair cases; this is bounded conformance, not a mechanized general refinement proof.

## Compatibility and migration gates

- Candidate output uses 68 existing-format twist digits. The historical issuer still emits 32. Length identifies the proposed issuance profile for planning only; it is not authenticated version metadata and cannot establish how a received token was generated.
- Existing generic algebra validators remain compatible with candidate shape. CI checks three implementations using synthetic candidates, without contacting a relay. Full application, mixed-version peer, URL, note and persistence compatibility are untested here.
- No silent extension, conversion or rekey of old bearer secrets: that does not create independent randomness. Migration requires fresh secrets, explicit invitation transfer over a trusted channel, deliberate cutover, and a plan for old-room retirement and outstanding bearer rights.
- The candidate does not establish issuer authenticity, revocation, replay protection, capability confinement or post-quantum application security. A versioned authenticated protocol and independent review precede any default change.
