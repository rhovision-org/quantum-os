use mre_core::{canonical, parse_rational, update};
use serde::Deserialize;
#[derive(Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
}
#[derive(Deserialize)]
struct Vector {
    name: String,
    prior: String,
    #[serde(rename = "p_E_given_H")]
    p_e_given_h: String,
    #[serde(rename = "p_E_given_notH")]
    p_e_given_not_h: String,
    evidence: String,
    #[serde(rename = "posterior_given_E")]
    posterior_given_e: String,
    #[serde(rename = "posterior_given_notE")]
    posterior_given_not_e: String,
}
#[test]
fn qlf_profile_a_all_reference_vectors() {
    let fixture: Fixture = serde_json::from_str(include_str!("qlf_vectors.json")).unwrap();
    assert_eq!(
        fixture.vectors.len(),
        12,
        "unexpected upstream fixture count"
    );
    for v in fixture.vectors {
        let result = update(
            &parse_rational(&v.prior).unwrap(),
            &parse_rational(&v.p_e_given_h).unwrap(),
            &parse_rational(&v.p_e_given_not_h).unwrap(),
        )
        .unwrap();
        assert_eq!(
            canonical(&result.evidence),
            canonical(&parse_rational(&v.evidence).unwrap()),
            "{}: Z",
            v.name
        );
        assert_eq!(
            canonical(&result.posterior_given_e),
            canonical(&parse_rational(&v.posterior_given_e).unwrap()),
            "{}: posterior E",
            v.name
        );
        assert_eq!(
            canonical(result.posterior_given_not_e.as_ref().unwrap()),
            canonical(&parse_rational(&v.posterior_given_not_e).unwrap()),
            "{}: posterior not E",
            v.name
        );
    }
}
