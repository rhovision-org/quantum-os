// rholang-exchange.js — a pooled token exchange, and its federation.
//
// A **pool** trades one pair of tokens at a fixed (owner-set) rate. Anyone
// holding the exchange URI can `deposit` a token they moved in, `swap` at the
// rate, and `withdraw`; the owner seeds liquidity with `provide` and sets the
// rate. `swap` refuses to overdraw either the swapper's balance or the pool's
// reserve, so conservation is held per pool — capability security is the whole
// proof (no method pays the operator, the pool holds no ambient authority).
//
// **Federation, atomically.** An exchange records peer exchanges by name
// (`link`), each on its own shard. A cross-shard trade is a **two-phase
// commit, client-orchestrated over the Layer-1 remote signed deploy**
// (rholo#33/#34) — no relay, no new consensus, no coordinator that can
// lose the decision:
//   1. `prepare` on the local pool — does the swap now, holds a reversible
//      tx record.
//   2. `prepareReceive` on the linked remote pool — credits the local leg's
//      output as if deposited, swaps it, holds its own reversible record.
//      Gated to a registered `link`: the federation trusts its own linked
//      pools, not an unverified cross-shard claim (shard B cannot read
//      shard A's state directly — that is the reason 2PC exists at all).
//   3. `commit` both, or `abort` the one leg that succeeded — both idempotent.
//      The tx's own holder may always `abort` a prepared tx; anyone else may
//      once the current block number passes the tx's recorded `expiryBlock`
//      (permissionless-after-expiry, quantum-os#198 — see the note on the
//      `abort` contract below). A crashed client can still read `stateOf` on
//      both legs and finish deterministically with its own key before that.
//      See `exchange-2pc.ts` and CapabilityTransport.md.
//
// **Connecting to quantum-os currencies.** A `/note` currency is a bearer
// label; here it is that same label. Deploy a token contract for it
// (`rholang-token.js` / `$token`), record its URI on the currency, and pool two
// such URIs with `$exchange`. `token` is the token's own contract — the
// exchange never touches `rho:rchain:revVault`; the platform token cannot be
// pooled.
//
// Modeled on locker.js / shard_exchange.rho: every contract takes ≥2 params
// (rholo#19), state cells are consumed-and-restored, no quoted names.
//
//   node packages/browser/src/rholang-exchange.js --selftest

/** Rate is fixed-point: `rate` units of B per 1e6 units of A. */
export const RATE_SCALE = 1_000_000;

/**
 * The exchange contract. Deployed once; its URI is then the address every
 * `open` / `deposit` / `swap` / … call resolves through.
 *
 * State:
 *   pools : Map<poolId, { owner, tokenA, tokenB, rate, reserveA, reserveB,
 *                         links: Map<name, {exchangeUri, shard}> }>
 *   bals  : Map<poolId, Map<holder, {a, b}>>   // holder = *deployerId
 *   txs   : Map<txId, { holder, poolId, fromSide, toSide, amount, out,
 *                       expiryBlock, status, receive? }>  // the 2PC log
 */
export const EXCHANGE_RHO = `new
    Exchange, poolsCh, balsCh, txCh,
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), blockData(\`rho:block:data\`), ret
in {
  poolsCh!({}) | balsCh!({}) | txCh!({}) |

  // open — create a pool for a token pair. deployer = owner; rate is B per A,
  // scaled by RATE_SCALE, changed only via "setRate".
  contract Exchange(_id, @"open", @poolId, @tokenA, @tokenB, @rate, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => {
          match rate > 0 {
            false => { poolsCh!(pools) | ret!(("exchange-error", "rate must be positive")) }
            true  => {
              new capCh in {
                insertArbitrary!({"pool": poolId, "owner": *_id}, *capCh) |
                for (@capUri <- capCh) {
                  poolsCh!(pools.set(poolId, {
                    "owner": *_id, "tokenA": tokenA, "tokenB": tokenB, "rate": rate,
                    "reserveA": 0, "reserveB": 0, "links": {}, "cap": capUri
                  })) | ret!(capUri)
                }
              }
            }
          }
        }
        _ => { poolsCh!(pools) | ret!(("exchange-error", "pool exists")) }
      }
    }
  } |

  // provide — owner seeds pool liquidity (tokens moved in out of band).
  contract Exchange(_id, @"provide", @poolId, @side, @amount, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match [p.get("owner") == *_id, side, amount >= 0] {
            [true, "A", true] => { poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + amount))) | ret!(p.get("reserveA") + amount) }
            [true, "B", true] => { poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + amount))) | ret!(p.get("reserveB") + amount) }
            [false, _, _]     => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
            _                 => { poolsCh!(pools) | ret!(("exchange-error", "bad provide")) }
          }
        }
      }
    }
  } |

  // deposit — credit the caller's in-pool balance (token moved in out of band).
  contract Exchange(_id, @"deposit", @poolId, @side, @amount, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh) {
      let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
        match [pools.contains(poolId), side, amount >= 0] {
          [true, "A", true] => { poolsCh!(pools) | balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") + amount)))) | ret!(h.get("a") + amount) }
          [true, "B", true] => { poolsCh!(pools) | balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") + amount)))) | ret!(h.get("b") + amount) }
          _                 => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "bad deposit")) }
        }
      }
    }
  } |

  // quote — what "amount" of "fromSide" buys of the other side.
  contract Exchange(_id, @"quote", @poolId, @fromSide, @amount, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          poolsCh!(pools) |
          match fromSide {
            "A" => { ret!({"toSide": "B", "out": amount * p.get("rate") / 1000000}) }
            "B" => { ret!({"toSide": "A", "out": amount * 1000000 / p.get("rate")}) }
            _   => { ret!(("exchange-error", "fromSide is A or B")) }
          }
        }
      }
    }
  } |

  // swap — from the caller's in-pool balance, against the reserve, at the rate.
  contract Exchange(_id, @"swap", @poolId, @fromSide, @amount, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "no such pool")) }
        p => {
          let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
            match [fromSide, amount >= 0] {
              ["A", true] => {
                let @out <- amount * p.get("rate") / 1000000 in {
                  match [h.get("a") >= amount, p.get("reserveB") >= out] {
                    [true, true] => {
                      poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + amount).set("reserveB", p.get("reserveB") - out))) |
                      balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") - amount).set("b", h.get("b") + out)))) |
                      ret!({"gave": amount, "got": out, "toSide": "B"})
                    }
                    [false, _] => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
                    _          => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient reserve")) }
                  }
                }
              }
              ["B", true] => {
                let @out <- amount * 1000000 / p.get("rate") in {
                  match [h.get("b") >= amount, p.get("reserveA") >= out] {
                    [true, true] => {
                      poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + amount).set("reserveA", p.get("reserveA") - out))) |
                      balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") - amount).set("a", h.get("a") + out)))) |
                      ret!({"gave": amount, "got": out, "toSide": "A"})
                    }
                    [false, _] => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
                    _          => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient reserve")) }
                  }
                }
              }
              _ => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "bad swap")) }
            }
          }
        }
      }
    }
  } |

  // withdraw — debit the caller's in-pool balance; client moves the token out.
  contract Exchange(_id, @"withdraw", @poolId, @side, @amount, ret) = {
    for (@bals <- balsCh) {
      let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
        match [side, amount >= 0] {
          ["A", true] => {
            match h.get("a") >= amount {
              true  => { balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") - amount)))) | ret!({"withdraw": amount, "side": "A", "left": h.get("a") - amount}) }
              false => { balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
            }
          }
          ["B", true] => {
            match h.get("b") >= amount {
              true  => { balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") - amount)))) | ret!({"withdraw": amount, "side": "B", "left": h.get("b") - amount}) }
              false => { balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
            }
          }
          _ => { balsCh!(bals) | ret!(("exchange-error", "bad withdraw")) }
        }
      }
    }
  } |

  // link — owner records a peer exchange on another shard, by name.
  contract Exchange(_id, @"link", @poolId, @name, @exchangeUri, @shard, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match p.get("owner") == *_id {
            true  => { poolsCh!(pools.set(poolId, p.set("links", p.get("links").set(name, {"exchangeUri": exchangeUri, "shard": shard})))) | ret!(["linked", name]) }
            false => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
          }
        }
      }
    }
  } |

  // prepare — do the swap now (reserves + balance adjusted, identical math to
  // "swap"), and hold a reversible tx record so a cross-shard trade can
  // commit or abort as a unit. duplicate txId is refused (check stateOf
  // before retrying).
  contract Exchange(_id, @"prepare", @poolId, @txId, @fromSide, @amount, @expiryBlock, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh; @txs <- txCh) {
      match txs.getOrElse(txId, Nil) {
        Nil => {
          match pools.getOrElse(poolId, Nil) {
            Nil => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "no such pool")) }
            p => {
              let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
                match [fromSide, amount >= 0] {
                  ["A", true] => {
                    let @out <- amount * p.get("rate") / 1000000 in {
                      match [h.get("a") >= amount, p.get("reserveB") >= out] {
                        [true, true] => {
                          poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + amount).set("reserveB", p.get("reserveB") - out))) |
                          balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") - amount).set("b", h.get("b") + out)))) |
                          txCh!(txs.set(txId, {"holder": *_id, "poolId": poolId, "fromSide": "A", "toSide": "B", "amount": amount, "out": out, "expiryBlock": expiryBlock, "status": "prepared"})) |
                          ret!(("prepared", txId, out, "B", expiryBlock))
                        }
                        [false, _] => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient balance")) }
                        _          => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient reserve")) }
                      }
                    }
                  }
                  ["B", true] => {
                    let @out <- amount * 1000000 / p.get("rate") in {
                      match [h.get("b") >= amount, p.get("reserveA") >= out] {
                        [true, true] => {
                          poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + amount).set("reserveA", p.get("reserveA") - out))) |
                          balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") - amount).set("a", h.get("a") + out)))) |
                          txCh!(txs.set(txId, {"holder": *_id, "poolId": poolId, "fromSide": "B", "toSide": "A", "amount": amount, "out": out, "expiryBlock": expiryBlock, "status": "prepared"})) |
                          ret!(("prepared", txId, out, "A", expiryBlock))
                        }
                        [false, _] => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient balance")) }
                        _          => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient reserve")) }
                      }
                    }
                  }
                  _ => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "bad prepare")) }
                }
              }
            }
          }
        }
        _ => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "duplicate txId")) }
      }
    }
  } |

  // prepareReceive — the linked pool's receiving leg: credit "amount" of
  // "side" as if deposited, then swap it here, holding a reversible record.
  // Gated to a registered link — the federation trusts its own linked pools,
  // not an unverified cross-shard claim.
  contract Exchange(_id, @"prepareReceive", @poolId, @txId, @side, @amount, @expiryBlock, @linkName, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh; @txs <- txCh) {
      match txs.getOrElse(txId, Nil) {
        Nil => {
          match pools.getOrElse(poolId, Nil) {
            Nil => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "no such pool")) }
            p => {
              match p.get("links").getOrElse(linkName, Nil) {
                Nil => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "no such link")) }
                lk => {
                  let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
                    match [side, amount >= 0] {
                      ["A", true] => {
                        let @out <- amount * p.get("rate") / 1000000 in {
                          match p.get("reserveB") >= out {
                            true  => {
                              poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") - out))) |
                              balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") + out)))) |
                              txCh!(txs.set(txId, {"holder": *_id, "poolId": poolId, "fromSide": "A", "toSide": "B", "amount": amount, "out": out, "expiryBlock": expiryBlock, "status": "prepared", "receive": true, "link": linkName})) |
                              ret!(("prepared", txId, out, "B", expiryBlock))
                            }
                            false => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient reserve")) }
                          }
                        }
                      }
                      ["B", true] => {
                        let @out <- amount * 1000000 / p.get("rate") in {
                          match p.get("reserveA") >= out {
                            true  => {
                              poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") - out))) |
                              balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") + out)))) |
                              txCh!(txs.set(txId, {"holder": *_id, "poolId": poolId, "fromSide": "B", "toSide": "A", "amount": amount, "out": out, "expiryBlock": expiryBlock, "status": "prepared", "receive": true, "link": linkName})) |
                              ret!(("prepared", txId, out, "A", expiryBlock))
                            }
                            false => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "insufficient reserve")) }
                          }
                        }
                      }
                      _ => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "bad prepareReceive")) }
                    }
                  }
                }
              }
            }
          }
        }
        _ => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "duplicate txId")) }
      }
    }
  } |

  // commit — the effect already happened at prepare/prepareReceive time;
  // this only makes the decision durable and readable via stateOf.
  // Idempotent; only the tx's own holder may commit it.
  contract Exchange(_id, @"commit", @txId, ret) = {
    for (@txs <- txCh) {
      match txs.getOrElse(txId, Nil) {
        Nil => { txCh!(txs) | ret!(("exchange-error", "unknown tx")) }
        e => {
          match [e.get("holder") == *_id, e.get("status")] {
            [false, _]           => { txCh!(txs) | ret!(("exchange-error", "not holder")) }
            [true, "aborted"]    => { txCh!(txs) | ret!(("exchange-error", "already aborted")) }
            [true, "committed"]  => { txCh!(txs) | ret!(("committed", txId, e.get("out"), e.get("toSide"))) }
            [true, "prepared"]   => { txCh!(txs.set(txId, e.set("status", "committed"))) | ret!(("committed", txId, e.get("out"), e.get("toSide"))) }
            _                    => { txCh!(txs) | ret!(("exchange-error", "bad tx state")) }
          }
        }
      }
    }
  } |

  // abort — the tx's own holder may always abort a prepared tx; anyone else
  // may abort it once the current block number has passed expiryBlock
  // (permissionless-after-expiry, quantum-os#198). Reverses the swap/credit
  // exactly. Idempotent; refuses to abort an already-committed tx.
  //
  // rho:block:data reads fine here: the 2026-09-11 finding that a *signed*
  // deploy reading rho:block:data never got its return!'d value through
  // wrapProgram's registry-readback forwarder (reproduced down to a bare
  // block-data read + return!, bin/rnode 0.1.0) does not reproduce on
  // rholo dev 9e667e203 — re-verified 2026-09-14, twice, against a
  // fresh devnet: the registry slot resolved on the first poll both times.
  // Not bisected which upstream change (of #44/#45 block-header timestamp,
  // dynamic validators, #47 strings, #48 rho:io:http, #49 universal BigInt,
  // #53 deploy attachments, #54 checked merge diffs) fixed it.
  contract Exchange(_id, @"abort", @poolId, @txId, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh; @txs <- txCh) {
      match txs.getOrElse(txId, Nil) {
        Nil => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "unknown tx")) }
        e => {
          match e.get("status") {
            "aborted"   => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("aborted", txId)) }
            "committed" => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "already committed")) }
            "prepared"  => {
              new bret in {
                blockData!(*bret) |
                for (@bn, @ts, @s <- bret) {
                  match [e.get("holder") == *_id, bn >= e.get("expiryBlock")] {
                    [false, false] => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "not holder; not yet expired")) }
                    _ => {
                      match pools.get(poolId) {
                        p => {
                          match [e.get("receive"), e.get("toSide")] {
                            [true, "B"] => {
                              let @h <- bals.getOrElse(poolId, {}).getOrElse(e.get("holder"), {"a": 0, "b": 0}) in {
                                poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + e.get("out")))) |
                                balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(e.get("holder"), h.set("b", h.get("b") - e.get("out")))))
                              }
                            }
                            [true, "A"] => {
                              let @h <- bals.getOrElse(poolId, {}).getOrElse(e.get("holder"), {"a": 0, "b": 0}) in {
                                poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + e.get("out")))) |
                                balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(e.get("holder"), h.set("a", h.get("a") - e.get("out")))))
                              }
                            }
                            [_, "B"] => {
                              let @h <- bals.getOrElse(poolId, {}).getOrElse(e.get("holder"), {"a": 0, "b": 0}) in {
                                poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") - e.get("amount")).set("reserveB", p.get("reserveB") + e.get("out")))) |
                                balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(e.get("holder"), h.set("a", h.get("a") + e.get("amount")).set("b", h.get("b") - e.get("out")))))
                              }
                            }
                            [_, "A"] => {
                              let @h <- bals.getOrElse(poolId, {}).getOrElse(e.get("holder"), {"a": 0, "b": 0}) in {
                                poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") - e.get("amount")).set("reserveA", p.get("reserveA") + e.get("out")))) |
                                balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(e.get("holder"), h.set("b", h.get("b") + e.get("amount")).set("a", h.get("a") - e.get("out")))))
                              }
                            }
                          } |
                          txCh!(txs.set(txId, e.set("status", "aborted"))) |
                          ret!(("aborted", txId))
                        }
                      }
                    }
                  }
                }
              }
            }
            _ => { poolsCh!(pools) | balsCh!(bals) | txCh!(txs) | ret!(("exchange-error", "bad tx state")) }
          }
        }
      }
    }
  } |

  // stateOf — read-only; the recovery primitive. A crashed client (or anyone)
  // reads this on both legs and finishes deterministically. rholo#33
  // remote reads need no signature, so this is cheap to poll.
  contract Exchange(_id, @"stateOf", @txId, ret) = {
    for (@txs <<- txCh) {
      match txs.getOrElse(txId, Nil) {
        Nil => { ret!(("unknown", txId)) }
        e   => { ret!(e) }
      }
    }
  } |

  // setRate — owner only.
  contract Exchange(_id, @"setRate", @poolId, @rate, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match [p.get("owner") == *_id, rate > 0] {
            [true, true]  => { poolsCh!(pools.set(poolId, p.set("rate", rate))) | ret!(["rate", rate]) }
            [false, _]    => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
            _             => { poolsCh!(pools) | ret!(("exchange-error", "rate must be positive")) }
          }
        }
      }
    }
  } |

  // inspect — read the pool (anyone holding the exchange URI).
  contract Exchange(_id, @"inspect", @poolId, ret) = {
    for (@pools <<- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { ret!(("exchange-error", "no such pool")) }
        p => { ret!({"tokenA": p.get("tokenA"), "tokenB": p.get("tokenB"), "rate": p.get("rate"),
                     "reserveA": p.get("reserveA"), "reserveB": p.get("reserveB"), "links": p.get("links")}) }
      }
    }
  } |

  CAPS
}`;

/** The verbs published behind write bundles. */
const FACETS = `{
    "open":     bundle+{*Exchange}, "provide":  bundle+{*Exchange},
    "deposit":  bundle+{*Exchange}, "quote":    bundle+{*Exchange},
    "swap":     bundle+{*Exchange}, "withdraw": bundle+{*Exchange},
    "link":     bundle+{*Exchange}, "setRate":  bundle+{*Exchange},
    "inspect":  bundle+{*Exchange},
    "prepare":        bundle+{*Exchange}, "prepareReceive": bundle+{*Exchange},
    "commit":         bundle+{*Exchange}, "abort":          bundle+{*Exchange},
    "stateOf":        bundle+{*Exchange}
  }`;

const q = (s) => JSON.stringify(String(s));
const int = (v) => { const s = String(v); if (!/^-?\d+$/.test(s)) throw new Error(`not an integer: ${s}`); return s; };

/** The install program — publishes the exchange with `insertArbitrary`. */
export function installProgram() {
  return EXCHANGE_RHO.replace("CAPS", `insertArbitrary!(${FACETS}, *ret) |
  for (@uri <- ret) { return!(uri) }`);
}

/**
 * One exchange call, as a complete program. Every call is its own deploy —
 * `deployerId` exists only inside a deploy, and a registry facet answers only
 * the first call in a program (rholo#21).
 */
export function exchangeCall(exchangeUri, verb, args = []) {
  const call = ["*deployerId", q(verb), ...args].join(", ");
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`), stored, ret in {
  lookup!(\`${exchangeUri}\`, *stored) |
  for (@record <- stored) {
    match record {
      (_, caps) => {
        match caps.get(${q(verb)}) {
          Nil  => { return!(["no verb", ${q(verb)}]) }
          verb => { @verb!(*deployerId, ${q(verb)}${args.length ? ", " + args.join(", ") : ""}, *ret) | for (@a <- ret) { return!(a) } }
        }
      }
      _ => { return!(["no exchange at", ${q(exchangeUri)}]) }
    }
  }
}`;
}

export const openProgram    = (uri, poolId, tokenAUri, tokenBUri, rate) => exchangeCall(uri, "open", [q(poolId), q(tokenAUri), q(tokenBUri), int(rate)]);
export const provideProgram = (uri, poolId, side, amount) => exchangeCall(uri, "provide", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const depositProgram = (uri, poolId, side, amount) => exchangeCall(uri, "deposit", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const quoteProgram   = (uri, poolId, fromSide, amount) => exchangeCall(uri, "quote", [q(poolId), q(fromSide.toUpperCase()), int(amount)]);
export const swapProgram    = (uri, poolId, fromSide, amount) => exchangeCall(uri, "swap", [q(poolId), q(fromSide.toUpperCase()), int(amount)]);
export const withdrawProgram= (uri, poolId, side, amount) => exchangeCall(uri, "withdraw", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const linkProgram    = (uri, poolId, name, remoteUri, shard) => exchangeCall(uri, "link", [q(poolId), q(name), q(remoteUri), q(shard)]);
export const setRateProgram = (uri, poolId, rate) => exchangeCall(uri, "setRate", [q(poolId), int(rate)]);
export const inspectProgram = (uri, poolId) => exchangeCall(uri, "inspect", [q(poolId)]);

// --- two-phase commit: the atomic cross-shard federation primitive --------
export const prepareProgram = (uri, poolId, txId, fromSide, amount, expiryBlock) =>
  exchangeCall(uri, "prepare", [q(poolId), q(txId), q(fromSide.toUpperCase()), int(amount), int(expiryBlock)]);
export const prepareReceiveProgram = (uri, poolId, txId, side, amount, expiryBlock, linkName) =>
  exchangeCall(uri, "prepareReceive", [q(poolId), q(txId), q(side.toUpperCase()), int(amount), int(expiryBlock), q(linkName)]);
export const commitProgram  = (uri, txId) => exchangeCall(uri, "commit", [q(txId)]);
export const abortProgram   = (uri, poolId, txId) => exchangeCall(uri, "abort", [q(poolId), q(txId)]);
export const stateOfProgram = (uri, txId) => exchangeCall(uri, "stateOf", [q(txId)]);

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/rholang-exchange.js --selftest
// Shape only (balanced, verb names, arg order, ≥2 params, no quoted names);
// live-node behaviour is a follow-up like locker.js / captp.
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, d) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${d ? `  (${d})` : ""}`); } };

  const balanced = (s) => {
    const st = []; const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };
  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";

  const VERBS = ["open","provide","deposit","quote","swap","withdraw","link","setRate","inspect",
                 "prepare","prepareReceive","commit","abort","stateOf"];

  ok("contract template is balanced", balanced(EXCHANGE_RHO));
  ok("no quoted name", !/@"[a-z]/.test(EXCHANGE_RHO.replace(new RegExp(`@"(${VERBS.join("|")})"`, "g"), "")), "@\"…\"");
  ok("every verb dispatch keeps ≥2 params",
     [...EXCHANGE_RHO.matchAll(/contract Exchange\(([^)]*)\)/g)].every((m) => m[1].split(",").filter((x) => x.trim()).length >= 3),
     "@\"verb\" + arg + ret");
  // Mutating verbs consume the state cells with `<-` and must restore them;
  // read-only verbs (inspect/stateOf) peek with `<<-`. Check every consuming
  // block restores what it consumed — a leaked cell deadlocks the contract.
  const restores = (chVar, chName) =>
    [...EXCHANGE_RHO.split("contract Exchange(")].slice(1).every((blk) => {
      const consumes = new RegExp(`@${chVar} <- ${chName}`).test(blk);
      return !consumes || (blk.match(new RegExp(`${chName}!\\(`, "g")) || []).length >= 1;
    });
  ok("every `<- poolsCh` block restores poolsCh", restores("pools", "poolsCh"));
  ok("every `<- balsCh` block restores balsCh", restores("bals", "balsCh"));
  ok("every `<- txCh` block restores txCh", restores("txs", "txCh"));
  ok("never touches revVault", !/revVault|rho:rchain:revVault/.test(EXCHANGE_RHO));
  ok("all fourteen verbs defined", VERBS.every((v) => EXCHANGE_RHO.includes(`@"${v}"`)));
  ok("binds rho:block:data for abort's expiry check", EXCHANGE_RHO.includes("blockData(`rho:block:data`)"));
  ok("abort is holder-or-expired-gated",
     /"abort", @poolId, @txId, ret\) = \{[\s\S]*?e\.get\("holder"\) == \*_id, bn >= e\.get\("expiryBlock"\)/.test(EXCHANGE_RHO));
  ok("abort denies a non-holder before expiry",
     /\[false, false\] => \{[\s\S]*?"not holder; not yet expired"/.test(EXCHANGE_RHO));

  const inst = installProgram();
  ok("install is balanced", balanced(inst));
  ok("install has no CAPS placeholder", !/\bCAPS\b/.test(inst));
  ok("install publishes via insertArbitrary", inst.includes("insertArbitrary!("));

  const open = openProgram(URI, "USD-EUR", "rho:id:usd", "rho:id:eur", 920000);
  ok("open is balanced", balanced(open));
  ok("open carries deployerId, verb, pool, tokens, rate in order",
     /@verb!\(\*deployerId, "open", "USD-EUR", "rho:id:usd", "rho:id:eur", 920000, \*ret\)/.test(open), open.slice(-260));

  const swap = swapProgram(URI, "USD-EUR", "a", 100n);
  ok("swap upper-cases the side and passes the amount", /@verb!\(\*deployerId, "swap", "USD-EUR", "A", 100, \*ret\)/.test(swap), swap.slice(-200));

  const link = linkProgram(URI, "USD-EUR", "paris", "rho:id:paris", "https://shard-b.example");
  ok("link carries name, uri, shard", /"paris", "rho:id:paris", "https:\/\/shard-b.example"/.test(link));

  const prep = prepareProgram(URI, "USD-EUR", "tx1", "a", 100, 999);
  ok("prepare carries txId, side, amount, expiry", /@verb!\(\*deployerId, "prepare", "USD-EUR", "tx1", "A", 100, 999, \*ret\)/.test(prep), prep.slice(-220));

  const recv = prepareReceiveProgram(URI, "EUR-GBP", "tx1", "b", 92, 999, "shardA");
  ok("prepareReceive carries txId, side, amount, expiry, link", /@verb!\(\*deployerId, "prepareReceive", "EUR-GBP", "tx1", "B", 92, 999, "shardA", \*ret\)/.test(recv), recv.slice(-260));

  const commit = commitProgram(URI, "tx1");
  ok("commit carries only txId", /@verb!\(\*deployerId, "commit", "tx1", \*ret\)/.test(commit));

  const abort = abortProgram(URI, "USD-EUR", "tx1");
  ok("abort carries poolId + txId", /@verb!\(\*deployerId, "abort", "USD-EUR", "tx1", \*ret\)/.test(abort));

  const stateOf = stateOfProgram(URI, "tx1");
  ok("stateOf carries only txId", /@verb!\(\*deployerId, "stateOf", "tx1", \*ret\)/.test(stateOf));

  ok("a non-integer amount is rejected",
     (() => { try { swapProgram(URI, "p", "A", "1.5"); return false; } catch { return true; } })());
  ok("a non-integer expiryBlock is rejected",
     (() => { try { prepareProgram(URI, "p", "tx", "A", 1, "soon"); return false; } catch { return true; } })());

  const nasty = openProgram(URI, 'x", *evil) | @"stolen"!("', "rho:id:a", "rho:id:b", 1);
  ok("a hostile pool id stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

// Auto-run only when this file IS the entry point (not when imported by
// rholang-macros.js under a `--selftest` parent process).
if (typeof process !== "undefined" && process.argv?.includes("--selftest") &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(selftest() ? 0 : 1);
}
