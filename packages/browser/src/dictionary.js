// dictionary.js — the master dictionary, redesigned.
//
// Design and the measurements behind it: ../../../MasterDictionary.md. This is a
// working prototype, deployable to any chain, so the genesis proposal arrives
// with evidence instead of a sketch.
//
// WHAT IT REPLACES. The dictionary at genesis today stores nothing. `Directory`,
// `Echo` and `Log` in its map are the SAME unforgeable — one stateless factory
// under three names — and `Directory.rho`'s `contract directory(…)` opens
// `new mapCh, read, write, grant in { mapCh!({}) … }` on every call, so calling
// it mints a fresh empty dictionary. A grant-and-write succeeds, reports
// "added", and lands in a throwaway nobody else can see. Measured: write into
// instance A, read the same key from instance B -> Nil. A naming system in which
// a successful write means nothing, and says nothing.
//
// THE CORE MOVE: a name is rooted in the identity that owns it.
//
//     1111alice…/inbox        1111alice…/gov/colab/group        1111bob…/inbox
//
// A caller may write under their own REV address prefix and no other — not by a
// permission check but by derivation:
//
//     revAddr!("fromDeployerId", *_id, *a) | for (@me <- a) { … me ++ "/" … }
//
// Verified on the node: a deployed contract calling rho:rev:address on a
// passed-through deployer id gets THE CALLER's address, across deploys and
// identities, and a forged deployer id yields Nil (hence the Nil guard — without
// it, one shared row becomes writable by anyone who can produce a Nil).
//
// That one move settles three requirements with no policy, no admin and no fee:
// publishing is self-service (nobody need act first), squatting is not
// expressible (you cannot NAME a path that is not yours), and the namespace is
// unbounded without a genesis change. It is the rule that makes rgov-core's
// `self` facet safe to publish, applied to naming.
//
// SHORT NAMES ARE A GOVERNED TIER, AND THEY ARE ALIASES. Bare `Inbox` is scarce
// and therefore governed; `1111alice…/inbox` is abundant and therefore free. A
// short name holds a pointer to a rooted path and never a value, so upgrading
// what `Inbox` means is re-pointing the alias: no client changes, no uri to
// redistribute. Who holds that authority is a policy decision this contract
// deliberately does not make — it holds one capability and lets whatever governs
// it govern it.
//
// VERSIONS ARE APPEND-ONLY, so every published version is immutable by
// construction and `resolveAt(path, 3)` answers the same thing forever. What a
// client cannot otherwise rely on is that a BARE resolve stays put, so `seal`
// closes a path to further versions. Pin a version or require a seal — both are
// legitimate and the choice is the client's.
//
// GRANTS ARE REVOCABLE. `grant(path)` returns a writekey bound to one path and
// to the path's epoch at the time of granting; `revoke(path)` bumps the epoch
// and every writekey issued before it stops working. `Directory.rho`'s grant had
// no way to withdraw — a capability you cannot withdraw is one you can only ever
// give away once.
//
// Plain JS with no imports, so the browser and a room agent consume it directly
// and its tests run under node with no build:
//
//   node packages/browser/src/dictionary.js --selftest

/** A rholang string literal — JSON.stringify produces one. */
const q = (s) => JSON.stringify(String(s));

/**
 * state  : { path: {"owner": addr, "versions": [v, …], "sealed": bool, "epoch": int} }
 * aliases: { short: {"path": path, "version": int|Nil} }
 * rootCh : the address allowed to set short names
 */
export const DICTIONARY_RHO = `new state, aliases, rootCh,
    resolveFacet, publishFacet, rootFacet, doResolve, doPublish, doRoot,
    grantedPublish, listFold, valueAt,
    revAddr(\`rho:rev:address\`),
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), deployId(\`rho:rchain:deployId\`), ret
in {
  state!({}) | aliases!({}) |

  // ---- facets -------------------------------------------------------------

  // Public, and self-scoped: the caller's identity is DERIVED here and nowhere
  // else, so a path outside their own root cannot be named by them.
  contract publishFacet(_id, @verb, @args, ret) = {
    new a in {
      revAddr!("fromDeployerId", *_id, *a) |
      for (@me <- a) {
        match me {
          // Not an error from the powerbox — a Nil. Refuse loudly.
          Nil => { ret!(("dir-error", "no identity")) }
          _   => { doPublish!(me, verb, args, *ret) }
        }
      }
    }
  } |

  // Public, free, and grants nothing by being read.
  contract resolveFacet(@verb, @args, ret) = { doResolve!(verb, args, *ret) } |

  // The one political verb, gated on the address genesis puts in rootCh.
  contract rootFacet(_id, @verb, @args, ret) = {
    new a in {
      revAddr!("fromDeployerId", *_id, *a) |
      for (@me <- a; @root <- rootCh) {
        rootCh!(root) |
        match me == root {
          true  => { doRoot!(verb, args, *ret) }
          false => { ret!(("dir-error", "not the root authority")) }
        }
      }
    }
  } |

  // ---- helpers ------------------------------------------------------------

  // Fold the path list, keeping those under a prefix. A public enumerable
  // registry is a good discovery story and an unbounded read; bounding it is an
  // open question in the design note, not something to pretend away here.
  contract listFold(@rows, @prefix, @acc, ret) = {
    match rows {
      [] => { ret!(acc) }
      [(k, v) ...rest] => {
        match k.slice(0, prefix.length()) == prefix {
          true  => { listFold!(rest, prefix, acc ++ [k], *ret) }
          false => { listFold!(rest, prefix, acc, *ret) }
        }
      }
    }
  } |

  // One version of one path, or Nil. A Nil version means "the latest".
  contract valueAt(@s, @path, @version, ret) = {
    match s.getOrElse(path, Nil) {
      Nil => { ret!(Nil) }
      rec => {
        let @vs <- rec.getOrElse("versions", []) in {
          match version {
            Nil => {
              match vs.length() == 0 { true => { ret!(Nil) } false => { ret!(vs.nth(vs.length() - 1)) } }
            }
            _ => {
              match version >= 0 and version < vs.length() {
                true  => { ret!(vs.nth(version)) }
                false => { ret!(Nil) }
              }
            }
          }
        }
      }
    }
  } |

  // ---- publish ------------------------------------------------------------

  contract doPublish(@me, @verb, @args, ret) = {
    for (@s <- state) {
      match [verb, args] {
        // THE PREFIX CHECK IS THE WHOLE ACCESS-CONTROL SYSTEM. \`me\` was derived
        // and never supplied, so there is no permission to get wrong: a caller
        // simply cannot express a path outside their own root.
        ["publish", [path, value]] => {
          match path.slice(0, me.length() + 1) == me ++ "/" {
            false => { state!(s) | ret!(("dir-error", "not your namespace", path, me)) }
            true  => {
              let @rec <- s.getOrElse(path, {"owner": me, "versions": [], "sealed": false, "epoch": 0}) in {
                match rec.getOrElse("sealed", false) {
                  true  => { state!(s) | ret!(("dir-error", "sealed", path)) }
                  false => {
                    let @vs <- rec.getOrElse("versions", []) in {
                      state!(s.set(path, rec.set("versions", vs ++ [value]))) |
                      ret!(("published", path, vs.length()))
                    }
                  }
                }
              }
            }
          }
        }

        // Close a path to further versions. Each version is already immutable —
        // the list is append-only — so what this adds is that a BARE resolve of
        // this path will never answer differently again.
        ["seal", [path]] => {
          match s.getOrElse(path, Nil) {
            Nil => { state!(s) | ret!(("dir-error", "no such path", path)) }
            rec => {
              match rec.getOrElse("owner", Nil) == me {
                false => { state!(s) | ret!(("dir-error", "not yours", path)) }
                true  => { state!(s.set(path, rec.set("sealed", true))) | ret!(("sealed", path)) }
              }
            }
          }
        }

        // A writekey bound to ONE path and to that path's epoch at the moment of
        // granting. Revoking bumps the epoch, which is what makes it withdrawable.
        ["grant", [path]] => {
          match s.getOrElse(path, Nil) {
            Nil => { state!(s) | ret!(("dir-error", "no such path", path)) }
            rec => {
              match rec.getOrElse("owner", Nil) == me {
                false => { state!(s) | ret!(("dir-error", "not yours", path)) }
                true  => {
                  let @ep <- rec.getOrElse("epoch", 0) in {
                    new writekey in {
                      contract writekey(@value, r2) = { grantedPublish!(path, ep, value, *r2) } |
                      state!(s) | ret!(("granted", path, ep, bundle+{*writekey}))
                    }
                  }
                }
              }
            }
          }
        }

        ["revoke", [path]] => {
          match s.getOrElse(path, Nil) {
            Nil => { state!(s) | ret!(("dir-error", "no such path", path)) }
            rec => {
              match rec.getOrElse("owner", Nil) == me {
                false => { state!(s) | ret!(("dir-error", "not yours", path)) }
                true  => {
                  let @ep <- rec.getOrElse("epoch", 0) in {
                    state!(s.set(path, rec.set("epoch", ep + 1))) | ret!(("revoked", path, ep + 1))
                  }
                }
              }
            }
          }
        }

        _ => { state!(s) | ret!(("dir-error", "bad verb or arity", verb)) }
      }
    }
  } |

  // A granted writekey's publish. No identity is derived here — holding the
  // writekey IS the authority — but it reaches exactly one path, and only while
  // the epoch it was minted against is still current.
  contract grantedPublish(@path, @ep, @value, ret) = {
    for (@s <- state) {
      match s.getOrElse(path, Nil) {
        Nil => { state!(s) | ret!(("dir-error", "no such path", path)) }
        rec => {
          match [rec.getOrElse("epoch", 0) == ep, rec.getOrElse("sealed", false)] {
            [false, _] => { state!(s) | ret!(("dir-error", "revoked", path)) }
            [_, true]  => { state!(s) | ret!(("dir-error", "sealed", path)) }
            _ => {
              let @vs <- rec.getOrElse("versions", []) in {
                state!(s.set(path, rec.set("versions", vs ++ [value]))) |
                ret!(("published", path, vs.length()))
              }
            }
          }
        }
      }
    }
  } |

  // ---- resolve ------------------------------------------------------------

  contract doResolve(@verb, @args, ret) = {
    for (@s <- state; @al <- aliases) {
      state!(s) | aliases!(al) |
      match [verb, args] {
        // A short name is one the alias map knows; anything else is a path. No
        // string search, and no way for the two tiers to be confused.
        ["resolve", [name]] => {
          match al.getOrElse(name, Nil) {
            Nil => { valueAt!(s, name, Nil, *ret) }
            a   => { valueAt!(s, a.getOrElse("path", ""), a.getOrElse("version", Nil), *ret) }
          }
        }
        ["resolveAt", [name, version]] => {
          match al.getOrElse(name, Nil) {
            Nil => { valueAt!(s, name, version, *ret) }
            a   => { valueAt!(s, a.getOrElse("path", ""), version, *ret) }
          }
        }
        ["versionsOf", [path]] => { ret!(s.getOrElse(path, {}).getOrElse("versions", []).length()) }
        ["ownerOf",    [path]] => { ret!(s.getOrElse(path, {}).getOrElse("owner", Nil)) }
        ["sealed",     [path]] => { ret!(s.getOrElse(path, {}).getOrElse("sealed", false)) }
        ["epochOf",    [path]] => { ret!(s.getOrElse(path, {}).getOrElse("epoch", 0)) }
        ["targetOf",   [short]] => { ret!(al.getOrElse(short, Nil)) }
        ["aliases",    []]      => { ret!(al.keys().toList()) }
        ["list",       [prefix]] => { new sub in { listFold!(s.toList(), prefix, [], *sub) | for (@ps <- sub) { ret!(ps) } } }
        ["paths",      []]      => { ret!(s.keys().toList()) }
        _ => { ret!(("dir-error", "bad verb or arity", verb)) }
      }
    }
  } |

  // ---- root ---------------------------------------------------------------

  contract doRoot(@verb, @args, ret) = {
    for (@al <- aliases) {
      match [verb, args] {
        // A short name points at a rooted path, never at a value. \`version\` may
        // be Nil, which means "whatever that path's latest is" — so an app can
        // publish an upgrade without the root authority acting again.
        ["alias", [short, path, version]] => {
          aliases!(al.set(short, {"path": path, "version": version})) |
          ret!(("aliased", short, path, version))
        }
        ["unalias", [short]] => { aliases!(al.delete(short)) | ret!(("unaliased", short)) }
        _ => { aliases!(al) | ret!(("dir-error", "bad verb or arity", verb)) }
      }
    }
  } |

  CAPS
}`;

/** The facet map the dictionary publishes. */
const FACETS = `{"resolve": bundle+{*resolveFacet}, "publish": bundle+{*publishFacet}, "root": bundle+{*rootFacet}}`;

/**
 * The install program.
 *
 * In the real thing these facets are genesis content and `rootCh` carries
 * whatever the chain decides holds that authority. Here the installer takes it,
 * which is the only difference between the prototype and the proposal.
 */
export function installProgram() {
  return DICTIONARY_RHO.replace("CAPS", `new a in {
    revAddr!("fromDeployerId", *deployerId, *a) |
    for (@owner <- a) {
      rootCh!(owner) |
      insertArbitrary!(${FACETS}, *ret) |
      for (@uri <- ret) {
        return!(["installed", "Dictionary", uri, owner]) |
        deployId!(["installed", "Dictionary", uri, owner])
      }
    }
  }`);
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

/** rholo answers a lookup with the bare value; the Scala shape is a tuple. */
const UNWRAP = `match record { (_, c) => { capsCh!(c) } c => { capsCh!(c) } }`;

/** A `publish` or `root` call: a signed deploy carrying the caller's identity. */
export function writeProgram(uri, facet, verb, args = []) {
  const list = `[${args.join(", ")}]`;
  const err = `("dir-error", "no facet", ${q(facet)})`;
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`),
    deployId(\`rho:rchain:deployId\`), stored, capsCh, ret in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    ${UNWRAP} |
    for (@caps <- capsCh) {
      match caps {
        {${q(facet)}: found, ..._} => {
          @found!(*deployerId, ${q(verb)}, ${list}, *ret) |
          for (@answer <- ret) { return!(answer) | deployId!(answer) }
        }
        _ => { return!(${err}) | deployId!(${err}) }
      }
    }
  }
}`;
}

/** A `resolve` call: exploratory, free, and binding no identity. */
export function readProgram(uri, verb, args = []) {
  const list = `[${args.join(", ")}]`;
  return `new return, lookup(\`rho:registry:lookup\`), stored, capsCh, ret in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    ${UNWRAP} |
    for (@caps <- capsCh) {
      match caps {
        {"resolve": found, ..._} => { @found!(${q(verb)}, ${list}, *ret) | for (@answer <- ret) { return!(answer) } }
        _ => { return!(("dir-error", "no resolve facet")) }
      }
    }
  }
}`;
}

export const publishProgram = (uri, path, valueTerm) => writeProgram(uri, "publish", "publish", [q(path), String(valueTerm)]);
export const sealProgram    = (uri, path) => writeProgram(uri, "publish", "seal", [q(path)]);
export const grantProgram   = (uri, path) => writeProgram(uri, "publish", "grant", [q(path)]);
export const revokeProgram  = (uri, path) => writeProgram(uri, "publish", "revoke", [q(path)]);
export const aliasProgram   = (uri, short, path, version = null) =>
  writeProgram(uri, "root", "alias", [q(short), q(path), version === null ? "Nil" : String(Number(version))]);
export const unaliasProgram = (uri, short) => writeProgram(uri, "root", "unalias", [q(short)]);

export const resolveProgram   = (uri, name) => readProgram(uri, "resolve", [q(name)]);
export const resolveAtProgram = (uri, name, v) => readProgram(uri, "resolveAt", [q(name), String(Number(v))]);
export const versionsOfProgram = (uri, path) => readProgram(uri, "versionsOf", [q(path)]);
export const ownerOfProgram   = (uri, path) => readProgram(uri, "ownerOf", [q(path)]);
export const listProgram      = (uri, prefix) => readProgram(uri, "list", [q(prefix)]);
export const aliasesProgram   = (uri) => readProgram(uri, "aliases", []);

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/dictionary.js --selftest
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${String(detail).slice(0, 200)})` : ""}`); }
  };
  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";
  const balanced = (s) => {
    const st = []; const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };
  const src = DICTIONARY_RHO;
  const noComments = src.replace(/\/\/[^\n]*/g, "");

  ok("delimiter-balanced", balanced(src));
  ok("quotes no name", !/@"/.test(src));
  ok("every contract takes at least two parameters",
     [...src.matchAll(/contract\s+\w+\(([^)]*)\)/g)]
       .every((m) => m[1].split(",").filter((x) => x.trim()).length >= 2));
  ok("readers consume and restore, never peek", !/<<-/.test(src));
  ok("uses no inline if — rholang's if is a process", !/\bif\s*\(/.test(noComments));
  ok("one state cell and one alias cell", (src.match(/\bstate!\(\{\}\)/g) || []).length === 1
     && (src.match(/\baliases!\(\{\}\)/g) || []).length === 1);
  ok("guards a Nil identity before touching state",
     /Nil => \{ ret!\(\("dir-error", "no identity"\)\) \}/.test(src));

  // A deployerId is UNFORGEABLE but DELEGABLE BY DISCLOSURE: it behaves like a
  // key, not like a signature. Measured on the node — a contract that stores
  // `*deployerId` in readable state hands its identity to anyone who reads it,
  // and the holder can then act as that identity anywhere, including here.
  // Forging one is impossible (a public key, or a string, yields Nil), so the
  // only exposure is a contract that gives one away. These do not: every use of
  // the caller's id is the address derivation and nothing else.
  for (const [name, src] of Object.entries({ Dictionary: DICTIONARY_RHO })) {
    const uses = (src.match(/\*_id/g) || []).length;
    const derivations = (src.match(/revAddr!\("fromDeployerId", \*_id,/g) || []).length;
    ok(`${name}: the caller's deployerId is derived and never stored or returned`,
       uses > 0 && uses === derivations,
       `${uses} uses of *_id, ${derivations} of them the address derivation`);
  }

  // The access-control system, such as it is.
  ok("the prefix check derives the root from the caller",
     /path\.slice\(0, me\.length\(\) \+ 1\) == me \+\+ "\/"/.test(src),
     "a caller must not be able to NAME a path outside their own root");
  ok("publishing outside your root is refused by name",
     /"dir-error", "not your namespace"/.test(src));
  ok("the root facet is gated on the root authority",
     /match me == root \{/.test(src) && /"not the root authority"/.test(src));

  ok("versions are append-only", /vs \+\+ \[value\]/.test(src) && !/versions", \[\]\)\.set\(/.test(src));
  ok("seal closes a path to further versions", /"dir-error", "sealed"/.test(src));
  ok("a grant carries the epoch it was minted against",
     /contract writekey\(@value, r2\) = \{ grantedPublish!\(path, ep, value, \*r2\) \}/.test(src));
  ok("revoke bumps the epoch, so old writekeys stop working",
     /rec\.set\("epoch", ep \+ 1\)/.test(src) && /"dir-error", "revoked"/.test(src));
  ok("a short name points at a path, never at a value",
     /\{"path": path, "version": version\}/.test(src));
  ok("every dispatcher answers a bad arity instead of falling silent",
     (src.match(/"dir-error", "bad verb or arity"/g) || []).length >= 3);
  ok("the resolve facet needs no identity", /contract resolveFacet\(@verb, @args, ret\)/.test(src));

  const inst = installProgram();
  ok("install program is well-formed", balanced(inst));
  ok("install publishes all three facets",
     inst.includes('"resolve": bundle+{*resolveFacet}') && inst.includes('"publish": bundle+{*publishFacet}')
     && inst.includes('"root": bundle+{*rootFacet}'));
  ok("install seats the root authority", /rootCh!\(owner\)/.test(inst));
  ok("no CAPS placeholder survives", !/\bCAPS\b/.test(inst));

  const pub = publishProgram(URI, "1111alice/inbox", '{"hello": 1}');
  ok("publish passes deployerId first, then verb, then an args list",
     /@found!\(\*deployerId, "publish", \["1111alice\/inbox", \{"hello": 1\}\], \*ret\)/.test(pub), pub);
  ok("publish answers on both return and deployId", /return!\(answer\) \| deployId!\(answer\)/.test(pub));

  const res = resolveProgram(URI, "Inbox");
  ok("resolve is well-formed", balanced(res));
  ok("resolve binds neither deployerId nor deployId",
     !/rho:rchain:deployerId/.test(res) && !/rho:rchain:deployId/.test(res));
  ok("resolve reaches the resolve facet and no other",
     /\{"resolve": found, \.\.\._\}/.test(res) && !/"publish":/.test(res));
  ok("alias reaches the root facet", /\{"root": found, \.\.\._\}/.test(aliasProgram(URI, "Inbox", "1111a/inbox")));
  ok("a null alias version becomes Nil (track the latest)",
     /\["Inbox", "1111a\/inbox", Nil\]/.test(aliasProgram(URI, "Inbox", "1111a/inbox")));

  const nasty = publishProgram(URI, 'x", *evil) | @"stolen"!("', "Nil");
  ok("a hostile path stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
