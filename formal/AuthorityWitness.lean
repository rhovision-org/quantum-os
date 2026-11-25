import Authority

set_option autoImplicit false
namespace QosAuthority

def rightIndex : Right → Nat
  | .nomination => 0
  | .ballot => 1
  | .lifecycle => 2
  | .grant => 3
  | .close => 4
  | .anchor => 5

def allRights : List Right :=
  [.nomination, .ballot, .lifecycle, .grant, .close, .anchor]

def maskAllows (mask : Nat) (r : Right) : Bool :=
  mask.testBit (rightIndex r)

def maskScope (process mask : Nat) : Scope :=
  ⟨process, fun r => maskAllows mask r = true⟩

def subsetCheck (p c : Nat) : Bool :=
  allRights.all (fun r => !maskAllows c r || maskAllows p r)

theorem subsetCheck_sound (process p c : Nat) (h : subsetCheck p c = true) :
    Narrows (maskScope process p) (maskScope process c) := by
  refine ⟨rfl, ?_⟩
  intro r allowed
  change maskAllows c r = true at allowed
  change maskAllows p r = true
  have member : r ∈ allRights := by cases r <;> decide
  have hall : ∀ x ∈ allRights, (!maskAllows c x || maskAllows p x) = true :=
    List.all_eq_true.mp h
  have hr := hall r member
  simpa [allowed] using hr

#print axioms subsetCheck_sound
end QosAuthority

open QosAuthority
def main : IO Unit := do
  for p in List.range 64 do
    for c in List.range 64 do
      let b := if subsetCheck p c then 1 else 0
      IO.println s!"scope,{p},{c},1,{b}"
      IO.println s!"scope,{p},{c},0,0"
    for r in allRights do
      let b := if maskAllows p r then 1 else 0
      IO.println s!"right,{p},{rightIndex r},{b}"
