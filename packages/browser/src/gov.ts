// Pure governance module — groups, members, issues, and the liquid-democracy
// delegation resolver. No DOM, no storage, no app imports (mirrors polls.ts).
//
// Liquid democracy, governing rule (per issue): if a member casts a ballot their
// own vote counts (it overrides delegation); if they do NOT vote, their vote is
// cast by their standing delegate — transitively, flowing along delegation edges
// to whoever ultimately voted. A chain that reaches no direct voter, or loops,
// abstains. resolveWeights() turns (members, delegations, directVoters) into the
// per-direct-voter weight that feeds the (weighted) poll tally — a deterministic,
// joiner-local computation every peer reproduces from the signed graph it holds.

export type Role = "admin" | "member";
export type IssueStatus = "open" | "closed";

// `anchor` is the member's durable dyncap anchor (SHA-256(seed)), the identity
// that survives across browsers — recorded so membership follows the *identity*,
// not the ephemeral per-tab peerId. Optional for backward compatibility with
// groups created before identity recovery; self-asserted when the member signs.
// `revAddr` is the member's REV address, which is the id the ON-CHAIN
// governance contracts key every row by (rgov-core.js derives it from the
// caller's deployer id and never accepts it as an argument). A room knows
// peerIds and dyncap anchors, not chain addresses, so a member who wants their
// delegations and ratings mirrored on chain publishes theirs here — self-signed
// and self-asserted, like `anchor`. Without it a delegation cannot be pushed,
// because the delegate would have no on-chain name to point at.
export interface Member { peerId: string; role: Role; label: string; at: number; anchor?: string; revAddr?: string }

/**
 * Where a group's on-chain governance lives: one registry uri per contract.
 *
 * Recorded rather than derived, exactly as `Group.uri` and `Group.locker` are —
 * the deploy happened in someone's browser with someone's key, and only they
 * can say where it landed. Three uris rather than one because the three
 * contracts upgrade separately; a directory registration replaces this later
 * with a single constant and three names.
 */
export interface ChainRefs {
  inbox?: string; group?: string; issue?: string;
  /** Last independently read-back success-charter/1 handoff, not approval. */
  charterHash?: string;
  charterProposalId?: string;
  charterIssueUri?: string;
}

// A member's password-encrypted identity, replicated in the group so they can
// recover it (with the password) by rejoining the group's room in a new browser.
// `blob` is a `qos-vault:v1:…` string (vault.ts); keyed in Group.vaults by a
// public, user-chosen `handle` (what the recovering user types). `anchor` binds
// the vault to the identity inside it (first-write-wins by handle, overwrite
// only by the same anchor — the lemma squatting rule).
export interface VaultRecord { handle: string; anchor: string; blob: string; at: number }
export interface Delegation { delegate: string; at: number }      // delegator -> { delegate }
export interface Issue { id: string; title: string; by: string; at: number; status: IssueStatus; pollId?: string }

export interface Group {
  id: string;
  name: string;
  creator: string;                          // creator peerId — admin by construction
  creatorLabel: string;
  createdAt: number;
  members: Record<string, Member>;          // peerId -> Member
  delegations: Record<string, Delegation>;  // delegator peerId -> { delegate, at } — standing/global
  // Optional per-issue delegate that overrides the global one for that issue:
  // issueId -> (delegator peerId -> { delegate, at }).
  topicDelegations?: Record<string, Record<string, Delegation>>;
  // Optional affirmative-trust ratings (the RGOV liquid-*trust* extension): each
  // member rates the trustworthiness of others, rater peerId -> ratee peerId ->
  // non-negative integer (0–TRUST_MAX). Self-signed (you set only your own row).
  // A member's base voting weight grows with the trust others place in them, so
  // delegation flow is weighted by earned trust — not one-person-one-vote.
  trustRatings?: Record<string, Record<string, number>>;
  // Optional accountability censures: censurer peerId -> target peerId -> 1. A
  // member of equal-or-higher standing flags a target as holding *undeserved*
  // trust; when credible censure outweighs the target's level they are
  // discredited (level→0) AND everyone who vouched for them is slashed by the
  // level they staked. Self-signed. This makes conferring trust a stake, not a
  // free action — accountability for assigning undeserved trust.
  censures?: Record<string, Record<string, number>>;
  // Optional `/note` currencies the group uses: a treasury (group funds) and a
  // kudos (reputation) currency. The admin declares them; balances are bearer
  // notes held privately by each member.
  treasury?: string;
  /** The group's on-chain governance contracts, if it has any. See ChainRefs. */
  chain?: ChainRefs;
  // The group's on-chain record, if it has one: a registry URI written by
  // /rholang. A room is ephemeral and a registry entry is not, so this is the
  // group's durable name — the thing to look it up by after every browser here
  // has closed. Recorded, not derived: whoever deployed it says what it is.
  uri?: string;
  // The locker the group uses — a directory contract someone installed and the
  // group agreed to share. Recorded here so that being in a group is enough to
  // reach it: a member should not have to be told a uri out of band that the
  // group already knows.
  locker?: string;
  kudos?: string;
  // Members' password-encrypted identities, handle -> VaultRecord, replicated so
  // a member can recover their identity in a new browser (see VaultRecord). The
  // ciphertext is safe to hold/serve; the password is the only decryption gate.
  vaults?: Record<string, VaultRecord>;
  issues: Issue[];
}

/** A valid `/note` currency derived from the group (treasury / kudos), unique per group. */
export function govCurrency(g: Group, suffix: string): string {
  const base = (g.name.replace(/[^A-Za-z0-9]/g, "") || "GRP").slice(0, 16);
  return `${base}_${g.id.slice(-4)}${suffix}`;
}

const normalize = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Stable content-hash id for an issue title (djb2 over normalized text). */
export function issueId(title: string): string {
  const s = normalize(title);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Resolve an identity (a live peerId, and optionally its verified dyncap anchor)
// to the member's map key. Prefers a direct peerId hit; falls back to matching a
// member by durable `anchor` — so a member who recovered their identity in a new
// browser (new peerId, same anchor) is still recognized until `rekeyMember` moves
// their record onto the new peerId.
export function memberKeyFor(g: Group, peerId: string, anchor?: string): string | undefined {
  if (g.members[peerId]) return peerId;
  if (anchor) return Object.keys(g.members).find((k) => g.members[k].anchor === anchor);
  return undefined;
}
export function isMember(g: Group, peerId: string, anchor?: string): boolean {
  return memberKeyFor(g, peerId, anchor) !== undefined;
}
export function isAdmin(g: Group, peerId: string, anchor?: string): boolean {
  if (peerId === g.creator) return true;
  const k = memberKeyFor(g, peerId, anchor);
  return !!k && (k === g.creator || g.members[k]?.role === "admin");
}
export function memberLabel(g: Group, peerId: string, anchor?: string): string {
  const k = memberKeyFor(g, peerId, anchor);
  return (k && g.members[k]?.label) || peerId.slice(0, 8);
}

// Move a member's record (and every peerId-keyed reference to them) onto a new
// peerId — used when a member returns on a new browser with the same durable
// anchor but a fresh ephemeral peerId. Deterministic; keeps delegations, trust,
// censures, and the creator pointer consistent so vote resolution stays correct.
export function rekeyMember(g: Group, oldId: string, newId: string): void {
  if (oldId === newId || !g.members[oldId]) return;
  const remap = (id: string): string => (id === oldId ? newId : id);

  const m = g.members[oldId];
  delete g.members[oldId];
  m.peerId = newId;
  g.members[newId] = m;

  const nd: Record<string, Delegation> = {};
  for (const [k, v] of Object.entries(g.delegations)) nd[remap(k)] = { ...v, delegate: remap(v.delegate) };
  g.delegations = nd;

  if (g.topicDelegations) {
    for (const iss of Object.keys(g.topicDelegations)) {
      const nt: Record<string, Delegation> = {};
      for (const [k, v] of Object.entries(g.topicDelegations[iss])) nt[remap(k)] = { ...v, delegate: remap(v.delegate) };
      g.topicDelegations[iss] = nt;
    }
  }

  const remapRows = (rm?: Record<string, Record<string, number>>): Record<string, Record<string, number>> | undefined => {
    if (!rm) return rm;
    const out: Record<string, Record<string, number>> = {};
    for (const [rater, row] of Object.entries(rm)) {
      const nrow: Record<string, number> = {};
      for (const [ratee, v] of Object.entries(row)) nrow[remap(ratee)] = v;
      out[remap(rater)] = nrow;
    }
    return out;
  };
  g.trustRatings = remapRows(g.trustRatings);
  g.censures = remapRows(g.censures);

  if (g.creator === oldId) g.creator = newId;
}
export function findIssue(g: Group, id: string): Issue | undefined {
  return g.issues.find((i) => i.id === id || issueId(i.title) === id);
}

export interface WeightResolution {
  weightByVoter: Record<string, number>;   // direct voter -> effective weight (1 + delegated subtree)
  flow: Record<string, string>;            // member -> the direct voter their vote flows to
  abstained: string[];                     // members whose chain dead-ends or loops with no direct voter
}

// Resolve effective voting weights for one issue.
//  - `members`: the electorate (peerIds). Only members carry weight.
//  - `delegations`: delegator -> delegate (delegate must be a member to count).
//  - `directVoters`: members who cast a ballot on this issue (override delegation).
//  - `trustWeights` (optional): member -> base weight. Default 1 per member, which
//    reproduces one-person-one-vote liquid democracy exactly. With trust ratings
//    (trustWeightsFor) a member carries the trust others place in them, so the
//    delegation flow is trust-weighted (the RGOV liquid-*trust* extension).
// Each member's vote flows along delegation edges to the first direct voter
// reached; weight(d) = Σ baseWeight(m) over members m flowing to d. Cycles /
// dead-ends with no direct voter abstain.
export function resolveWeights(
  members: string[],
  delegations: Record<string, string>,
  directVoters: Set<string>,
  trustWeights: Record<string, number> = {},
): WeightResolution {
  const memberSet = new Set(members);
  const weightByVoter: Record<string, number> = {};
  const flow: Record<string, string> = {};
  const abstained: string[] = [];

  const baseWeight = (m: string): number => {
    const w = trustWeights[m];
    return typeof w === "number" && w >= 0 ? w : 1;   // default / guard
  };

  for (const m of members) {
    const seen = new Set<string>();
    let node: string | undefined = m;
    let landed: string | null = null;
    while (node !== undefined) {
      if (directVoters.has(node)) { landed = node; break; }  // reached someone who voted
      if (seen.has(node)) break;                             // cycle, no direct voter
      seen.add(node);
      const next: string | undefined = delegations[node];
      if (next === undefined || !memberSet.has(next)) break; // dead-end (no / non-member delegate)
      node = next;
    }
    if (landed) {
      flow[m] = landed;
      weightByVoter[landed] = (weightByVoter[landed] ?? 0) + baseWeight(m);
    } else {
      abstained.push(m);
    }
  }
  return { weightByVoter, flow, abstained };
}

/** Trust levels: admins are the root (TRUST_MAX); each rating confers a level
 *  strictly below the rater's own. So 0..TRUST_MAX is the full rank ladder. */
export const TRUST_MAX = 5;

// Affirmative trust as a HIERARCHICAL web of trust rooted at the group's admins:
// a member may only confer a trust level **strictly below their own**. Admins are
// the trust root (level TRUST_MAX); a rating `v` from rater `r` confers
// `min(v, level(r) − 1)` on the ratee; a member's level is the highest level
// conferred on them. This is a monotone relaxation toward the least fixed point
// ≥ the admin seed, so it is deterministic (order-independent) and two untrusted
// members CANNOT bootstrap each other — trust must descend from an admin, and it
// strictly decreases at each hop. Returns peerId -> level (0..TRUST_MAX).
export function trustLevels(g: Group): Record<string, number> {
  const ids = Object.keys(g.members);
  const memberSet = new Set(ids);
  const ratings = g.trustRatings;

  // Phase 1 — positive trust: admin-rooted increasing least fixed point. A rating
  // v from r confers min(v, level(r)−1) — strictly below the rater's own level.
  const pos: Record<string, number> = {};
  for (const m of ids) pos[m] = isAdmin(g, m) ? TRUST_MAX : 0;     // admins seed the root
  if (ratings) {
    const maxRounds = ids.length * (TRUST_MAX + 1) + 1;            // LFP converges well within this
    for (let round = 0; round < maxRounds; round++) {
      let changed = false;
      for (const rater of ids) {
        const cap = pos[rater] - 1;                                // strictly below the rater's own level
        if (cap < 0) continue;                                     // level-0 members can confer nothing
        const row = ratings[rater];
        if (!row) continue;
        for (const ratee of Object.keys(row)) {
          if (ratee === rater || !memberSet.has(ratee)) continue;  // no self / non-member
          const v = row[ratee];
          if (typeof v !== "number" || !(v > 0)) continue;
          const conferred = Math.min(v, cap);
          if (conferred > pos[ratee]) { pos[ratee] = conferred; changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  const censures = g.censures;
  if (!censures) return pos;

  // Phase 2 — accountability: a decreasing fixed point. The *eligible censurers*
  // of a target t are the members whose current standing ≥ t's (you can call out
  // a peer or subordinate, not someone above you). t is discredited when a QUORUM
  // of that eligible body has censured t — a ⅔ supermajority, floored at 2 — so
  // **no single member, admin included, acts alone, and a disagreeing admin
  // (counted in the eligible body but not the censuring set) cannot block a real
  // quorum.** On discredit, t→0 and every member who conferred trust on t is
  // slashed by the level they staked. Slashing a voucher can in turn discredit
  // them; the loop converges because levels only fall (bounded by phase 1).
  const eff: Record<string, number> = { ...pos };
  const maxRounds = ids.length + 2;
  for (let round = 0; round < maxRounds; round++) {
    // Decide all discredits from a consistent snapshot of `eff` BEFORE mutating,
    // so the round is order-independent (deterministic).
    const toDiscredit: string[] = [];
    for (const t of ids) {
      if (eff[t] <= 0) continue;
      let eligible = 0, censured = 0;
      for (const c of ids) {
        if (c === t || eff[c] < eff[t]) continue;                  // eligible: standing ≥ target
        eligible++;
        if (censures[c]?.[t] && memberSet.has(t)) censured++;       // … and actually censured t
      }
      const quorum = Math.max(2, Math.ceil((2 * eligible) / 3));    // ⅔ supermajority, min 2
      if (censured >= quorum) toDiscredit.push(t);
    }
    if (toDiscredit.length === 0) break;
    for (const t of toDiscredit) {
      eff[t] = 0;
      for (const v of ids) {                                       // slash everyone who vouched for t
        const stake = ratings?.[v]?.[t];
        if (typeof stake === "number" && stake > 0 && eff[v] > 0) {
          eff[v] = Math.max(0, eff[v] - Math.min(stake, pos[v]));
        }
      }
    }
  }
  return eff;
}

/** Members discredited by accountability censure (level driven to 0 despite a
 *  positive phase-1 standing). Useful for status readouts. */
export function discreditedMembers(g: Group): string[] {
  if (!g.censures) return [];
  const eff = trustLevels(g);
  return Object.keys(g.members).filter(
    (m) => !isAdmin(g, m) && eff[m] === 0 &&
      Object.values(g.trustRatings ?? {}).some((row) => row && (row[m] ?? 0) > 0),
  );
}

// Per-member base voting weight for resolveWeights: `1 + trustLevel(m)`. With NO
// ratings anywhere the group is flat (weight 1 each) — trust weighting is opt-in
// and backward-compatible; once any rating exists the admin-rooted hierarchy
// (trustLevels) applies and admins carry the root weight `1 + TRUST_MAX`.
export function trustWeightsFor(g: Group): Record<string, number> {
  const ids = Object.keys(g.members);
  const out: Record<string, number> = {};
  const hasRatings = !!g.trustRatings &&
    Object.values(g.trustRatings).some((row) => row && Object.keys(row).length > 0);
  if (!hasRatings) { for (const m of ids) out[m] = 1; return out; }
  const level = trustLevels(g);
  for (const m of ids) out[m] = 1 + (level[m] ?? 0);
  return out;
}

/** Members (excluding self) whose vote flowed to `voter`, for a "self + A + B" readout. */
export function delegatorsOf(res: WeightResolution, voter: string): string[] {
  return Object.entries(res.flow).filter(([m, d]) => d === voter && m !== voter).map(([m]) => m);
}

// The effective delegation map for one issue: each member's per-issue delegate
// (topicDelegations[issueId]) overrides their standing/global delegate. Feed the
// result straight into resolveWeights — the resolver itself is unchanged.
export function delegationMapFor(g: Group, issueIdStr: string): Record<string, string> {
  const topic = g.topicDelegations?.[issueIdStr] ?? {};
  const out: Record<string, string> = {};
  for (const peerId of Object.keys(g.members)) {
    const d = topic[peerId]?.delegate ?? g.delegations[peerId]?.delegate;
    if (d) out[peerId] = d;
  }
  return out;
}
