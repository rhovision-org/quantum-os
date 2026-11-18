# mre-core — QLF Profile A (binary exact rational)

Deterministic, pure Rust implementation of the QLF #221 binary Bayesian/MrE conditioning reference. This is **not** a general maximum-entropy optimizer and has no temperature input.

## Provenance

QLF specification and vectors: `rhovision-org/quantum-logical-framework` at commit `2fc7b3032cb3281709ad45eddf86ff7bfd114258`, paths `MrE_Update.md`, `lean/QLF_MrEUpdate.lean`, and `data/mre_test_vectors.json`. Bundled vector SHA-256: `99b85c395e792eed8b30708d493c03f87d778965634b6db449a04d77759d832f`.

## API and scope

`parse_rational` accepts signed decimal integers or `num/den` with a positive denominator and no floating-point tokens; it normalizes via `BigRational`. `update(p,a,b)` requires `0<p<1`, `0<=a,b<=1`, `Z=p*a+(1-p)*b>0`; returns exact `Z`, `P(H|E)` and `P(H|not E)` when `P(not E)>0`. Impossible observed events fail closed. `canonical` returns reduced rational text. No float arithmetic enters the update.

**Not provided:** KL/EIG numerical evaluation, temperature-dependent maximum-entropy weights, cross-platform certified logarithms, RhoGov adapter, chain integration or validator acceptance. KL and EIG reference diagnostics remain in QLF, and their pointwise-vs-expected bounds must not be conflated. Do not promote Profile B without a separate specification.

Run `cargo test -p mre-core`. The conformance test checks all twelve bundled upstream vectors (including boundary cases) against exact rational results. CI runs the workspace suite on pull requests.

## Browser WASM binding (Profile A)

Enable the `wasm` feature to export `mre_profile_a_json(prior, likelihoodGivenH, likelihoodGivenNotH)` via `wasm-bindgen`. It returns JSON with canonical rational strings and throws for invalid domains. The **same** `update` function is used by native and WASM paths; there is no JavaScript arithmetic implementation. For browser builds, run `wasm-pack build crates/mre-core --target web -- --features wasm` and initialize the generated module explicitly in the client. This is a read-only computation primitive; it does not change governance weights.

`.github/workflows/mre-wasm.yml` compiles the actual wasm32 module (Node.js target for executable CI) and tests all twelve QLF vectors against WASM, rather than merely testing a native feature-gated function.
