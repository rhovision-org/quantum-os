use zfa_core::{Capability, Twist, is_pauli_closed};

// Projective Pauli classes: scalar, X, Y, Z. Signs and scalar phases
// do not alter the quotient multiplication (Klein four group).
fn class(t: Twist) -> usize {
    match t {
        Twist::Plus | Twist::Minus => 0,
        Twist::Right | Twist::Left => 1,
        Twist::Up | Twist::Down => 2,
        Twist::Slash | Twist::BSlash => 3,
    }
}

#[test]
fn quotient_pair_model_matches_runtime() {
    let pairs: Vec<[Twist; 2]> = (0..4).flat_map(|p| (0..4).map(move |n| [
        Twist::from_u8(2*p).unwrap(), Twist::from_u8(2*n+1).unwrap()
    ])).collect();
    let mut counts = [0; 4];
    for a in &pairs {
        let c = class(a[0]) ^ class(a[1]);
        counts[c] += 1;
        assert_eq!(is_pauli_closed(a), c == 0);
        for b in &pairs {
            let d = class(b[0]) ^ class(b[1]);
            assert_eq!(is_pauli_closed(&[a[0], a[1], b[0], b[1]]), c == d);
        }
    }
    assert_eq!(counts, [4,4,4,4]);
}

#[test]
fn candidate_native_shape_and_closure() {
    for _ in 0..32 {
        let c = Capability::generate_v2_candidate("fixture");
        assert_eq!(c.twists().len(), 68);
        assert!(c.is_valid());
        assert!(c.twists().chunks_exact(2).all(|p| p[0].is_positive() && p[1].is_negative()));
    }
}
