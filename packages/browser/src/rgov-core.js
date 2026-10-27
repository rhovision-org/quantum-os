// rgov-core.js — the three governance contracts: Inbox, Group, Issue.
//
// Design and evidence: ../../../RGov_Core.md. The short version:
//
// The core governance capabilities are inbox send/receive, groups, issues,
// delegation and a trust metric. Four of those five are already the node's —
// `rho:gov:trustLevels`, `:resolveWeights`, `:tally`, `:censure` are bound
// powerbox names, verified live. Delegation is not a process at all: it is a
// record, and resolveWeights is the function over it. So what is left to build
// is durable state, and there are exactly three kinds of it.
//
// State in contracts, computation native, naming in the genesis directory.
//
// THE INTERFACE RULE. Every verb on a `read` facet is named after the ARGUMENT
// OF THE NATIVE IT FEEDS, in that native's own shape:
//
//   Group.ratingsOf  -> [(rater, ratee, level), …]   trustLevels arg 1
//   Group.adminsOf   -> [addr, …]                    trustLevels arg 2
//   Group.delegationsOf(gid, issue) -> {from: to}    resolveWeights arg 2
//   Group.censuresOf -> [(censurer, target), …]      censure arg 1
//   Group.vouchersOf -> [(voucher, target, level)]   censure arg 3
//   Issue.ballotsOf  -> {voter: [optionId, …]}       tally arg 1
//
// One read per parameter, one native call, and NO governance policy in any
// contract — which is what lets policy change without a hard fork, since the
// natives belong to the node and these hold only facts.
//
// THREE FACETS, and the split is the security model:
//
//   read   everyone. Never mutates, never returns a capability or a message body.
//   self   everyone. Mutates ONLY the caller's own row (see the identity rule).
//   admin  migration only (dump/load), and identity-gated to the installer.
//
// `self` is safe to publish because a caller cannot NAME a row, only inhabit
// one. That is what dissolves rgov's admin bottleneck: delegate, rate, censure,
// join, cast, send and receive are all public verbs and none of them needs an
// admin to have acted first. Privilege inside a group is DATA (the group's own
// admins set), not a capability the contract's installer holds — otherwise
// whoever deployed the contract would own every group in it.
//
// IDENTITY IS DERIVED, NEVER CLAIMED. Every `self` verb takes the caller's
// deployer id as an unquoted name parameter and derives their REV address
// inside the contract:
//
//   contract selfFacet(_id, @verb, @args, ret) = {
//     revAddr!("fromDeployerId", *_id, *a) | for (@me <- a) { … }
//   }
//
// Probed live on rnodeapi.rhobot.net (2026-09-23): alice installed a deriver
// with insertArbitrary; alice calling it got her own address, and BOB CALLING
// ALICE'S DEPLOYED CONTRACT GOT BOB'S ADDRESS — the contract sees the caller,
// not the installer, across deploys and identities. Passing bob's public key as
// bytes, or a plain string, where the deployer id belongs yields Nil.
//
// …WHICH IS WHY EVERY VERB GUARDS Nil. Both forgery attempts returned Nil and
// NOT an error (law 38: the node does not tell you a thing did not work). A verb
// that skips the guard writes a row keyed Nil — one shared row, reachable by
// anyone who can produce a Nil. The guard is the difference between "a caller
// cannot name another's row" and "there is no such thing as another's row".
//
// ONE CELL, CONSUMED AND RESTORED. `for (@s <- state) { state!(s') | … }`, never
// a peek, never a second send. The audit's worst finding was that rgov's
// `@[*deployerId, "MasterContractAdmin"]!({…})` is a LINEAR send, so every
// bootstrap left another directory on that channel and consumers peeked an
// arbitrary one — two values consumed off it compared unequal, with nothing
// erroring anywhere. A single consumed-and-restored cell cannot accumulate.
//
// ONE ARITY PER FACET. Every verb is reached as (verb, argsList), so a call with
// the wrong number of arguments does not silently match nothing (law 40 — the
// defect that accounts for most of rgov's dead actions). It falls to the `_`
// branch and ANSWERS ("gov-error", "bad verb or arity", verb). Verified on the
// node before this file was written.
//
// Plain JS with no imports, so the browser and a room agent consume it directly
// and its tests run under node with no build:
//
//   node packages/browser/src/rgov-core.js --selftest

/** A rholang string literal — JSON.stringify produces one. */
const q = (s) => JSON.stringify(String(s));

/**
 * The shared preamble every contract opens with: the state cell, the three
 * facets, and the identity derivation with its Nil guard. VERBS is replaced
 * with the contract's own dispatchers.
 */
const preamble = (version, { vault = false } = {}) => `new state, ownerCh, readFacet, selfFacet, adminFacet,
    doSelf, doRead, doAdmin, HELPERS
    revAddr(\`rho:rev:address\`),
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), deployId(\`rho:rchain:deployId\`), ret
in {
  state!({}) |

  // The caller's identity is derived here and nowhere else. \`_id\` is a NAME
  // parameter, not a quoted process: it is the deployer id rnode issued for
  // the deploy that is calling, and there is no source syntax for another one.
  contract selfFacet(_id, @verb, @args, ret) = {
    new a in {
      revAddr!("fromDeployerId", *_id, *a) |
      for (@me <- a) {
        match me {
          // Not an error from the powerbox — a Nil. Refuse loudly instead.
          Nil => { ret!(("gov-error", "no identity")) }
          _   => { doSelf!(me, verb, args, *ret) }
        }
      }
    }
  } |

  // Reading needs no identity, and answers nothing that carries authority.
  contract readFacet(@verb, @args, ret) = { doRead!(verb, args, *ret) } |

  // Migration only, and only for whoever installed this contract.
  contract adminFacet(_id, @verb, @args, ret) = {
    new a in {
      revAddr!("fromDeployerId", *_id, *a) |
      for (@me <- a; @owner <- ownerCh) {
        ownerCh!(owner) |
        match me == owner {
          true  => { doAdmin!(verb, args, *ret) }
          false => { ret!(("gov-error", "not the installer")) }
        }
      }
    }
  } |

  contract doAdmin(@verb, @args, ret) = {
    for (@s <- state) {
      match [verb, args] {
        ["version", []] => { state!(s) | ret!(("version", ${q(version)})) }
${vault ? `
        // A VAULT HAS NO WHOLE-CONTRACT DUMP. Measured: dump returns message
        // bodies in clear, so the installer of an inbox could read every
        // locker in it, capabilities included — the read facet's promise not to
        // answer a body is worth nothing if one verb answers all of them.
        //
        // Nothing is lost by refusing, because dump/load could never migrate an
        // inbox anyway: "load" takes a term the CLIENT writes, and there is no
        // source syntax for an unforgeable name. It would have moved the data
        // and silently dropped every capability — the only contents that matter.
        //
        // Migration is per-identity and stays on chain: "export" your own
        // lockers and "import" them into the new contract IN ONE TERM, so the
        // unforgeables never leave the tuplespace. Nobody can move your
        // capabilities for you, which is the correct property for a vault.
        ["dump", []]    => { state!(s) | ret!(("gov-error", "no whole-contract dump", "a vault is per-identity: self export/import, in one term")) }
        ["load", [s2]]  => { state!(s) | ret!(("gov-error", "no whole-contract load", "a vault is per-identity: self export/import, in one term")) }` : `
        ["dump", []]    => { state!(s) | ret!(("dump", s)) }
        // Refuses a non-empty cell: loading over live state would silently
        // discard it, and there is no undo on a chain.
        ["load", [s2]]  => {
          match s.keys().toList().length() == 0 {
            true  => { state!(s2) | ret!(("loaded", s2.keys().toList().length())) }
            false => { state!(s) | ret!(("gov-error", "not empty")) }
          }
        }`}
        _ => { state!(s) | ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |

  VERBS

  CAPS
}`;

/** The facet map each contract publishes. One record, three separable bundles. */
const FACETS = `{"read": bundle+{*readFacet}, "self": bundle+{*selfFacet}, "admin": bundle+{*adminFacet}}`;

// ---------------------------------------------------------------------------
// 1. Inbox — the capability vault
// ---------------------------------------------------------------------------
//
// rgov's inbox is "a rholang par, unordered": one undifferentiated pile per
// identity, scanned in full on every read, holding capabilities. Read cost grows
// with history and never falls, and a read cap that leaks leaks everything the
// holder was ever sent.
//
// Here an identity holds a SET of named lockers — the `lockerTag` seam rgov
// already has and never populates — and each locker indexes its messages BY
// TYPE rather than piling them up:
//
//   boxes : { owner: { tag: {"policy": "open"|"invite", "msgs": {type: [msg, …]}} } }
//
// So `take(tag, type)` is a map lookup, not a scan: the read cost of one kind of
// message does not grow with the volume of every other kind. `msg` values may be
// `bundle+` names — carrying authority is the point of the thing.
//
// The public `read` facet answers tag names, type names and counts. It NEVER
// answers a message body. Bodies need a per-locker capability, which is why
// `peek` is not a public verb: a non-consuming read of a vault of capabilities
// is the strictly more dangerous operation, so it is the one that costs a cap.

/** One history page answers at most this many entries, so one call's phlo is bounded. */
export const HISTORY_PAGE = 50;
/** Each owner's history keeps this many entries, newest; the oldest is dropped past it. */
export const HISTORY_KEEP = 500;

const INBOX_VERBS = `// --- history helpers (quantum-os#241) ---------------------------------------
  //
  // Each owner's history is its OWN cell, @(*hist, owner), consumed and restored
  // like state — so one person's long history never makes anybody else's send or
  // receive cost more. histKnown records whose cells exist (a receive on a cell
  // nobody has written would wait forever).
  //
  //   history : {"seq": n, "order": [seq, …] (oldest first),
  //              "entries": {seq: {"seq", "from", "type", "title", "msg"}},
  //              "byFrom": {addr: [seq, …]}, "byType": {type: [seq, …]}}
  //
  // CAPABILITIES ARE NOT KEPT. An entry's "msg" holds only the message's string,
  // integer and boolean fields: a capability is delivered exactly once, by
  // receive/take, and history is a record of what was said, not a second copy
  // of the authority. The newest ${HISTORY_KEEP} entries are kept.
  histKnown!({}) |

  contract histOf(@me, ret) = {
    for (@k <- histKnown) {
      match k.contains(me) {
        true  => { histKnown!(k) | for (@h <- @(*hist, me)) { ret!(h) } }
        false => { histKnown!(k.set(me, true)) | ret!({"seq": 0, "order": [], "entries": {}, "byFrom": {}, "byType": {}}) }
      }
    }
  } |

  // pairs: [(type, [msg, …]), …] as a locker's msgs.toList() gives them.
  contract histAppend(@me, @pairs, ret) = {
    new got, done in {
      histOf!(me, *got) |
      for (@h <- got) {
        appendPairs!(h, pairs, *done) |
        for (@h2 <- done) { @(*hist, me)!(h2) | ret!(h2.get("seq")) }
      }
    }
  } |
  contract appendPairs(@h, @pairs, ret) = {
    match pairs {
      [] => { ret!(h) }
      [(_, msgs) ...rest] => { new d in { appendMsgs!(h, msgs, *d) | for (@h2 <- d) { appendPairs!(h2, rest, *ret) } } }
    }
  } |
  contract appendMsgs(@h, @msgs, ret) = {
    match msgs {
      [] => { ret!(h) }
      [m ...rest] => {
        new clean, d in {
          strip!(m.toList(), {}, *clean) |
          for (@c <- clean) {
            let @n <- h.get("seq") + 1 in {
              let @from <- c.getOrElse("from", "") in {
                let @ty <- c.getOrElse("type", "") in {
                  let @h1 <- h.set("seq", n).set("order", h.get("order") ++ [n])
                      .set("entries", h.get("entries").set(n, {"seq": n, "from": from, "type": ty, "title": c.getOrElse("subject", ""), "msg": c}))
                      .set("byFrom", h.get("byFrom").set(from, h.get("byFrom").getOrElse(from, []) ++ [n]))
                      .set("byType", h.get("byType").set(ty, h.get("byType").getOrElse(ty, []) ++ [n])) in {
                    match h1.get("order").length() > ${HISTORY_KEEP} {
                      true  => { dropSeqs!(h1, [h1.get("order").nth(0)], *d) }
                      false => { d!(h1) }
                    } |
                    for (@h2 <- d) { appendMsgs!(h2, rest, *ret) }
                  }
                }
              }
            }
          }
        }
      }
    }
  } |
  // Keep a message's plain fields; leave out anything else (a name, a capability).
  contract strip(@kvs, @acc, ret) = {
    match kvs {
      [] => { ret!(acc) }
      [(k, v) ...rest] => {
        match v {
          String => { strip!(rest, acc.set(k, v), *ret) }
          Int    => { strip!(rest, acc.set(k, v), *ret) }
          Bool   => { strip!(rest, acc.set(k, v), *ret) }
          _      => { strip!(rest, acc, *ret) }
        }
      }
    }
  } |
  contract rev(@xs, @acc, ret) = {
    match xs {
      [] => { ret!(acc) }
      [x ...rest] => { rev!(rest, [x] ++ acc, *ret) }
    }
  } |
  contract without(@xs, @x, @acc, ret) = {
    match xs {
      [] => { ret!(acc) }
      [y ...rest] => { match y == x { true => { without!(rest, x, acc, *ret) } false => { without!(rest, x, acc ++ [y], *ret) } } }
    }
  } |
  contract dropSeqs(@h, @seqs, ret) = {
    match seqs {
      [] => { ret!(h) }
      [k ...rest] => { new d in { dropOne!(h, k, *d) | for (@h2 <- d) { dropSeqs!(h2, rest, *ret) } } }
    }
  } |
  contract dropOne(@h, @k, ret) = {
    match h.get("entries").getOrElse(k, Nil) {
      Nil => { ret!(h) }
      e => {
        new o, f, t in {
          without!(h.get("order"), k, [], *o) |
          without!(h.get("byFrom").getOrElse(e.get("from"), []), k, [], *f) |
          without!(h.get("byType").getOrElse(e.get("type"), []), k, [], *t) |
          for (@o2 <- o; @f2 <- f; @t2 <- t) {
            ret!(h.set("order", o2).set("entries", h.get("entries").delete(k))
                  .set("byFrom", h.get("byFrom").set(e.get("from"), f2))
                  .set("byType", h.get("byType").set(e.get("type"), t2)))
          }
        }
      }
    }
  } |
  // desc: seqs newest first. ctx: [cursor, query, entries, limit]. Answers
  // [page, nextCursor]; the next page is the entries below nextCursor.
  contract walk(@desc, @ctx, @acc, ret) = {
    match desc {
      [] => { ret!([acc, Nil]) }
      [k ...rest] => {
        match acc.length() >= ctx.nth(3) {
          true  => { ret!([acc, acc.nth(acc.length() - 1).get("seq")]) }
          false => {
            new keep, hit in {
              match ctx.nth(0) { Nil => { keep!(true) } c => { keep!(k < c) } } |
              for (@yes <- keep) {
                match yes {
                  false => { walk!(rest, ctx, acc, *ret) }
                  true  => {
                    entryHits!(ctx.nth(2).get(k), ctx.nth(1), *hit) |
                    for (@m <- hit) {
                      match m {
                        true  => { walk!(rest, ctx, acc ++ [ctx.nth(2).get(k)], *ret) }
                        false => { walk!(rest, ctx, acc, *ret) }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } |
  contract entryHits(@e, @query, ret) = {
    new a, b in {
      match query.getOrElse("type", Nil) { Nil => { a!(true) } ty => { a!(e.get("type") == ty) } } |
      match query.getOrElse("from", Nil) { Nil => { b!(true) } who => { b!(e.get("from") == who) } } |
      for (@x <- a; @y <- b) {
        match x and y {
          false => { ret!(false) }
          true  => {
            match query.getOrElse("title", Nil) {
              Nil => { ret!(true) }
              ""  => { ret!(true) }
              t   => { hasSub!(e.get("title"), [t, 0], *ret) }
            }
          }
        }
      }
    }
  } |
  // Case-sensitive substring: the reducer has slice and length, nothing more.
  contract hasSub(@str, @at, ret) = {
    let @sub <- at.nth(0) in {
      let @i <- at.nth(1) in {
        match i + sub.length() > str.length() {
          true  => { ret!(false) }
          false => {
            match str.slice(i, i + sub.length()) == sub {
              true  => { ret!(true) }
              false => { hasSub!(str, [sub, i + 1], *ret) }
            }
          }
        }
      }
    }
  } |

  contract doSelf(@me, @verb, @args, ret) = {
    for (@s <- state) {
      match [verb, args] {
        ["newLocker", [tag, policy]] => {
          match s.getOrElse(me, {}).contains(tag) {
            true  => { state!(s) | ret!(("already", tag)) }
            false => {
              state!(s.set(me, s.getOrElse(me, {}).set(tag, {"policy": policy, "msgs": {}}))) |
              ret!(("created", tag, policy))
            }
          }
        }

        // Anyone may write to an "open" locker — that is what an inbox is. The
        // sender is STAMPED from the derived address, never taken from the
        // message, so "from" cannot be forged even though the send is public.
        ["send", [to, tag, msg]] => {
          match s.getOrElse(to, {}).getOrElse(tag, Nil) {
            // Onboarding has to work in BOTH directions (requirement 5), so a
            // first message to somebody who has never acted must not bounce —
            // otherwise the push half of onboarding needs the pull half to have
            // happened first, which is the chicken-and-egg rgov never escaped.
            // A sender cannot call newLocker for somebody else (it is
            // self-scoped), so the default locker is created here.
            //
            // ONLY the default tag. Any other tag is the owner's to make, or
            // one sender could litter an identity with lockers it never wanted.
            Nil => {
              match tag == "inbox" {
                false => { state!(s) | ret!(("gov-error", "no such locker", to, tag)) }
                true  => {
                  let @m <- msg.set("from", me) in {
                    let @ty <- m.getOrElse("type", "") in {
                      state!(s.set(to, s.getOrElse(to, {}).set(tag,
                        {"policy": "open", "msgs": {ty: [m]}}))) |
                      ret!(("sent", to, tag, ty, "locker created"))
                    }
                  }
                }
              }
            }
            box => {
              match box.getOrElse("policy", "open") {
                "invite" => { state!(s) | ret!(("gov-error", "invite-only locker", to, tag)) }
                _ => {
                  let @m <- msg.set("from", me) in {
                    let @ty <- m.getOrElse("type", "") in {
                      state!(s.set(to, s.get(to).set(tag, box.set("msgs",
                        box.get("msgs").set(ty, box.get("msgs").getOrElse(ty, []) ++ [m]))))) |
                      ret!(("sent", to, tag, ty))
                    }
                  }
                }
              }
            }
          }
        }

        // The authority-bearing read: it CONSUMES. Every message in the locker
        // comes back and the locker is left empty, so a capability cannot be
        // read twice by two readers who each think they hold it.
        ["receive", [tag]] => {
          match s.getOrElse(me, {}).getOrElse(tag, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such locker", tag)) }
            box => {
              state!(s.set(me, s.get(me).set(tag, box.set("msgs", {})))) |
              new kept in {
                histAppend!(me, box.getOrElse("msgs", {}).toList(), *kept) |
                for (_ <- kept) { ret!(("received", box.getOrElse("msgs", {}))) }
              }
            }
          }
        }

        // Consume one type's bucket. A map delete, not a filtered scan.
        ["take", [tag, type]] => {
          match s.getOrElse(me, {}).getOrElse(tag, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such locker", tag)) }
            box => {
              state!(s.set(me, s.get(me).set(tag, box.set("msgs", box.get("msgs").delete(type))))) |
              new kept in {
                histAppend!(me, [(type, box.getOrElse("msgs", {}).getOrElse(type, []))], *kept) |
                for (_ <- kept) { ret!(("took", type, box.getOrElse("msgs", {}).getOrElse(type, []))) }
              }
            }
          }
        }

        ["setPolicy", [tag, policy]] => {
          match s.getOrElse(me, {}).getOrElse(tag, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such locker", tag)) }
            box => { state!(s.set(me, s.get(me).set(tag, box.set("policy", policy)))) | ret!(("policy", tag, policy)) }
          }
        }

        // Directory.rho's own grant pattern, one LOCKER at a time instead of one
        // key at a time: the holder reads that locker's bodies and can reach
        // nothing else — not another locker, not who owns it, not how to write.
        // This is how reporting is delegated without handing over the vault.
        ["grantRead", [tag]] => {
          new readOne in {
            contract readOne(@_unused, r2) = {
              for (@s2 <- state) {
                state!(s2) |
                r2!(s2.getOrElse(me, {}).getOrElse(tag, {}).getOrElse("msgs", {}))
              }
            } |
            state!(s) | ret!(("granted", "read", tag, bundle+{*readOne}))
          }
        }

        // An append-only capability for one locker — how an "invite" locker is
        // opened to exactly one correspondent. The holder cannot read, cannot
        // reach another locker, and cannot stamp a sender: a granted send is
        // attributed by the GRANT, which is why the grant is the decision.
        ["grantSend", [tag]] => {
          new sendOne in {
            contract sendOne(@msg, r2) = {
              for (@s2 <- state) {
                match s2.getOrElse(me, {}).getOrElse(tag, Nil) {
                  Nil => { state!(s2) | r2!(("gov-error", "locker gone", tag)) }
                  box => {
                    let @ty <- msg.getOrElse("type", "") in {
                      state!(s2.set(me, s2.get(me).set(tag, box.set("msgs",
                        box.get("msgs").set(ty, box.get("msgs").getOrElse(ty, []) ++ [msg]))))) |
                      r2!(("sent", tag, ty))
                    }
                  }
                }
              }
            } |
            state!(s) | ret!(("granted", "send", tag, bundle+{*sendOne}))
          }
        }

        // Migration, per identity. Your own lockers and nobody else's — which is
        // the whole reason the vault has no admin dump. Bodies come back in
        // full, capabilities included, because they are yours.
        ["export", []] => { state!(s) | ret!(("export", s.getOrElse(me, {}))) }

        // The other half. Refuses a tag that already exists rather than merging
        // into it: a silent merge across two versions of a vault is how a
        // capability ends up in a locker its owner did not expect.
        ["import", [lockers]] => {
          let @mine <- s.getOrElse(me, {}) in {
            match mine.keys().toList().length() == 0 {
              false => { state!(s) | ret!(("gov-error", "already has lockers", me)) }
              true  => { state!(s.set(me, lockers)) | ret!(("imported", lockers.keys().toList().length())) }
            }
          }
        }

        // HISTORY (quantum-os#241). What receive/take handed over, kept for the
        // owner to search and page. Answered on the self facet only: reading it is
        // a signed deploy by the owner, so nobody else's key can ask for it. (The
        // bodies are in chain state, unencrypted, either way: the facet decides
        // who the CONTRACT answers, not what a node operator can see.)
        //
        //   history(query, cursor, limit) -> ("history", [entry, …], nextCursor | Nil)
        //
        // query: any of {"from": addr, "type": ty, "title": text}; title is a
        // case-sensitive substring of the message's "subject". Newest first;
        // cursor is a seq (Nil for the newest page) and the next page is the
        // entries below it. limit is capped at HISTORY_PAGE.
        ["history", [query, cursor, limit]] => {
          state!(s) |
          new got, lim, srcCh, down, page in {
            histOf!(me, *got) |
            match limit > ${HISTORY_PAGE} {
              true  => { lim!(${HISTORY_PAGE}) }
              false => { match limit < 1 { true => { lim!(1) } false => { lim!(limit) } } }
            } |
            for (@h <- got; @n <- lim) {
              @(*hist, me)!(h) |
              // A sender or type filter starts from its index, so finding one
              // sender's messages does not scan everybody else's.
              match [query.getOrElse("from", Nil), query.getOrElse("type", Nil)] {
                [Nil, Nil] => { srcCh!(h.get("order")) }
                [Nil, ty]  => { srcCh!(h.get("byType").getOrElse(ty, [])) }
                [who, _]   => { srcCh!(h.get("byFrom").getOrElse(who, [])) }
              } |
              for (@src <- srcCh) {
                rev!(src, [], *down) |
                for (@desc <- down) {
                  walk!(desc, [cursor, query, h.get("entries"), n], [], *page) |
                  for (@r <- page) { ret!(("history", r.nth(0), r.nth(1))) }
                }
              }
            }
          }
        }

        // Delete entries by seq. Unknown seqs are ignored, so a retry is harmless.
        ["forget", [seqs]] => {
          state!(s) |
          new got, done in {
            histOf!(me, *got) |
            for (@h <- got) {
              dropSeqs!(h, seqs, *done) |
              for (@h2 <- done) { @(*hist, me)!(h2) | ret!(("forgot", h.get("order").length() - h2.get("order").length())) }
            }
          }
        }

        // Migration of history, the same way as lockers: your own, in one term
        // (migrateLockersProgram), refused onto a non-empty history.
        ["exportHistory", []] => {
          state!(s) |
          new got in { histOf!(me, *got) | for (@h <- got) { @(*hist, me)!(h) | ret!(("history-export", h)) } }
        }
        ["importHistory", [h2]] => {
          state!(s) |
          new got in {
            histOf!(me, *got) |
            for (@h <- got) {
              match h.get("order").length() == 0 {
                true  => { @(*hist, me)!(h2) | ret!(("history-imported", h2.get("order").length())) }
                false => { @(*hist, me)!(h) | ret!(("gov-error", "already has history", me)) }
              }
            }
          }
        }

        _ => { state!(s) | ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |

  contract doRead(@verb, @args, ret) = {
    for (@s <- state) {
      state!(s) |
      match [verb, args] {
        ["lockersOf", [addr]]           => { ret!(s.getOrElse(addr, {}).keys().toList()) }
        ["policyOf",  [addr, tag]]      => { ret!(s.getOrElse(addr, {}).getOrElse(tag, {}).getOrElse("policy", Nil)) }
        ["typesIn",   [addr, tag]]      => { ret!(s.getOrElse(addr, {}).getOrElse(tag, {}).getOrElse("msgs", {}).keys().toList()) }
        ["countIn",   [addr, tag, type]] => {
          ret!(s.getOrElse(addr, {}).getOrElse(tag, {}).getOrElse("msgs", {}).getOrElse(type, []).length())
        }
        _ => { ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |`;

const INBOX_HELPERS = `histKnown, hist, histOf, histAppend, appendPairs, appendMsgs, strip, rev, without, dropSeqs, dropOne, walk, entryHits, hasSub,`;

export const INBOX_RHO = preamble("Inbox/4", { vault: true }).replace("HELPERS", INBOX_HELPERS).replace("VERBS", INBOX_VERBS);

// ---------------------------------------------------------------------------
// 2. Group — the state the natives read
// ---------------------------------------------------------------------------
//
//   groups : { gid: {
//     "name": str, "policy": "open"|"invite",
//     "admins":   {addr: true},
//     "members":  {addr: {"role": "admin"|"member", "label": str}},
//     "invited":  {addr: true},
//     "deleg":    {addr: addr},                  // standing
//     "topic":    {issueId: {addr: addr}},       // per-issue, overrides standing
//     "ratings":  {rater: {ratee: level}},
//     "censures": {censurer: {target: true}}
//   } }
//
// Stored as nested maps because that is what makes a single rating idempotent to
// set and delete; served as the LISTS OF TUPLES the natives actually take —
// `[(rater, ratee, level), …]` and `[(censurer, target), …]` — by the two folds
// below. The shapes were read off the live natives, not guessed:
// `%trust([("alice","bob",3)], ["alice"])`, `%censure([("alice","bob")], {…}, [("alice","bob",3)])`.
//
// `vouchersOf` and `ratingsOf` return the same list on purpose: a rating IS the
// stake that censure slashes. One fact, two readers.
//
// RATINGS ARE STORED RAW. gov.ts caps a rating at the rater's own level minus
// one and `trustLevels` re-caps during aggregation, so a forged high rating is
// already neutralised where the policy lives. Re-implementing the cap here would
// put one rule in two places that can disagree across an upgrade. The contract
// records who said what; the node decides what it is worth.

const GROUP_HELPERS = `triples, triplesOne, pairs, pairsOne,`;

const GROUP_FOLDS = `// {rater: {ratee: level}}.toList() -> [(rater, ratee, level), …]
  contract triples(@rows, @acc, ret) = {
    match rows {
      [] => { ret!(acc) }
      [(k, inner) ...rest] => {
        new sub in {
          triplesOne!(k, inner.toList(), [], *sub) |
          for (@got <- sub) { triples!(rest, acc ++ got, *ret) }
        }
      }
    }
  } |
  contract triplesOne(@k, @kvs, @acc, ret) = {
    match kvs {
      [] => { ret!(acc) }
      [(k2, v) ...rest] => { triplesOne!(k, rest, acc ++ [(k, k2, v)], *ret) }
    }
  } |
  // {censurer: {target: true}}.toList() -> [(censurer, target), …]
  contract pairs(@rows, @acc, ret) = {
    match rows {
      [] => { ret!(acc) }
      [(k, inner) ...rest] => {
        new sub in {
          pairsOne!(k, inner.keys().toList(), [], *sub) |
          for (@got <- sub) { pairs!(rest, acc ++ got, *ret) }
        }
      }
    }
  } |
  contract pairsOne(@k, @ks, @acc, ret) = {
    match ks {
      [] => { ret!(acc) }
      [k2 ...rest] => { pairsOne!(k, rest, acc ++ [(k, k2)], *ret) }
    }
  } |`;

const GROUP_VERBS = `${GROUP_FOLDS}

  contract doSelf(@me, @verb, @args, ret) = {
    for (@s <- state) {
      match [verb, args] {
        ["create", [gid, name, policy]] => {
          match s.contains(gid) {
            true  => { state!(s) | ret!(("already", gid)) }
            false => {
              state!(s.set(gid, {"name": name, "policy": policy,
                "admins": {me: true}, "members": {me: {"role": "admin", "label": name}},
                "invited": {}, "deleg": {}, "topic": {}, "ratings": {}, "censures": {}})) |
              ret!(("created", gid, me))
            }
          }
        }

        // The PULL half of onboarding. Needs no admin to have acted first: an
        // open group admits, an invite-only group admits whoever was invited.
        ["join", [gid, label]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match g.getOrElse("members", {}).contains(me) {
                true => { state!(s) | ret!(("already", gid, me)) }
                false => {
                  match g.getOrElse("policy", "open") == "open" or g.getOrElse("invited", {}).contains(me) {
                    false => { state!(s) | ret!(("gov-error", "not invited", gid)) }
                    true  => {
                      state!(s.set(gid, g.set("members", g.get("members").set(me, {"role": "member", "label": label}))
                                     .set("invited", g.getOrElse("invited", {}).delete(me)))) |
                      ret!(("joined", gid, me))
                    }
                  }
                }
              }
            }
          }
        }

        // The PUSH half. Records the invitation as ordinary, auditable state
        // rather than minting a bearer cap: an invitation anyone can read is one
        // anyone can verify, and it cannot be lost with the message that carried it.
        ["invite", [gid, addr]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match g.getOrElse("admins", {}).contains(me) {
                false => { state!(s) | ret!(("gov-error", "not an admin", gid)) }
                true  => { state!(s.set(gid, g.set("invited", g.getOrElse("invited", {}).set(addr, true)))) | ret!(("invited", gid, addr)) }
              }
            }
          }
        }

        // The mirror of invite, as uncensure mirrors censure. A public
        // invitation is one the invitee can verify — not one that must stay
        // published forever when it was a mistake, declined, or to a key that
        // is gone (quantum-os#246). Admin-gated like invite.
        ["uninvite", [gid, addr]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match [g.getOrElse("admins", {}).contains(me), g.getOrElse("invited", {}).contains(addr)] {
                [false, _] => { state!(s) | ret!(("gov-error", "not an admin", gid)) }
                [_, false] => { state!(s) | ret!(("gov-error", "not invited", addr)) }
                _ => { state!(s.set(gid, g.set("invited", g.get("invited").delete(addr)))) | ret!(("uninvited", gid, addr)) }
              }
            }
          }
        }

        ["setRole", [gid, addr, role]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match [g.getOrElse("admins", {}).contains(me), g.getOrElse("members", {}).contains(addr)] {
                [false, _] => { state!(s) | ret!(("gov-error", "not an admin", gid)) }
                [_, false] => { state!(s) | ret!(("gov-error", "not a member", addr)) }
                // Two branches, not an inline \`if\`: rholang's \`if\` is a PROCESS,
                // so \`.set("admins", if (…) {…} else {…})\` stores a conditional
                // where a map belongs, and the next read of it dies with
                // "Expected a single expression". Found live, not in review.
                _ => {
                  let @members <- g.get("members").set(addr, g.get("members").get(addr).set("role", role)) in {
                    let @admins <- g.getOrElse("admins", {}) in {
                      match role == "admin" {
                        true  => { state!(s.set(gid, g.set("members", members).set("admins", admins.set(addr, true)))) | ret!(("role", gid, addr, role)) }
                        // Demoting the last admin would strand the group: nobody
                        // left could invite or promote (rhogov#75 item 4).
                        false => {
                          match admins.delete(addr) == {} {
                            true  => { state!(s) | ret!(("gov-error", "last admin", gid)) }
                            false => { state!(s.set(gid, g.set("members", members).set("admins", admins.delete(addr)))) | ret!(("role", gid, addr, role)) }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        ["leave", [gid]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            // The last admin may not leave while anyone else remains — promote
            // someone first. A group's last MEMBER may always leave.
            g => {
              match [(g.getOrElse("admins", {}).delete(me) == {}) and g.getOrElse("admins", {}).contains(me),
                     g.getOrElse("members", {}).delete(me) == {}] {
                [true, false] => { state!(s) | ret!(("gov-error", "last admin", gid)) }
                _ => {
                  state!(s.set(gid, g.set("members", g.getOrElse("members", {}).delete(me))
                                 .set("admins", g.getOrElse("admins", {}).delete(me))
                                 .set("deleg", g.getOrElse("deleg", {}).delete(me)))) |
                  ret!(("left", gid, me))
                }
              }
            }
          }
        }

        // Own row only, by construction — \`me\` is derived, never supplied. An
        // issueId of Nil is the standing delegation; anything else overrides it
        // for that one issue.
        ["delegate", [gid, to, issueId]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match issueId {
                Nil => { state!(s.set(gid, g.set("deleg", g.getOrElse("deleg", {}).set(me, to)))) | ret!(("delegated", gid, me, to)) }
                _   => {
                  let @topic <- g.getOrElse("topic", {}) in {
                    state!(s.set(gid, g.set("topic", topic.set(issueId, topic.getOrElse(issueId, {}).set(me, to))))) |
                    ret!(("delegated", gid, issueId, me, to))
                  }
                }
              }
            }
          }
        }

        ["undelegate", [gid, issueId]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              match issueId {
                Nil => { state!(s.set(gid, g.set("deleg", g.getOrElse("deleg", {}).delete(me)))) | ret!(("undelegated", gid, me)) }
                _   => {
                  let @topic <- g.getOrElse("topic", {}) in {
                    state!(s.set(gid, g.set("topic", topic.set(issueId, topic.getOrElse(issueId, {}).delete(me))))) |
                    ret!(("undelegated", gid, issueId, me))
                  }
                }
              }
            }
          }
        }

        ["rate", [gid, ratee, level]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              let @r <- g.getOrElse("ratings", {}) in {
                state!(s.set(gid, g.set("ratings", r.set(me, r.getOrElse(me, {}).set(ratee, level))))) |
                ret!(("rated", gid, me, ratee, level))
              }
            }
          }
        }

        ["censure", [gid, target]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              let @c <- g.getOrElse("censures", {}) in {
                state!(s.set(gid, g.set("censures", c.set(me, c.getOrElse(me, {}).set(target, true))))) |
                ret!(("censured", gid, me, target))
              }
            }
          }
        }

        ["uncensure", [gid, target]] => {
          match s.getOrElse(gid, Nil) {
            Nil => { state!(s) | ret!(("gov-error", "no such group", gid)) }
            g => {
              let @c <- g.getOrElse("censures", {}) in {
                state!(s.set(gid, g.set("censures", c.set(me, c.getOrElse(me, {}).delete(target))))) |
                ret!(("uncensured", gid, me, target))
              }
            }
          }
        }

        _ => { state!(s) | ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |

  contract doRead(@verb, @args, ret) = {
    for (@s <- state) {
      state!(s) |
      match [verb, args] {
        // -> rho:gov:trustLevels arg 2, and rho:gov:censure's electorate
        ["adminsOf", [gid]]  => { ret!(s.getOrElse(gid, {}).getOrElse("admins", {}).keys().toList()) }
        ["membersOf", [gid]] => { ret!(s.getOrElse(gid, {}).getOrElse("members", {}).keys().toList()) }
        ["roll", [gid]]      => { ret!(s.getOrElse(gid, {}).getOrElse("members", {})) }
        ["groups", []]       => { ret!(s.keys().toList()) }
        ["groupOf", [gid]]   => { ret!(s.getOrElse(gid, Nil)) }
        ["invitedOf", [gid]] => { ret!(s.getOrElse(gid, {}).getOrElse("invited", {}).keys().toList()) }

        // -> rho:gov:resolveWeights arg 2. Map ++ is right-biased (verified on
        // the node), so the per-issue map overrides the standing one for the
        // members that set one, and leaves the rest standing.
        ["delegationsOf", [gid, issueId]] => {
          let @g <- s.getOrElse(gid, {}) in {
            ret!(g.getOrElse("deleg", {}) ++ g.getOrElse("topic", {}).getOrElse(issueId, {}))
          }
        }

        // -> rho:gov:trustLevels arg 1, and rho:gov:censure arg 3. The same
        // list: a rating is the stake a censure slashes.
        ["ratingsOf", [gid]] => {
          new sub in { triples!(s.getOrElse(gid, {}).getOrElse("ratings", {}).toList(), [], *sub) | for (@t <- sub) { ret!(t) } }
        }
        ["vouchersOf", [gid]] => {
          new sub in { triples!(s.getOrElse(gid, {}).getOrElse("ratings", {}).toList(), [], *sub) | for (@t <- sub) { ret!(t) } }
        }
        // -> rho:gov:censure arg 1
        ["censuresOf", [gid]] => {
          new sub in { pairs!(s.getOrElse(gid, {}).getOrElse("censures", {}).toList(), [], *sub) | for (@p <- sub) { ret!(p) } }
        }

        _ => { ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |`;

export const GROUP_RHO = preamble("Group/4").replace("HELPERS", GROUP_HELPERS).replace("VERBS", GROUP_VERBS);

// ---------------------------------------------------------------------------
// 3. Issue — proposals and ballots
// ---------------------------------------------------------------------------
//
//   issues : { iid: {"gid","title","by","status","mode","options":[…],
//                    "voters":{addr:true}, "guests":{addr:true},
//                    "ballots":{addr:[optionId,…]}, "results":{proposer: result}} }
//   byGroup: { gid: [iid, …] }        — a secondary index, so listing a group's
//                                        issues is a lookup rather than a fold
//
// NO CONTRACT COUNTS VOTES. `rho:gov:tally` is deterministic over published
// ballots and published weights, so anyone can recompute the result. `propose`
// records the OPENER's claim about the ballots, keyed by their address — the
// one record of the vote, never a second voice beside it (#245). The ballots
// are the authoritative state; a result is a claim about them, and a reader who
// disagrees recomputes it rather than writing a rival one. Same stance polls.ts
// takes in the room: deterministic and joiner-local, no central counter.
//
// The voter roll is a SNAPSHOT the opener supplies, read from Group. That is
// recorded rather than enforced, deliberately: enforcing it would bind an issue
// to one deployed Group instance and make the two contracts upgrade together.
// Recorded, it is auditable — anyone can diff `votersOf` against `Group.roll`,
// and a tally over a roll that does not match is visibly a tally over the wrong
// electorate.

const ISSUE_VERBS = `contract doSelf(@me, @verb, @args, ret) = {
    for (@s <- state; @idx <- ownerIdx) {
      match [verb, args] {
        ["open", [iid, gid, title, mode, options, voters]] => {
          match s.contains(iid) {
            true  => { state!(s) | ownerIdx!(idx) | ret!(("already", iid)) }
            false => {
              state!(s.set(iid, {"gid": gid, "title": title, "by": me, "status": "open", "mode": mode,
                                 "options": options, "voters": voters, "guests": {}, "ballots": {}, "results": {}})) |
              ownerIdx!(idx.set(gid, idx.getOrElse(gid, []) ++ [iid])) |
              ret!(("opened", iid, gid, me))
            }
          }
        }

        // The roll is a SNAPSHOT the opener supplies, and "open" is idempotent,
        // so without this the electorate freezes at whoever had published a
        // chain address the moment the issue was first pushed — and anyone who
        // publishes one later could never cast. Opener-only, and refused once
        // the issue is closed so an electorate cannot be edited after a vote.
        //
        // Open until close BY DESIGN — people join while an issue is open, and
        // freezing the roll at the first ballot would close the vote to them
        // early. What the opener cannot do is change it quietly: every change
        // is appended to the issue's public "rollLog" with the size of the new
        // roll and how many ballots had already been cast, so a roll edited
        // after voting began is visible to anyone reading the issue
        // (quantum-os#244).
        ["setRoll", [iid, voters]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match [i.getOrElse("by", Nil) == me, i.getOrElse("status", "open") == "closed"] {
                [false, _] => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not the opener", iid)) }
                [_, true]  => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "closed", iid)) }
                _ => {
                  let @log <- i.getOrElse("rollLog", []) in {
                    let @entry <- {"seq": log.length() + 1,
                                   "voters": voters.keys().toList().length(),
                                   "ballotsBefore": i.getOrElse("ballots", {}).keys().toList().length()} in {
                      state!(s.set(iid, i.set("voters", voters).set("rollLog", log ++ [entry]))) | ownerIdx!(idx) |
                      ret!(("roll", iid, voters.keys().toList().length(), entry.get("ballotsBefore")))
                    }
                  }
                }
              }
            }
          }
        }

        ["addOption", [iid, opt]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match i.getOrElse("status", "open") == "open" {
                false => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not open", iid)) }
                true  => { state!(s.set(iid, i.set("options", i.getOrElse("options", []) ++ [opt]))) | ownerIdx!(idx) | ret!(("option", iid, opt)) }
              }
            }
          }
        }

        // The one capability this contract mints, and it earns its keep: a guest
        // voter who is not on the roll gets a bearer ballot bound to (issue,
        // addr) and to nothing else. Delivered through the Inbox — which is what
        // makes "messages carry capabilities" a working sentence rather than a
        // slogan.
        ["enroll", [iid, addr]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match i.getOrElse("by", Nil) == me {
                false => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not the opener", iid)) }
                true  => {
                  new castOne in {
                    contract castOne(@choices, r2) = {
                      for (@s2 <- state) {
                        match s2.getOrElse(iid, Nil) {
                          Nil => { state!(s2) | r2!(("gov-error", "issue gone", iid)) }
                          i2 => {
                            match i2.getOrElse("status", "open") == "open" {
                              false => { state!(s2) | r2!(("gov-error", "not open", iid)) }
                              true  => { state!(s2.set(iid, i2.set("ballots", i2.getOrElse("ballots", {}).set(addr, choices)))) | r2!(("cast", iid, addr)) }
                            }
                          }
                        }
                      }
                    } |
                    state!(s.set(iid, i.set("guests", i.getOrElse("guests", {}).set(addr, true)))) |
                    ownerIdx!(idx) |
                    ret!(("enrolled", iid, addr, bundle+{*castOne}))
                  }
                }
              }
            }
          }
        }

        // Latest ballot per voter wins — re-voting is ordinary, as it is in the
        // room. Voting is also the per-issue override of a delegation: that is
        // resolveWeights' rule, and it needs nothing here but the ballot.
        ["cast", [iid, choices]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match [i.getOrElse("status", "open") == "open",
                     i.getOrElse("voters", {}).contains(me) or i.getOrElse("guests", {}).contains(me)] {
                [false, _] => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not open", iid)) }
                [_, false] => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not on the roll", iid, me)) }
                _ => { state!(s.set(iid, i.set("ballots", i.getOrElse("ballots", {}).set(me, choices)))) | ownerIdx!(idx) | ret!(("cast", iid, me)) }
              }
            }
          }
        }

        // Opener-only, like close and setRoll. An ungated propose let any
        // member write a "result" on any issue, indistinguishable in shape from
        // the opener's, with nothing on chain saying which was the record
        // (quantum-os#245). Anyone can still disagree — by recomputing the
        // tally from ballotsOf, which is the authoritative state.
        ["propose", [iid, result]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match i.getOrElse("by", Nil) == me {
                false => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not the opener", iid)) }
                true  => {
                  state!(s.set(iid, i.set("results", i.getOrElse("results", {}).set(me, result)))) |
                  ownerIdx!(idx) | ret!(("proposed", iid, me))
                }
              }
            }
          }
        }

        ["lock", [iid]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match i.getOrElse("by", Nil) == me {
                false => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not the opener", iid)) }
                true  => { state!(s.set(iid, i.set("status", "locked"))) | ownerIdx!(idx) | ret!(("locked", iid)) }
              }
            }
          }
        }

        ["close", [iid]] => {
          match s.getOrElse(iid, Nil) {
            Nil => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "no such issue", iid)) }
            i => {
              match i.getOrElse("by", Nil) == me {
                false => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "not the opener", iid)) }
                true  => { state!(s.set(iid, i.set("status", "closed"))) | ownerIdx!(idx) | ret!(("closed", iid)) }
              }
            }
          }
        }

        _ => { state!(s) | ownerIdx!(idx) | ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |

  contract doRead(@verb, @args, ret) = {
    for (@s <- state; @idx <- ownerIdx) {
      state!(s) | ownerIdx!(idx) |
      match [verb, args] {
        // -> rho:gov:tally arg 1
        ["ballotsOf", [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("ballots", {})) }
        ["votersOf",  [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("voters", {}).keys().toList()) }
        ["guestsOf",  [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("guests", {}).keys().toList()) }
        ["optionsOf", [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("options", [])) }
        ["statusOf",  [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("status", Nil)) }
        ["modeOf",    [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("mode", Nil)) }
        ["resultsOf", [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("results", {})) }
        ["rollLogOf", [iid]] => { ret!(s.getOrElse(iid, {}).getOrElse("rollLog", [])) }
        ["issueOf",   [iid]] => { ret!(s.getOrElse(iid, Nil)) }
        ["issuesOf",  [gid]] => { ret!(idx.getOrElse(gid, [])) }
        ["issues", []]       => { ret!(s.keys().toList()) }
        _ => { ret!(("gov-error", "bad verb or arity", verb)) }
      }
    }
  } |`;

export const ISSUE_RHO = preamble("Issue/4")
  .replace("HELPERS\n", "")
  .replace("new state, ownerCh,", "new state, ownerIdx, ownerCh,")
  .replace("state!({}) |", "state!({}) | ownerIdx!({}) |")
  .replace("VERBS", ISSUE_VERBS);

// ---------------------------------------------------------------------------
// Install programs
// ---------------------------------------------------------------------------
//
// Published with `insertArbitrary`, which hands back an unpredictable uri — the
// installer learns where it went by reading what the deploy answered. NOT
// insertSigned: that writes to the one slot a key has, which is where every
// deploy's answer goes (locker.js says the same, for the same reason).
//
// The installer's address is derived here, once, and kept in `ownerCh` — the
// only thing it can ever do is dump and load, because privilege inside a group
// is the group's own admins set. Whoever deploys this contract owns no group
// in it.

const installFor = (src, name) => src.replace("CAPS", `new a in {
    revAddr!("fromDeployerId", *deployerId, *a) |
    for (@owner <- a) {
      ownerCh!(owner) |
      insertArbitrary!(${FACETS}, *ret) |
      // Both channels, for the same reason the call sites use both: return is
      // what the deploy wrapper forwards to the key's result slot, and deployId
      // is what comes back in the deploy's own deployResult — which is what
      // actually reads back on the playground today.
      for (@uri <- ret) {
        return!(["installed", ${q(name)}, uri, owner]) |
        deployId!(["installed", ${q(name)}, uri, owner])
      }
    }
  }`);

export const installInboxProgram = () => installFor(INBOX_RHO, "Inbox");
export const installGroupProgram = () => installFor(GROUP_RHO, "Group");
export const installIssueProgram = () => installFor(ISSUE_RHO, "Issue");

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------
//
// Two builders, because the two facets are reached on two different paths.
//
// A WRITE is a deploy: `deployerId` exists only inside one, so a `self` call IS
// a deploy. The answer goes to BOTH `return` (which the deploy wrapper forwards
// to the key's result slot) and `rho:rchain:deployId` (which comes back in the
// deploy's own ProcessedWithSuccess.deployResult) — the latter is what actually
// reads back reliably on the playground today.
//
// A READ is an exploratory deploy, which binds NEITHER `deployerId` NOR
// `deployId` (law 4 of porting-a-client.md), so a read program must not mention
// either. It answers on the first `new`-bound name, which is why `return` is
// declared first and left unconsumed.

/**
 * What `rho:registry:lookup` answers with, normalised.
 *
 * MEASURED, not assumed: on rholo a lookup of an `insertArbitrary` value
 * answers **the bare value** — `rec.keys().toList()` gives `["admin","read","self"]`
 * and matching it against `(_, caps)` reports "not a tuple". `locker.js` unwraps
 * a `(_, caps)` tuple, which is the Scala shape; a call site written that way
 * falls to its own default branch here and reports the contract missing when it
 * is present and healthy. So both shapes are accepted and funnelled into one
 * channel, and neither node's spelling is baked in.
 */
const unwrapLookup = `match record { (_, c) => { capsCh!(c) } c => { capsCh!(c) } }`;

/**
 * The facet is bound OUT of the map by a pattern and then quoted back to a
 * name. A bundle taken from a map is not callable in place — sending straight
 * through `@(caps.get("self"))!(…)` silently reaches nothing, which locker.js
 * hit and recorded.
 */
const facetArm = (facet, body) => `match caps {
        {${q(facet)}: found, ..._} => { ${body} }
        _ => { MISSING }
      }`;

/** A `self` or `admin` call: a signed deploy carrying the caller's identity. */
export function writeProgram(uri, facet, verb, args = [], { asAdmin = false } = {}) {
  const list = `[${args.join(", ")}]`;
  const name = asAdmin ? "admin" : facet;
  const err = `("gov-error", "no facet", ${q(name)}, ${q(uri)})`;
  const arm = facetArm(name,
    `@found!(*deployerId, ${q(verb)}, ${list}, *ret) |
          for (@answer <- ret) { return!(answer) | deployId!(answer) }`)
    .replace("MISSING", `return!(${err}) | deployId!(${err})`);
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`),
    deployId(\`rho:rchain:deployId\`), stored, ret in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    new capsCh in {
      ${unwrapLookup} |
      for (@caps <- capsCh) {
        ${arm}
      }
    }
  }
}`;
}

/** A `read` call: an exploratory deploy, unsigned, free, and binding no identity. */
export function readProgram(uri, verb, args = []) {
  const list = `[${args.join(", ")}]`;
  const err = `("gov-error", "no facet", "read", ${q(uri)})`;
  const arm = facetArm("read",
    `@found!(${q(verb)}, ${list}, *ret) | for (@answer <- ret) { return!(answer) }`)
    .replace("MISSING", `return!(${err})`);
  return `new return, lookup(\`rho:registry:lookup\`), stored, ret in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    new capsCh in {
      ${unwrapLookup} |
      for (@caps <- capsCh) {
        ${arm}
      }
    }
  }
}`;
}

// --- Inbox -----------------------------------------------------------------
export const newLockerProgram = (uri, tag, policy = "open") => writeProgram(uri, "self", "newLocker", [q(tag), q(policy)]);
export const sendProgram      = (uri, to, tag, msgTerm) => writeProgram(uri, "self", "send", [q(to), q(tag), String(msgTerm)]);
export const receiveProgram   = (uri, tag) => writeProgram(uri, "self", "receive", [q(tag)]);
export const takeProgram      = (uri, tag, type) => writeProgram(uri, "self", "take", [q(tag), q(type)]);
export const grantReadProgram = (uri, tag) => writeProgram(uri, "self", "grantRead", [q(tag)]);
export const grantSendProgram = (uri, tag) => writeProgram(uri, "self", "grantSend", [q(tag)]);
export const lockersOfProgram = (uri, addr) => readProgram(uri, "lockersOf", [q(addr)]);
export const countInProgram   = (uri, addr, tag, type) => readProgram(uri, "countIn", [q(addr), q(tag), q(type)]);

// --- Group -----------------------------------------------------------------
export const createGroupProgram = (uri, gid, name, policy = "open") => writeProgram(uri, "self", "create", [q(gid), q(name), q(policy)]);
export const joinGroupProgram   = (uri, gid, label) => writeProgram(uri, "self", "join", [q(gid), q(label)]);
export const inviteProgram      = (uri, gid, addr) => writeProgram(uri, "self", "invite", [q(gid), q(addr)]);
export const uninviteProgram    = (uri, gid, addr) => writeProgram(uri, "self", "uninvite", [q(gid), q(addr)]);
export const delegateProgram    = (uri, gid, to, issueId = null) =>
  writeProgram(uri, "self", "delegate", [q(gid), q(to), issueId === null ? "Nil" : q(issueId)]);
export const rateProgram        = (uri, gid, ratee, level) => writeProgram(uri, "self", "rate", [q(gid), q(ratee), String(Number(level))]);
export const censureProgram     = (uri, gid, target) => writeProgram(uri, "self", "censure", [q(gid), q(target)]);
export const ratingsOfProgram   = (uri, gid) => readProgram(uri, "ratingsOf", [q(gid)]);
export const adminsOfProgram    = (uri, gid) => readProgram(uri, "adminsOf", [q(gid)]);
export const delegationsOfProgram = (uri, gid, issueId = null) =>
  readProgram(uri, "delegationsOf", [q(gid), issueId === null ? "Nil" : q(issueId)]);
export const censuresOfProgram  = (uri, gid) => readProgram(uri, "censuresOf", [q(gid)]);
export const vouchersOfProgram  = (uri, gid) => readProgram(uri, "vouchersOf", [q(gid)]);

// --- Issue -----------------------------------------------------------------
export const openIssueProgram = (uri, iid, gid, title, mode, options, voters) =>
  writeProgram(uri, "self", "open", [
    q(iid), q(gid), q(title), q(mode),
    `[${options.map(q).join(", ")}]`,
    `{${voters.map((v) => `${q(v)}: true`).join(", ")}}`,
  ]);
export const castProgram      = (uri, iid, choices) => writeProgram(uri, "self", "cast", [q(iid), `[${choices.map(q).join(", ")}]`]);
export const enrollProgram    = (uri, iid, addr) => writeProgram(uri, "self", "enroll", [q(iid), q(addr)]);
export const closeIssueProgram = (uri, iid) => writeProgram(uri, "self", "close", [q(iid)]);
export const setRollProgram = (uri, iid, voters) =>
  writeProgram(uri, "self", "setRoll", [q(iid), `{${voters.map((v) => `${q(v)}: true`).join(", ")}}`]);
export const ballotsOfProgram = (uri, iid) => readProgram(uri, "ballotsOf", [q(iid)]);
export const issuesOfProgram  = (uri, gid) => readProgram(uri, "issuesOf", [q(gid)]);

/**
 * Move one identity's lockers from an old Inbox to a new one, IN ONE TERM.
 *
 * This is the only way a capability can be migrated, and the reason the vault
 * has no whole-contract dump. `dump`/`load` cannot do it: `load` takes a term
 * the *client* writes, and there is no source syntax for an unforgeable name —
 * so that path would move the data and silently drop every capability, which
 * for a vault is everything that mattered. Here both calls happen in one
 * program, so the unforgeables pass from contract to contract without ever
 * being serialised out to a client.
 *
 * It forwards `*deployerId` to two facets. That is the caution in SECURITY.md
 * applied deliberately: both are contracts the caller resolved themselves, and
 * a migration is exactly the moment to be sure which ones they are.
 */
export function migrateLockersProgram(oldUri, newUri) {
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`),
    deployId(\`rho:rchain:deployId\`), oldCh, newCh, oldCaps, newCaps, r1, r2, r3, r4 in {
  lookup!(\`${oldUri}\`, *oldCh) | lookup!(\`${newUri}\`, *newCh) |
  for (@oldRec <- oldCh; @newRec <- newCh) {
    match oldRec { (_, c) => { oldCaps!(c) } c => { oldCaps!(c) } } |
    match newRec { (_, c) => { newCaps!(c) } c => { newCaps!(c) } } |
    for (@oc <- oldCaps; @nc <- newCaps) {
      match [oc, nc] {
        [{"self": oldSelf, ..._}, {"self": newSelf, ..._}] => {
          @oldSelf!(*deployerId, "export", [], *r1) |
          for (@ex <- r1) {
            match ex {
              ("export", lockers) => {
                @newSelf!(*deployerId, "import", [lockers], *r2) |
                for (@res <- r2) {
                  match res {
                    // History follows the lockers (quantum-os#241), in the same term.
                    ("imported", _) => {
                      @oldSelf!(*deployerId, "exportHistory", [], *r3) |
                      for (@hx <- r3) {
                        match hx {
                          ("history-export", h) => {
                            @newSelf!(*deployerId, "importHistory", [h], *r4) |
                            for (@hr <- r4) { return!((res, hr)) | deployId!((res, hr)) }
                          }
                          // An Inbox from before history has nothing to move.
                          _ => { return!((res, hx)) | deployId!((res, hx)) }
                        }
                      }
                    }
                    _ => { return!(res) | deployId!(res) }
                  }
                }
              }
              _ => { return!(("gov-error", "export failed", ex)) | deployId!(("gov-error", "export failed", ex)) }
            }
          }
        }
        _ => { return!(("gov-error", "no self facet")) | deployId!(("gov-error", "no self facet")) }
      }
    }
  }
}`;
}

export const exportLockersProgram = (uri) => writeProgram(uri, "self", "export", []);

/** A rholang map literal from a JS object of strings. */
const qMap = (o) => `{${Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${q(k)}: ${q(v)}`).join(", ")}}`;
/** Your own history, newest first: query is any of {from, type, title}; cursor a seq from the previous page, or null. */
export const historyProgram = (uri, query = {}, cursor = null, limit = HISTORY_PAGE) =>
  writeProgram(uri, "self", "history", [qMap(query), cursor == null ? "Nil" : String(Number(cursor)), String(Number(limit))]);
export const forgetHistoryProgram = (uri, seqs) => writeProgram(uri, "self", "forget", [`[${seqs.map((n) => String(Number(n))).join(", ")}]`]);

// --- migration -------------------------------------------------------------
export const dumpProgram = (uri) => writeProgram(uri, "admin", "dump", [], { asAdmin: true });
export const loadProgram = (uri, stateTerm) => writeProgram(uri, "admin", "load", [String(stateTerm)], { asAdmin: true });

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/rgov-core.js --selftest
//
// The contracts are exercised against a live node by scripts/localnet/
// rgov-check.mjs, which this cannot do. What this checks is the half that ships:
// that every source is well-formed, that the invariants the design rests on hold
// textually, and that no call site can be made to carry an argument out of
// position.
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${String(detail).slice(0, 220)})` : ""}`); }
  };
  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";
  const ALL = { Inbox: INBOX_RHO, Group: GROUP_RHO, Issue: ISSUE_RHO };

  const balanced = (s) => {
    const st = [];
    const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };

  // --- the sources ---------------------------------------------------------
  for (const [name, src] of Object.entries(ALL)) {
    ok(`${name}: delimiter-balanced`, balanced(src));
    ok(`${name}: quotes no name`, !/@"/.test(src), "@\"…\" — see SECURITY.md");
    ok(`${name}: every contract takes at least two parameters`,
       [...src.matchAll(/contract\s+\w+\(([^)]*)\)/g)]
         .every((m) => m[1].split(",").filter((x) => x.trim()).length >= 2),
       "a one-binder persistent receive in a nested new runs away — rholo#19");
    ok(`${name}: readers consume and restore, never peek`, !/<<-/.test(src),
       "a peek is how rgov bound an arbitrary one of two live directories");
    ok(`${name}: publishes exactly one state cell`,
       (src.match(/for \(@s <- state/g) || []).length >= 2 && (src.match(/\bstate!\(\{\}\)/g) || []).length === 1);
    ok(`${name}: guards a Nil identity before touching state`,
       /Nil => \{ ret!\(\("gov-error", "no identity"\)\) \}/.test(src),
       "the powerbox answers Nil, not an error, for a forged deployer id");
    ok(`${name}: derives identity and never takes it as an argument`,
       /revAddr!\("fromDeployerId", \*_id, \*a\)/.test(src) && !/@me,\s*@verb/.test(src.replace(/contract doSelf\(@me, @verb/g, "")),
       "a caller must not be able to name a row");
    ok(`${name}: every dispatcher answers a bad arity instead of falling silent`,
       (src.match(/"gov-error", "bad verb or arity"/g) || []).length >= 3,
       "law 40 — a call at the wrong arity does nothing and nothing errors");
    ok(`${name}: admin is gated to the installer`,
       /match me == owner \{/.test(src) && /"gov-error", "not the installer"/.test(src));
    // The Inbox is a vault: it refuses whole-contract dump/load outright, since
    // dump leaks every message body and load could never have carried a
    // capability anyway. Group and Issue hold state the read facet already
    // publishes, so for them dump/load is migration and not a disclosure.
    if (name === "Inbox") {
      ok(`${name}: refuses whole-contract dump and load`,
         /"gov-error", "no whole-contract dump"/.test(src) && /"gov-error", "no whole-contract load"/.test(src),
         "dump returns message bodies; load cannot carry an unforgeable");
      ok(`${name}: migration is per-identity instead`,
         /\["export", \[\]\]/.test(src) && /\["import", \[lockers\]\]/.test(src));
      ok(`${name}: import refuses to merge into existing lockers`,
         /"gov-error", "already has lockers"/.test(src));
    } else {
      ok(`${name}: load refuses a non-empty cell`, /"gov-error", "not empty"/.test(src));
    }
    // `if` is a PROCESS in rholang, so using one where a value belongs stores a
    // conditional and the next read of that field dies with "Expected a single
    // expression". setRole did exactly this and only the live check caught it.
    ok(`${name}: uses no inline if — branch with match instead`,
       !/\bif\s*\(/.test(src.replace(/\/\/[^\n]*/g, "")),
       "rholang's if is a process, not an expression");
  }

  // A deployerId is UNFORGEABLE but DELEGABLE BY DISCLOSURE: it behaves like a
  // key, not like a signature. Measured on the node — a contract that stores
  // `*deployerId` in readable state hands its identity to anyone who reads it,
  // and the holder can then act as that identity anywhere, including here.
  // Forging one is impossible (a public key, or a string, yields Nil), so the
  // only exposure is a contract that gives one away. These do not: every use of
  // the caller's id is the address derivation and nothing else.
  for (const [name, src] of Object.entries(ALL)) {
    const uses = (src.match(/\*_id/g) || []).length;
    const derivations = (src.match(/revAddr!\("fromDeployerId", \*_id,/g) || []).length;
    ok(`${name}: the caller's deployerId is derived and never stored or returned`,
       uses > 0 && uses === derivations,
       `${uses} uses of *_id, ${derivations} of them the address derivation`);
  }

  // --- the read/self split -------------------------------------------------
  ok("Inbox: the public read facet answers no message body",
     !/doRead[\s\S]*?getOrElse\("msgs", \{\}\)\)\s*\}/.test(INBOX_RHO.split("contract doRead")[1] ?? "") ||
     !/ret!\(s\.getOrElse\(addr, \{\}\)\.getOrElse\(tag, \{\}\)\.getOrElse\("msgs", \{\}\)\)/.test(INBOX_RHO),
     "read must answer tags, types and counts — never contents");
  ok("Inbox: bodies are reachable only through a granted per-locker cap",
     /contract readOne\(/.test(INBOX_RHO) && /"granted", "read"/.test(INBOX_RHO));
  // History (quantum-os#241): owner-only, capability-free, per-owner, bounded.
  ok("Inbox: history is a self verb, not a read verb",
     /\["history", \[query, cursor, limit\]\]/.test(INBOX_RHO.split("contract doRead")[0]) &&
     !/"history"/.test(INBOX_RHO.split("contract doRead")[1] ?? ""));
  ok("Inbox: receive and take both keep history", (INBOX_RHO.match(/histAppend!\(me,/g) || []).length === 2);
  ok("Inbox: history keeps only plain fields, never a capability",
     /String => \{ strip!/.test(INBOX_RHO) && /_      => \{ strip!\(rest, acc, \*ret\) \}/.test(INBOX_RHO));
  ok("Inbox: each owner's history is its own cell", /@\(\*hist, me\)!\(h/.test(INBOX_RHO));
  ok("Inbox: a history page and a history are bounded",
     INBOX_RHO.includes(`lim!(${HISTORY_PAGE})`) && INBOX_RHO.includes(`length() > ${HISTORY_KEEP}`));
  ok("Inbox: importHistory refuses to merge", /"gov-error", "already has history"/.test(INBOX_RHO));
  ok("Inbox: migration carries history", /"exportHistory"/.test(migrateLockersProgram("rho:id:a", "rho:id:b")));
  ok("Inbox: historyProgram builds the call", /"history", \[\{"from": "x"\}, Nil, 50\]/.test(historyProgram("rho:id:a", { from: "x" })),
     historyProgram("rho:id:a", { from: "x" }).slice(-200));
  ok("Inbox: peek is not a public verb", !/"peek"/.test(INBOX_RHO),
     "a non-consuming read of a vault of capabilities is the dangerous one");
  ok("Inbox: a locker indexes by type rather than scanning",
     /\.getOrElse\("msgs", \{\}\)\.getOrElse\(type, \[\]\)/.test(INBOX_RHO));
  ok("Inbox: a first send creates the DEFAULT locker, so push-onboarding works",
     /match tag == "inbox" \{/.test(INBOX_RHO) && /"sent", to, tag, ty, "locker created"/.test(INBOX_RHO),
     "requirement 5 — neither direction of onboarding may require the other first");
  ok("Inbox: only the default tag is auto-created",
     /false => \{ state!\(s\) \| ret!\(\("gov-error", "no such locker", to, tag\)\) \}/.test(INBOX_RHO),
     "or one sender could litter an identity with lockers it never wanted");
  ok("Issue: the electorate can be refreshed after open",
     /\["setRoll", \[iid, voters\]\]/.test(ISSUE_RHO) && /"gov-error", "closed", iid/.test(ISSUE_RHO),
     "open is idempotent, so a roll set at first push would freeze the electorate");
  ok("Issue: every roll change is logged publicly, with the ballots already cast",
     /\.set\("rollLog", log \+\+ \[entry\]\)/.test(ISSUE_RHO) && /"ballotsBefore"/.test(ISSUE_RHO)
       && /\["rollLogOf", \[iid\]\]/.test(ISSUE_RHO),
     "a roll edited after voting began must be visible, not quiet (quantum-os#244)");
  ok("Inbox: send stamps the sender and does not take it",
     /msg\.set\("from", me\)/.test(INBOX_RHO));

  // --- the interface rule --------------------------------------------------
  const nativeArgs = {
    ratingsOf: "trustLevels arg 1", adminsOf: "trustLevels arg 2",
    delegationsOf: "resolveWeights arg 2", censuresOf: "censure arg 1",
    vouchersOf: "censure arg 3",
  };
  for (const verb of Object.keys(nativeArgs)) {
    ok(`Group: read verb ${verb} exists (${nativeArgs[verb]})`, new RegExp(`\\["${verb}",`).test(GROUP_RHO));
  }
  ok("Issue: ballotsOf exists (tally arg 1)", /\["ballotsOf", \[iid\]\]/.test(ISSUE_RHO));
  ok("Group: ratingsOf and vouchersOf answer the same list",
     (GROUP_RHO.match(/triples!\(s\.getOrElse\(gid, \{\}\)\.getOrElse\("ratings", \{\}\)\.toList\(\), \[\], \*sub\)/g) || []).length === 2,
     "a rating IS the stake a censure slashes");
  ok("Group: delegationsOf composes topic over standing with ++",
     /getOrElse\("deleg", \{\}\) \+\+ g\.getOrElse\("topic", \{\}\)\.getOrElse\(issueId, \{\}\)/.test(GROUP_RHO),
     "map ++ is right-biased — verified on the node");
  ok("Group: ratings are stored raw, not capped in the contract",
     !/TRUST_MAX|\bmin\(/.test(GROUP_RHO),
     "gov.ts and trustLevels cap; one rule in two places can disagree across an upgrade");

  // --- privilege is data, not the installer's capability -------------------
  ok("Group: admin verbs check the group's own admins set",
     /getOrElse\("admins", \{\}\)\.contains\(me\)/.test(GROUP_RHO) && /"gov-error", "not an admin"/.test(GROUP_RHO),
     "otherwise whoever deployed the contract would own every group in it");
  ok("Issue: opener-only verbs check the issue's own opener",
     /getOrElse\("by", Nil\) == me/.test(ISSUE_RHO) && /"gov-error", "not the opener"/.test(ISSUE_RHO));
  ok("Group: onboarding works in both directions",
     /\["join", \[gid, label\]\]/.test(GROUP_RHO) && /\["invite", \[gid, addr\]\]/.test(GROUP_RHO),
     "requirement 5 — neither direction may require the other to have happened");
  ok("Group: the last admin can be neither demoted nor leave while others remain",
     (GROUP_RHO.match(/"gov-error", "last admin", gid/g) || []).length === 2,
     "a group with no admin can never invite or promote again (rhogov#75)");
  ok("Group: an invitation can be withdrawn, by an admin",
     /\["uninvite", \[gid, addr\]\] => \{[\s\S]*?getOrElse\("admins", \{\}\)\.contains\(me\)[\s\S]*?\.delete\(addr\)/.test(GROUP_RHO)
       && /"uninvite", \["g2", "1111bob"\]/.test(uninviteProgram(URI, "g2", "1111bob")),
     "otherwise a mistaken invitation stays published forever (quantum-os#246)");
  // A comment may NAME the native; binding one would mean the contract counts.
  ok("Issue: no contract counts votes",
     !/`rho:gov:/.test(ISSUE_RHO) && /\["propose", \[iid, result\]\]/.test(ISSUE_RHO),
     "a result is a claim about the ballots, keyed by who claimed it");
  ok("Issue: only the opener can propose the result",
     /\["propose", \[iid, result\]\] => \{\s*match s\.getOrElse\(iid, Nil\) \{[\s\S]*?getOrElse\("by", Nil\) == me[\s\S]*?"not the opener"/.test(ISSUE_RHO),
     "an ungated propose let any member post a rival result (quantum-os#245)");

  // --- install programs ----------------------------------------------------
  for (const [name, prog] of Object.entries({
    Inbox: installInboxProgram(), Group: installGroupProgram(), Issue: installIssueProgram(),
  })) {
    ok(`${name}: install program is well-formed`, balanced(prog));
    ok(`${name}: install publishes all three facets`,
       prog.includes('"read": bundle+{*readFacet}') && prog.includes('"self": bundle+{*selfFacet}') && prog.includes('"admin": bundle+{*adminFacet}'));
    ok(`${name}: install records the installer's derived address`,
       /revAddr!\("fromDeployerId", \*deployerId, \*a\)/.test(prog) && /ownerCh!\(owner\)/.test(prog));
    ok(`${name}: install uses insertArbitrary, not insertSigned`,
       prog.includes("insertArbitrary!(") && !prog.includes("insertSigned"),
       "insertSigned writes the one slot every deploy's answer goes to");
    ok(`${name}: no CAPS/VERBS/HELPERS placeholder survives`, !/\b(CAPS|VERBS|HELPERS)\b/.test(prog), prog.slice(0, 160));
  }

  // --- call sites ----------------------------------------------------------
  const w = newLockerProgram(URI, "inbox", "open");
  ok("write: passes deployerId first, then verb, then an args LIST",
     /@found!\(\*deployerId, "newLocker", \["inbox", "open"\], \*ret\)/.test(w), w);
  ok("write: answers on both return and deployId", /return!\(answer\) \| deployId!\(answer\)/.test(w));
  ok("write: binds the facet out of the record before calling it",
     /\{"self": found, \.\.\._\}/.test(w) && /@found!/.test(w),
     "a bundle taken from a map is not callable in place — locker.js hit this");
  ok("write: accepts either shape lookup may answer with",
     /match record \{ \(_, c\) => \{ capsCh!\(c\) \} c => \{ capsCh!\(c\) \} \}/.test(w),
     "rholo answers the bare value; the Scala shape is a (_, caps) tuple");

  const r = ratingsOfProgram(URI, "g1");
  ok("read: is well-formed", balanced(r));
  ok("read: binds neither deployerId nor deployId",
     !/rho:rchain:deployerId/.test(r) && !/rho:rchain:deployId/.test(r),
     "neither is bound under an exploratory deploy — law 4");
  ok("read: declares return first so the exploratory path finds it",
     /^new return, lookup/.test(r), r.slice(0, 60));
  ok("read: reaches the read facet and no other",
     /\{"read": found, \.\.\._\}/.test(r) && !/"self":/.test(r));

  const mig = migrateLockersProgram(URI, "rho:id:zzzz");
  ok("migration keeps export and import in ONE term",
     /@oldSelf!\(\*deployerId, "export", \[\], \*r1\)/.test(mig) && /@newSelf!\(\*deployerId, "import", \[lockers\], \*r2\)/.test(mig),
     "the only way an unforgeable survives — a client cannot serialise one");
  ok("migration resolves both contracts itself", balanced(mig) && /lookup!\(`rho:id:zzzz`/.test(mig));

  ok("admin: dump reaches the admin facet", /\{"admin": found, \.\.\._\}/.test(dumpProgram(URI)));

  const del = delegateProgram(URI, "g1", "1111bob", null);
  ok("delegate: a null issue becomes Nil, the standing delegation",
     /\["g1", "1111bob", Nil\]/.test(del), del);
  ok("delegate: an issue id is quoted, not Nil",
     /\["g1", "1111bob", "i7"\]/.test(delegateProgram(URI, "g1", "1111bob", "i7")));

  const iss = openIssueProgram(URI, "i1", "g1", "Ship it?", "ranked", ["yes", "no"], ["1111a", "1111b"]);
  ok("open: options are a list and voters a map", /\["yes", "no"\], \{"1111a": true, "1111b": true\}/.test(iss), iss);
  ok("rate: a level reaches rholang as a number, not a string", /\["g1", "1111bob", 3\]/.test(rateProgram(URI, "g1", "1111bob", 3)));

  // A string argument cannot escape its position: it reaches rholang through a
  // literal, so quotes and backslashes are escaped rather than closing it.
  const nasty = newLockerProgram(URI, 'x", *evil) | @"stolen"!("', "open");
  ok("a hostile argument stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')), nasty);
  ok("no quoted name in any call site",
     [w, r, del, iss, dumpProgram(URI)].every((p) => !/@"/.test(p)));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
