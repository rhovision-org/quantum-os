//! QLF #221 Profile A: deterministic exact-rational Bayesian conditioning.
//! No floating-point state transitions, no temperature/max-entropy claims.
use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{One, Zero};
use std::str::FromStr;

pub type Rational = BigRational;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidEncoding,
    InvalidPrior,
    InvalidLikelihood,
    ImpossibleEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub evidence: Rational,
    pub posterior_given_e: Rational,
    pub posterior_given_not_e: Option<Rational>,
}

/// Canonical signed decimal numerator and positive decimal denominator.
/// Accepts noncanonical input only when explicitly normalized by this parser.
pub fn parse_rational(value: &str) -> Result<Rational, Error> {
    let (n, d) = value.split_once('/').map_or((value, "1"), |(n, d)| (n, d));
    if n.is_empty()
        || d.is_empty()
        || n.starts_with('+')
        || d.starts_with('+')
        || d.starts_with('-')
        || n.trim_start_matches('-').is_empty()
        || !n
            .trim_start_matches('-')
            .bytes()
            .all(|c| c.is_ascii_digit())
        || !d.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(Error::InvalidEncoding);
    }
    let numerator = BigInt::from_str(n).map_err(|_| Error::InvalidEncoding)?;
    let denominator = BigInt::from_str(d).map_err(|_| Error::InvalidEncoding)?;
    if denominator.is_zero() {
        return Err(Error::InvalidEncoding);
    }
    Ok(Rational::new(numerator, denominator))
}

pub fn canonical(value: &Rational) -> String {
    if value.denom().is_one() {
        value.numer().to_string()
    } else {
        format!("{}/{}", value.numer(), value.denom())
    }
}

pub fn update(p: &Rational, a: &Rational, b: &Rational) -> Result<Update, Error> {
    let zero = Rational::zero();
    let one = Rational::one();
    if p <= &zero || p >= &one {
        return Err(Error::InvalidPrior);
    }
    if a < &zero || a > &one || b < &zero || b > &one {
        return Err(Error::InvalidLikelihood);
    }
    let complement = &one - p;
    let evidence = p * a + &complement * b;
    if evidence.is_zero() {
        return Err(Error::ImpossibleEvidence);
    }
    let posterior_given_e = (p * a) / &evidence;
    let not_e = &one - &evidence;
    let posterior_given_not_e = if not_e.is_zero() {
        None
    } else {
        Some((p * (&one - a)) / not_e)
    };
    Ok(Update {
        evidence,
        posterior_given_e,
        posterior_given_not_e,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_inputs() {
        for bad in ["", "1/0", "1/-2", "1/2/3", "NaN", "1.0", "+1/2"] {
            assert!(parse_rational(bad).is_err(), "{bad}");
        }
        let p = parse_rational("1/2").unwrap();
        let z = Rational::zero();
        let o = Rational::one();
        assert_eq!(update(&z, &o, &z), Err(Error::InvalidPrior));
        assert_eq!(update(&o, &o, &z), Err(Error::InvalidPrior));
        assert_eq!(update(&p, &z, &z), Err(Error::ImpossibleEvidence));
        assert_eq!(
            update(&p, &parse_rational("3/2").unwrap(), &z),
            Err(Error::InvalidLikelihood)
        );
    }
    #[test]
    fn canonical_reduces_and_handles_big_integers() {
        assert_eq!(
            canonical(
                &parse_rational("100000000000000000000000000000/200000000000000000000000000000")
                    .unwrap()
            ),
            "1/2"
        );
        assert_eq!(canonical(&parse_rational("-2/4").unwrap()), "-1/2");
    }
}

/// Browser-compatible JSON transport. All probabilities remain rational strings.
/// Invalid inputs are returned as an error; no state mutation occurs.
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn mre_profile_a_json(
    prior: &str,
    likelihood_given_h: &str,
    likelihood_given_not_h: &str,
) -> Result<String, String> {
    let p = parse_rational(prior).map_err(|e| format!("{e:?}"))?;
    let a = parse_rational(likelihood_given_h).map_err(|e| format!("{e:?}"))?;
    let b = parse_rational(likelihood_given_not_h).map_err(|e| format!("{e:?}"))?;
    let result = update(&p, &a, &b).map_err(|e| format!("{e:?}"))?;
    serde_json::to_string(&serde_json::json!({
        "evidence": canonical(&result.evidence),
        "posteriorGivenE": canonical(&result.posterior_given_e),
        "posteriorGivenNotE": result.posterior_given_not_e.as_ref().map(canonical),
    }))
    .map_err(|e| e.to_string())
}
