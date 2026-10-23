// locker.js — the private hierarchical dictionary, keyed by deployerId.
//
// A `$name` bound to a capability lives in a room today, which means it does not
// outlive the room. The locker is where one survives: your names, your identity
// record, and the credentials other people issued you.
//
// Everything here is reached by capability. The locker sits at a registry uri,
// and every verb takes a `deployerId`, which rnode issues only to the deploy
// that signed for it. Publishing the locker's uri therefore grants nothing:
// holding it still reaches only your own entry. No quoted names — see
// SECURITY.md.
//
// The id IS the authority. There is no equality check anywhere in the contract,
// because there is nothing to check: an entry can only be written under the id
// the caller passed, and the only id a caller can produce is their own.
//
// What restricts the SUBJECT is the shape of each verb, not a permission bit:
//
//   setSelf  reaches "self" and nothing else — never "rev", never "creds"
//   addCred  appends to "creds"; a credential carries the issuer who signed it,
//            so a reader weighs it by who that is rather than by who stored it
//   (nobody) can alter "rev", which register fixed
//
// That is why the write capability register hands back is restricted. A subject
// who could write their own credentials would make credentials worth nothing.
//
// Plain JS with no imports so both the browser and a room agent consume it
// directly, and so its tests run under node with no build:
//
//   node packages/browser/src/locker.js --selftest

/**
 * The locker contract. Deployed once; its uri is then the address everyone uses.
 *
 * Verified against rnode (rholo `dev` at 0a2141be1) by exploratory deploy:
 * register is idempotent and reports `already`, setSelf and addCred land in the
 * right compartments, bind/resolve are isolated per identity (resolving another
 * identity's name returns Nil), and a granted facet writes exactly one key.
 *
 * Re-verified 2026-09-23 against rnodeapi.rhobot.net with signed deploys, by
 * `scripts/localnet/locker-check.mjs` — install, register, register again,
 * bind, resolve, bob resolving alice's name (empty), read, grant, and an
 * unknown verb: 9 of 9. That run exists because two things here were broken
 * and neither showed up in a test that never left the browser:
 *
 *   - the call unwrapped a `(_, caps)` tuple from `rho:registry:lookup`, which
 *     is the Scala shape. This node answers the BARE value, so every call fell
 *     to the default branch and reported `["no locker at", uri]` for a locker
 *     that was present and healthy.
 *   - the answer went only to `return`, which the deploy wrapper forwards to
 *     the key's registry result slot — and that slot is not written on every
 *     node. Every verb now answers on `rho:rchain:deployId` as well.
 *
 * Both were found while building `rgov-core.js`, which hit the same two.
 *
 * Two shape rules, and the first one is not a preference:
 *
 *   1. Every contract takes at least two parameters. A one-binder persistent
 *      receive inside a nested `new` does not terminate — it re-fires until the
 *      reduction budget stops it (rholo#19). These contracts live in a
 *      `new` that the deploy wrapper nests inside another, so the shape applies
 *      here. Nothing needs a one-parameter verb, so nothing is written as one.
 *   2. Readers CONSUME AND RESTORE (`for (@r <- cell) { cell!(r) | … }`). Peek
 *      (`<<-`) would also work; consuming serialises the readers of a cell,
 *      which is the behaviour worth having when several verbs mutate the same
 *      map.
 */
export const LOCKER_RHO = `new records, names,
    doRegister, doSetSelf, doAddCred, doRead, doBind, doResolve, doGrant,
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployId(\`rho:rchain:deployId\`), ret
in {
  records!({}) | names!({}) |

  // Create an identity record. Idempotent: registering twice tells you so
  // rather than resetting what is there.
  contract doRegister(@id, @revAddr, ret) = {
    for (@r <- records) {
      if (r.contains(id)) { records!(r) | ret!(["already", r.get(id).get("rev")]) }
      else {
        records!(r.set(id, {"rev": revAddr, "self": {}, "creds": []})) |
        ret!(["registered", revAddr])
      }
    }
  } |

  // The subject's own profile. Cannot reach "rev" and cannot reach "creds".
  contract doSetSelf(@id, @key, @value, ret) = {
    for (@r <- records) {
      match r.getOrElse(id, Nil) {
        Nil => { records!(r) | ret!(Nil) }
        rec => { records!(r.set(id, rec.set("self", rec.get("self").set(key, value)))) | ret!(true) }
      }
    }
  } |

  // A credential is issued by someone else and held by the subject. Appending
  // one cannot alter "rev" or any credential already there.
  contract doAddCred(@id, @cred, ret) = {
    for (@r <- records) {
      match r.getOrElse(id, Nil) {
        Nil => { records!(r) | ret!(Nil) }
        rec => { records!(r.set(id, rec.set("creds", rec.get("creds") ++ [cred]))) | ret!(true) }
      }
    }
  } |

  contract doRead(@id, ret) = {
    for (@r <- records) { records!(r) | ret!(r.getOrElse(id, Nil)) }
  } |

  // The names dictionary: one namespace per identity, and no verb reads across
  // them. Resolving a name under an identity that did not bind it returns Nil.
  contract doBind(@id, @name, @uri, ret) = {
    for (@n <- names) { names!(n.set(id, n.getOrElse(id, {}).set(name, uri))) | ret!([name, uri]) }
  } |

  contract doResolve(@id, @name, ret) = {
    for (@n <- names) { names!(n) | ret!(n.getOrElse(id, {}).getOrElse(name, Nil)) }
  } |

  // A write-only capability for exactly one name — EIES's +mypriv with the
  // ambient authority removed. The holder can set that key and can do nothing
  // else: not read it, not touch another key, not learn the id it belongs to.
  contract doGrant(@id, @name, ret) = {
    new writeOne in {
      contract writeOne(@uri, r2) = { doBind!(id, name, uri, *r2) } |
      ret!(bundle+{*writeOne})
    }
  } |

  CAPS
}`;

/** The facet map the locker publishes: every verb, each as an unforgeable name. */
const FACETS = `{
    "register": bundle+{*doRegister}, "setSelf": bundle+{*doSetSelf},
    "addCred":  bundle+{*doAddCred},  "read":    bundle+{*doRead},
    "bind":     bundle+{*doBind},     "resolve": bundle+{*doResolve},
    "grant":    bundle+{*doGrant}
  }`;

/**
 * The install program — what a signed deploy submits to put the locker on chain.
 *
 * Published with `insertArbitrary`, which hands back an unpredictable uri —
 * so the installer learns where it went by reading what the deploy answered.
 *
 * NOT insertSigned, though the address would then be predictable: that writes
 * to the one slot a key has, and that slot is where every deploy's answer goes.
 * A locker kept there would be overwritten by the next deploy from the same key,
 * and the answer to that deploy would be the locker. One slot, one job.
 */
export function installProgram() {
  return LOCKER_RHO.replace("CAPS", `insertArbitrary!(${FACETS}, *ret) |
  for (@uri <- ret) { return!(uri) | deployId!(uri) }`);
}

/** A rholang string literal — JSON.stringify produces one. */
const q = (s) => JSON.stringify(String(s));

/**
 * What `rho:registry:lookup` answers with, normalised.
 *
 * MEASURED, not assumed. On rholo a lookup of an `insertArbitrary` value
 * answers **the bare value**: `rec.keys().toList()` gives the facet names and
 * matching it against `(_, caps)` reports "not a tuple". The Scala node's shape
 * was the `(uri, value)` tuple this file used to unwrap — which meant every
 * locker call here fell to its own default branch and reported
 * `["no locker at", uri]` for a locker that was present and healthy.
 *
 * Both shapes are accepted and funnelled into one channel, so neither node's
 * spelling is baked in. Found while building `rgov-core.js`, which does the same.
 */
const UNWRAP_LOOKUP = `match record { (_, c) => { capsCh!(c) } c => { capsCh!(c) } }`;

/**
 * One locker call, as a complete program.
 *
 * Every call is its own deploy, and that is not a limitation to route around —
 * `deployerId` exists only inside a deploy, so a locker operation IS a deploy.
 * Which is as well: a facet reached through `rho:registry:lookup` answers the
 * first call in a program and nothing after it (rholo#21), so batching
 * verbs into one program would not work even if the identity allowed it.
 * The program resolves the locker, takes the one facet it needs, and calls it
 * with the identity rnode issued for this deploy and no other.
 *
 * @param {string} lockerUri  the uri the locker was published at
 * @param {string} verb       register | setSelf | addCred | read | bind | resolve | grant
 * @param {string[]} args     rholang terms, already quoted where they are strings
 */
export function lockerCall(lockerUri, verb, args = []) {
  const extra = args.length ? ", " + args.join(", ") : "";
  // The facet is bound out of the map BY A PATTERN and then quoted back to a
  // name. Sending straight through the lookup — `@(caps.get("register"))!(…)` —
  // silently reaches nothing: a bundle taken from a map is not callable in
  // place, though the same bundle bound to a name is.
  //
  // The match is a pattern rather than a `.get`, because `.get` on something
  // that is not a map is an error rather than a Nil, and what a lookup answers
  // with is not the same on every node (see UNWRAP_LOOKUP). A map missing the
  // verb, a tuple and an integer all fall to `_` here — verified on the node,
  // along with the fact that a map pattern needs at least one key before its
  // remainder (`{...rest}` alone is "expected variable, got Ellipsis").
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`),
    deployId(\`rho:rchain:deployId\`), stored, capsCh, ret in {
  lookup!(\`${lockerUri}\`, *stored) |
  for (@record <- stored) {
    ${UNWRAP_LOOKUP} |
    for (@caps <- capsCh) {
      match caps {
        {${q(verb)}: found, ..._} => {
          @found!(*deployerId${extra}, *ret) |
          // Both channels. \`return\` is what the deploy wrapper forwards to the
          // key's registry result slot; \`deployId\` comes back inside the
          // deploy's own status. The slot is not written on every node — a
          // ProcessedWithSuccess deploy left it empty on the rebuilt playground,
          // so a locker that worked perfectly reported nothing at all.
          for (@answer <- ret) { return!(answer) | deployId!(answer) }
        }
        _ => {
          return!(["no verb", ${q(verb)}, "at", ${q(lockerUri)}]) |
          deployId!(["no verb", ${q(verb)}, "at", ${q(lockerUri)}])
        }
      }
    }
  }
}`;
}

/** Create my identity record. A REV address is what an identity is anchored to. */
export function registerProgram(lockerUri, revAddress) {
  return lockerCall(lockerUri, "register", [q(revAddress)]);
}

/** Bind a name to a capability, so `$name` outlives the room that shared it. */
export function bindProgram(lockerUri, name, uri) {
  return lockerCall(lockerUri, "bind", [q(name), q(uri)]);
}

/** Resolve one of my names. Nobody else's namespace is reachable from here. */
export function resolveProgram(lockerUri, name) {
  return lockerCall(lockerUri, "resolve", [q(name)]);
}

/** Read my identity record: rev, profile, and the credentials I hold. */
export function readProgram(lockerUri) {
  return lockerCall(lockerUri, "read", []);
}

/** Set a field of my own profile. Cannot reach rev or creds. */
export function setSelfProgram(lockerUri, key, value) {
  return lockerCall(lockerUri, "setSelf", [q(key), q(value)]);
}

/**
 * Hold a credential somebody issued me. `cred` is a rholang term, not a string:
 * it carries its issuer, and a reader weighs it by who that is.
 */
export function addCredProgram(lockerUri, credTerm) {
  return lockerCall(lockerUri, "addCred", [String(credTerm)]);
}

/** Mint a write-only capability for exactly one of my names. */
export function grantProgram(lockerUri, name) {
  return lockerCall(lockerUri, "grant", [q(name)]);
}

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/locker.js --selftest
//
// The contract itself is exercised against a live rnode, which this cannot do.
// What it checks is the half that ships: that every program is well-formed,
// names the right verb, and cannot be made to carry an argument out of position.
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
  };
  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";

  const balanced = (s) => {
    const st = [];
    const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };

  ok("the contract is delimiter-balanced", balanced(LOCKER_RHO));
  ok("the contract quotes no name", !/@"/.test(LOCKER_RHO), "@\"…\" — see SECURITY.md");
  ok("every contract takes at least two parameters",
     [...LOCKER_RHO.matchAll(/contract\s+\w+\(([^)]*)\)/g)]
       .every((m) => m[1].split(",").filter((x) => x.trim()).length >= 2),
     "a one-binder persistent receive in a nested new runs away — rholo#19");
  ok("readers consume and restore", !/<<-/.test(LOCKER_RHO));

  const reg = registerProgram(URI, "1111alice");
  ok("register is well-formed", balanced(reg));
  ok("register passes deployerId first", /@found!\(\*deployerId, "1111alice", \*ret\)/.test(reg), reg);
  ok("register names the register facet", reg.includes('{"register": found, ..._}'));
  ok("the facet is bound before it is called",
     /\{"register": found, \.\.\._\}/.test(reg) && /@found!\(\*deployerId/.test(reg), reg.slice(-300));
  // Both shapes, because a lookup does not answer the same way on every node.
  ok("a call accepts either shape lookup may answer with",
     /match record \{ \(_, c\) => \{ capsCh!\(c\) \} c => \{ capsCh!\(c\) \} \}/.test(reg), reg.slice(0, 260));
  ok("a call never uses .get on what lookup answered", !/caps\.get\(/.test(reg),
     ".get on a non-map is an error, not a Nil");
  ok("a call answers on both return and deployId",
     /return!\(answer\) \| deployId!\(answer\)/.test(reg),
     "the registry result slot is not written on every node");

  const bind = bindProgram(URI, "ballot", "rho:id:xyz");
  ok("bind carries name then uri", /!\(\*deployerId, "ballot", "rho:id:xyz", \*ret\)/.test(bind), bind);

  const read = readProgram(URI);
  ok("read passes only the identity", /!\(\*deployerId, \*ret\)/.test(read), read);

  // A string argument cannot escape its position: it reaches rholang through a
  // literal, so quotes and backslashes are escaped rather than closing it.
  const nasty = bindProgram(URI, 'x", *evil) | @"stolen"!("', "rho:id:z");
  ok("a hostile name stays inside its literal", balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')), nasty);

  ok("no quoted name in any program",
     [reg, bind, read, grantProgram(URI, "n"), setSelfProgram(URI, "k", "v")].every((p) => !/@"/.test(p)));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
