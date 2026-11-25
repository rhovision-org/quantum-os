import Std

/-! Abstract authorization model. No ZFA, entropy or cryptographic axiom.
Authenticated actor and certified grant provenance are explicit premises. -/
set_option autoImplicit false
namespace QosAuthority

inductive Right where
  | nomination | ballot | lifecycle | grant | close | anchor
  deriving DecidableEq, Repr

structure Scope where
  process : Nat
  rights : Right → Prop

def Narrows (parent child : Scope) : Prop :=
  child.process = parent.process ∧ ∀ r, child.rights r → parent.rights r

theorem narrows_refl (s : Scope) : Narrows s s :=
  ⟨rfl, fun _ h => h⟩

theorem narrows_trans {a b c : Scope} (hab : Narrows a b) (hbc : Narrows b c) :
    Narrows a c :=
  ⟨hbc.1.trans hab.1, fun r h => hab.2 r (hbc.2 r h)⟩

/-- A certified path is indexed by holder, scope and lineage of grant IDs.
    The grant constructor requires authority to delegate, attenuation and
    a fresh ID within this path. Global ID uniqueness/authenticity is external. -/
inductive Path (rootOwner rootId : Nat) (rootScope : Scope) :
    Nat → Scope → List Nat → Prop where
  | root : Path rootOwner rootId rootScope rootOwner rootScope [rootId]
  | delegate {holder target id : Nat} {parent child : Scope} {lineage : List Nat} :
      Path rootOwner rootId rootScope holder parent lineage →
      parent.rights .grant → Narrows parent child → id ∉ lineage →
      Path rootOwner rootId rootScope target child (id :: lineage)

theorem path_non_amplification {owner rootId holder : Nat} {rootScope scope : Scope}
    {lineage : List Nat} (p : Path owner rootId rootScope holder scope lineage) :
    Narrows rootScope scope := by
  induction p with
  | root => exact narrows_refl _
  | delegate _ _ narrow _ ih => exact narrows_trans ih narrow

theorem path_preserves_root_id {owner rootId holder : Nat} {rootScope scope : Scope}
    {lineage : List Nat} (p : Path owner rootId rootScope holder scope lineage) :
    rootId ∈ lineage := by
  induction p with
  | root => simp
  | delegate _ _ _ _ ih => exact List.mem_cons_of_mem _ ih

def Live (revoked lineage : List Nat) : Prop :=
  ∀ id, id ∈ lineage → id ∉ revoked

structure State where
  revoked : List Nat
  seen : List Nat

/-- Authorization is separate from replay filtering. The actor is assumed
    authenticated by an external mechanism, not by this model. -/
def Authorized (owner rootId : Nat) (rootScope : Scope) (s : State)
    (actor process : Nat) (right : Right) : Prop :=
  ∃ scope lineage, Path owner rootId rootScope actor scope lineage ∧
    Live s.revoked lineage ∧ scope.process = process ∧ scope.rights right

theorem authorized_root_bound {owner rootId actor process : Nat} {rootScope : Scope}
    {s : State} {right : Right}
    (h : Authorized owner rootId rootScope s actor process right) :
    process = rootScope.process ∧ rootScope.rights right := by
  obtain ⟨scope, _, path, _, processEq, allowed⟩ := h
  have narrow := path_non_amplification path
  exact ⟨processEq.symm.trans narrow.1, narrow.2 right allowed⟩

theorem revoked_lineage_denied {revoked lineage : List Nat} {id : Nat}
    (inside : id ∈ lineage) (rev : id ∈ revoked) : ¬ Live revoked lineage :=
  fun live => live id inside rev

theorem revoked_root_denies {owner rootId actor process : Nat} {rootScope : Scope}
    {s : State} {right : Right} (rev : rootId ∈ s.revoked) :
    ¬ Authorized owner rootId rootScope s actor process right := by
  intro h
  obtain ⟨_, _, path, live, _, _⟩ := h
  exact live rootId (path_preserves_root_id path) rev

/-- Proposed serial transition model: execution consumes a request ID;
    only the authenticated root owner may revoke. Revocation is permanent.
    Requests and grant IDs must be globally unique within their domains. -/
inductive Step (owner rootId : Nat) (rootScope : Scope) : State → State → Prop where
  | execute {s : State} {actor process request : Nat} {right : Right} :
      Authorized owner rootId rootScope s actor process right →
      request ∉ s.seen →
      Step owner rootId rootScope s {s with seen := request :: s.seen}
  | revoke {s : State} {actor id : Nat} :
      actor = owner →
      Step owner rootId rootScope s {s with revoked := id :: s.revoked}

theorem step_revoked_monotone {owner rootId : Nat} {rootScope : Scope} {s t : State}
    (step : Step owner rootId rootScope s t) :
    ∀ id, id ∈ s.revoked → id ∈ t.revoked := by
  intro id h
  cases step with
  | execute _ _ => exact h
  | revoke _ => exact List.mem_cons_of_mem _ h

theorem step_seen_monotone {owner rootId : Nat} {rootScope : Scope} {s t : State}
    (step : Step owner rootId rootScope s t) :
    ∀ id, id ∈ s.seen → id ∈ t.seen := by
  intro id h
  cases step with
  | execute _ _ => exact List.mem_cons_of_mem _ h
  | revoke _ => exact h

inductive Trace (owner rootId : Nat) (rootScope : Scope) : State → State → Prop where
  | nil (s : State) : Trace owner rootId rootScope s s
  | cons {s t u : State} :
      Step owner rootId rootScope s t → Trace owner rootId rootScope t u →
      Trace owner rootId rootScope s u

theorem trace_revoked_monotone {owner rootId : Nat} {rootScope : Scope} {s t : State}
    (trace : Trace owner rootId rootScope s t) :
    ∀ id, id ∈ s.revoked → id ∈ t.revoked := by
  induction trace with
  | nil _ => exact fun _ h => h
  | cons step _ ih => exact fun id h => ih id (step_revoked_monotone step id h)

theorem trace_seen_monotone {owner rootId : Nat} {rootScope : Scope} {s t : State}
    (trace : Trace owner rootId rootScope s t) :
    ∀ id, id ∈ s.seen → id ∈ t.seen := by
  induction trace with
  | nil _ => exact fun _ h => h
  | cons step _ ih => exact fun id h => ih id (step_seen_monotone step id h)

theorem replay_denied_after_trace {owner rootId request : Nat} {rootScope : Scope}
    {s t : State} (trace : Trace owner rootId rootScope s t) (used : request ∈ s.seen) :
    ¬ request ∉ t.seen :=
  fun fresh => fresh (trace_seen_monotone trace request used)

theorem revoked_root_stays_denied {owner rootId actor process : Nat} {rootScope : Scope}
    {s t : State} {right : Right} (trace : Trace owner rootId rootScope s t)
    (revoked : rootId ∈ s.revoked) :
    ¬ Authorized owner rootId rootScope t actor process right :=
  revoked_root_denies (trace_revoked_monotone trace rootId revoked)

-- Positive and negative controls: concrete finite rights, no opaque security flags.
def rootFixture : Scope := ⟨7, fun r => r = .grant ∨ r = .ballot⟩
def childFixture : Scope := ⟨7, fun r => r = .ballot⟩

theorem fixture_narrow : Narrows rootFixture childFixture :=
  ⟨rfl, fun _ h => Or.inr h⟩

theorem fixture_grant : Path 1 100 rootFixture 2 childFixture [101,100] :=
  Path.delegate Path.root (Or.inl rfl) fixture_narrow (by decide)

example : Authorized 1 100 rootFixture ⟨[],[]⟩ 2 7 .ballot := by
  refine ⟨childFixture, [101,100], fixture_grant, ?_, rfl, rfl⟩
  intro id _
  simp

example : ¬ Authorized 1 100 rootFixture ⟨[],[]⟩ 2 7 .anchor := by
  intro h
  have impossible := (authorized_root_bound h).2
  change Right.anchor = Right.grant ∨ Right.anchor = Right.ballot at impossible
  simp at impossible

example : ¬ Authorized 1 100 rootFixture ⟨[],[]⟩ 2 8 .ballot := by
  intro h
  have impossible := (authorized_root_bound h).1
  change 8 = 7 at impossible
  contradiction

example : ¬ Live [101] [101,100] :=
  revoked_lineage_denied (id := 101) (by decide) (by decide)

example : ¬ Authorized 1 100 rootFixture ⟨[100],[]⟩ 2 7 .ballot :=
  revoked_root_denies (by decide)

#print axioms path_non_amplification
#print axioms authorized_root_bound
#print axioms revoked_root_denies
#print axioms replay_denied_after_trace
#print axioms revoked_root_stays_denied

end QosAuthority
