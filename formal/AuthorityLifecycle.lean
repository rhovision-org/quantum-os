import Authority

set_option autoImplicit false
namespace QosAuthority

/-- The concrete proposed issuer must check the entire parent lineage,
    not merely its leaf. Authenticity and durable registry are external. -/
def GrantAllowed (owner rootId actor : Nat) (rootScope : Scope)
    (s : State) (parent child : Scope) (lineage : List Nat) (id : Nat) : Prop :=
  Path owner rootId rootScope actor parent lineage ∧
  Live s.revoked lineage ∧ parent.rights .grant ∧
  Narrows parent child ∧ id ∉ lineage ∧ id ∉ s.revoked

theorem live_extension_implies_parent {revoked lineage : List Nat} {id : Nat}
    (h : Live revoked (id :: lineage)) : Live revoked lineage := by
  intro x hx
  exact h x (List.mem_cons_of_mem _ hx)

theorem revoked_parent_blocks_grant {owner rootId actor id ancestor : Nat}
    {rootScope parent child : Scope} {s : State} {lineage : List Nat}
    (inside : ancestor ∈ lineage) (rev : ancestor ∈ s.revoked) :
    ¬ GrantAllowed owner rootId actor rootScope s parent child lineage id := by
  intro h
  exact h.2.1 ancestor inside rev

theorem grant_child_live {owner rootId actor id : Nat}
    {rootScope parent child : Scope} {s : State} {lineage : List Nat}
    (h : GrantAllowed owner rootId actor rootScope s parent child lineage id) :
    Live s.revoked (id :: lineage) := by
  intro x hx
  rcases List.mem_cons.mp hx with eq | rest
  · subst x
    exact h.2.2.2.2.2
  · exact h.2.1 x rest

theorem revoked_ancestor_persists {owner rootId ancestor id : Nat}
    {rootScope : Scope} {s t : State} {lineage : List Nat}
    (trace : Trace owner rootId rootScope s t)
    (inside : ancestor ∈ lineage) (rev : ancestor ∈ s.revoked) :
    ¬ Live t.revoked (id :: lineage) := by
  intro h
  exact h ancestor (List.mem_cons_of_mem _ inside)
    (trace_revoked_monotone trace ancestor rev)

#print axioms live_extension_implies_parent
#print axioms revoked_parent_blocks_grant
#print axioms grant_child_live
#print axioms revoked_ancestor_persists
end QosAuthority
