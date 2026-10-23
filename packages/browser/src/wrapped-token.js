// wrapped-token.js — a wrapped representation of a native platform token
// (REV, or any chain's own token), so it can trade on the pooled exchange
// (rholang-exchange.js) without the exchange ever touching `revVault`.
//
// This contract never mentions revVault — that's the whole point, and it's
// checked by --selftest. The revVault touch happens OUTSIDE it, in the
// issuer's own `$wrap`/`$wrelease` macro (rholang-macros.js): wrapping is
// the issuer's sanctioned deploy — transfer real REV to a backing address,
// then mint here — never something this contract does on anyone's behalf.
//
//   mint(amount, holder)     issuer only — credits holder's balance
//   burn(amount, claimId)    the holder — debits their own balance, records
//                            a permanent redemption claim
//   release(claimId)         issuer only — marks a claim released (bookkeeping;
//                            the actual REV transfer is the issuer's own
//                            $wrelease deploy, chained around this call)
//   balanceOf(holder)        read
//   claimOf(claimId)         read
//   info()                   read — {issuer, backingAddr, baseCurrency, supply}
//                            so anyone can $balance(backingAddr) and compare
//                            it against supply — the public half of the
//                            trust story (the issuer could still misbehave;
//                            this makes misbehavior visible, not impossible)
//
// Fungibility: deploy one of these per (baseCurrency, issuer) pair — the
// label convention is w<BASE>~<issuer8>, same shape as a terms-stamped note
// series (notes.ts termsHash8) — non-fungible across issuers.
//
// Modeled on locker.js / rholang-exchange.js: every contract takes ≥2 params
// (rholo#19), state cells are consumed-and-restored, no quoted names.
//
//   node packages/browser/src/wrapped-token.js --selftest

/**
 * The wrapped-token contract. Deployed once per (currency, issuer) pair; the
 * deployer becomes the permanent issuer (the locker's "the id IS the
 * authority" pattern — issuer is bound at install, never passed as an arg).
 *
 * State:
 *   supply : Int
 *   bals   : Map<holder, amount>
 *   claims : Map<claimId, {holder, amount, status}>   // status: pending|released
 */
export const WRAPPED_TOKEN_RHO = `new
    Wrapped, balsCh, claimsCh, supplyCh,
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`),
    revAddr(\`rho:rev:address\`), ret
in {
  balsCh!({}) | claimsCh!({}) | supplyCh!(0) |

  // mint — issuer only. Credits holder's balance.
  contract Wrapped(_id, @"mint", @amount, @holder, ret) = {
    for (@bals <- balsCh; @supply <- supplyCh) {
      match [ISSUER == *_id, amount >= 0] {
        [true, true] => {
          balsCh!(bals.set(holder, bals.getOrElse(holder, 0) + amount)) |
          supplyCh!(supply + amount) |
          ret!(("minted", amount, holder, supply + amount))
        }
        [false, _] => { balsCh!(bals) | supplyCh!(supply) | ret!(("exchange-error", "not issuer")) }
        _          => { balsCh!(bals) | supplyCh!(supply) | ret!(("exchange-error", "bad mint")) }
      }
    }
  } |

  // burn — the holder debits their own balance, identified by their REV
  // address derived on-chain from *_id via rho:rev:address (never a
  // caller-supplied string, so nobody can name someone else's balance) —
  // matching how "mint" names a holder by that same address. Records a
  // permanent redemption claim; duplicate claimId is refused.
  contract Wrapped(_id, @"burn", @amount, @claimId, ret) = {
    new aret in {
      revAddr!("fromDeployerId", *_id, *aret) |
      for (@myAddr <- aret) {
        for (@bals <- balsCh; @supply <- supplyCh; @claims <- claimsCh) {
          match claims.getOrElse(claimId, Nil) {
            Nil => {
              let @bal <- bals.getOrElse(myAddr, 0) in {
                match [bal >= amount, amount >= 0] {
                  [true, true] => {
                    balsCh!(bals.set(myAddr, bal - amount)) |
                    supplyCh!(supply - amount) |
                    claimsCh!(claims.set(claimId, {"holder": myAddr, "amount": amount, "status": "pending"})) |
                    ret!(("burned", claimId, amount))
                  }
                  [false, _] => { balsCh!(bals) | supplyCh!(supply) | claimsCh!(claims) | ret!(("exchange-error", "insufficient balance")) }
                  _          => { balsCh!(bals) | supplyCh!(supply) | claimsCh!(claims) | ret!(("exchange-error", "bad burn")) }
                }
              }
            }
            _ => { balsCh!(bals) | supplyCh!(supply) | claimsCh!(claims) | ret!(("exchange-error", "duplicate claimId")) }
          }
        }
      }
    }
  } |

  // transfer — ordinary peer-to-peer transfer between holders, the same
  // shape as REV's own transfer and a minimal ERC20's: debit the
  // caller's own balance (self-identified via rho:rev:address, same as
  // "burn" — never a caller-supplied string), credit "to". Works
  // identically whether the balance came from mint (a personal currency) or
  // wrap (a wrapped native token) — same ledger either way. Self-transfer
  // is refused outright rather than risked: "to" and the caller's derived
  // address are different map keys in the success case, so the debit and
  // credit never alias.
  contract Wrapped(_id, @"transfer", @to, @amount, ret) = {
    new aret in {
      revAddr!("fromDeployerId", *_id, *aret) |
      for (@myAddr <- aret) {
        for (@bals <- balsCh) {
          match [myAddr == to, bals.getOrElse(myAddr, 0) >= amount, amount >= 0] {
            [true, _, _]        => { balsCh!(bals) | ret!(("exchange-error", "cannot transfer to yourself")) }
            [false, true, true] => {
              balsCh!(bals.set(myAddr, bals.getOrElse(myAddr, 0) - amount).set(to, bals.getOrElse(to, 0) + amount)) |
              ret!(("transferred", amount, myAddr, to))
            }
            [false, false, _]   => { balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
            _                   => { balsCh!(bals) | ret!(("exchange-error", "bad transfer")) }
          }
        }
      }
    }
  } |

  // release — issuer only; bookkeeping. Does not and cannot move REV itself
  // — that is the issuer's own $wrelease deploy, chained around this call.
  contract Wrapped(_id, @"release", @claimId, ret) = {
    for (@claims <- claimsCh) {
      match [ISSUER == *_id, claims.getOrElse(claimId, Nil)] {
        [false, _] => { claimsCh!(claims) | ret!(("exchange-error", "not issuer")) }
        [true, Nil] => { claimsCh!(claims) | ret!(("exchange-error", "unknown claim")) }
        [true, c] => { claimsCh!(claims.set(claimId, c.set("status", "released"))) | ret!(("released", claimId, c.get("amount"), c.get("holder"))) }
      }
    }
  } |

  // balanceOf — read.
  contract Wrapped(_id, @"balanceOf", @holder, ret) = {
    for (@bals <<- balsCh) { ret!(bals.getOrElse(holder, 0)) }
  } |

  // claimOf — read.
  contract Wrapped(_id, @"claimOf", @claimId, ret) = {
    for (@claims <<- claimsCh) {
      match claims.getOrElse(claimId, Nil) {
        Nil => { ret!(("unknown", claimId)) }
        c   => { ret!(c) }
      }
    }
  } |

  // info — read. The public-verifiability half of the trust story: compare
  // supply against $balance(backingAddr) yourself.
  contract Wrapped(_id, @"info", ret) = {
    for (@supply <<- supplyCh) {
      ret!({"issuer": ISSUER, "backingAddr": BACKING_ADDR, "baseCurrency": BASE_CURRENCY, "supply": supply})
    }
  } |

  CAPS
}`;

/** The verbs published behind write bundles. */
const FACETS = `{
    "mint":       bundle+{*Wrapped}, "burn":       bundle+{*Wrapped},
    "transfer":   bundle+{*Wrapped},
    "release":    bundle+{*Wrapped}, "balanceOf":  bundle+{*Wrapped},
    "claimOf":    bundle+{*Wrapped}, "info":       bundle+{*Wrapped}
  }`;

const q = (s) => JSON.stringify(String(s));
const int = (v) => { const s = String(v); if (!/^-?\d+$/.test(s)) throw new Error(`not an integer: ${s}`); return s; };

/**
 * The install program. The deployer becomes the permanent issuer (bound as
 * `*deployerId` at install time, baked into ISSUER — not a runtime arg, so
 * no later call can claim to be the issuer by simply passing the right
 * string). `backingAddr` is a REV address the issuer controls; `baseCurrency`
 * is a label like "REV". Neither is verified here — that is what `info` +
 * `$balance(backingAddr)` are for.
 */
export function installWrappedProgram(backingAddr, baseCurrency) {
  return WRAPPED_TOKEN_RHO
    .replace(/ISSUER/g, "*deployerId")
    .replace(/BACKING_ADDR/g, q(backingAddr))
    .replace(/BASE_CURRENCY/g, q(baseCurrency))
    .replace("CAPS", `insertArbitrary!(${FACETS}, *ret) |
  for (@uri <- ret) { return!(uri) }`);
}

/** One wrapped-token call, as a complete program — same shape as exchangeCall. */
export function wrappedCall(wrapperUri, verb, args = []) {
  const call = ["*deployerId", ...args].join(", ");
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`), stored, ret in {
  lookup!(\`${wrapperUri}\`, *stored) |
  for (@record <- stored) {
    match record {
      (_, caps) => {
        match caps.get(${q(verb)}) {
          Nil  => { return!(["no verb", ${q(verb)}]) }
          verb => { @verb!(*deployerId, ${q(verb)}${args.length ? ", " + args.join(", ") : ""}, *ret) | for (@a <- ret) { return!(a) } }
        }
      }
      _ => { return!(["no wrapper at", ${q(wrapperUri)}]) }
    }
  }
}`;
}

export const mintProgram      = (uri, amount, holder) => wrappedCall(uri, "mint", [int(amount), q(holder)]);
export const burnProgram      = (uri, amount, claimId) => wrappedCall(uri, "burn", [int(amount), q(claimId)]);
export const transferProgram  = (uri, to, amount) => wrappedCall(uri, "transfer", [q(to), int(amount)]);
export const releaseProgram   = (uri, claimId) => wrappedCall(uri, "release", [q(claimId)]);
export const balanceOfProgram = (uri, holder) => wrappedCall(uri, "balanceOf", [q(holder)]);
export const claimOfProgram   = (uri, claimId) => wrappedCall(uri, "claimOf", [q(claimId)]);
export const infoProgram      = (uri) => wrappedCall(uri, "info", []);

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/wrapped-token.js --selftest
// Shape only (balanced, verb names, arg order, ≥2 params, no quoted names,
// never revVault); live-node behaviour is a follow-up like locker.js.
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
  const VERBS = ["mint", "burn", "transfer", "release", "balanceOf", "claimOf", "info"];

  ok("contract template is balanced", balanced(WRAPPED_TOKEN_RHO));
  ok("no quoted name", !/@"[a-z]/.test(WRAPPED_TOKEN_RHO.replace(new RegExp(`@"(${VERBS.join("|")})"`, "g"), "")), "@\"…\"");
  ok("every verb dispatch keeps ≥2 params",
     [...WRAPPED_TOKEN_RHO.matchAll(/contract Wrapped\(([^)]*)\)/g)].every((m) => m[1].split(",").filter((x) => x.trim()).length >= 2),
     "@\"verb\" + ret, at least");
  const restores = (chVar, chName) =>
    [...WRAPPED_TOKEN_RHO.split("contract Wrapped(")].slice(1).every((blk) => {
      const consumes = new RegExp(`@${chVar} <- ${chName}`).test(blk);
      return !consumes || (blk.match(new RegExp(`${chName}!\\(`, "g")) || []).length >= 1;
    });
  ok("every `<- balsCh` block restores balsCh", restores("bals", "balsCh"));
  ok("every `<- claimsCh` block restores claimsCh", restores("claims", "claimsCh"));
  ok("every `<- supplyCh` block restores supplyCh", restores("supply", "supplyCh"));
  ok("the contract never mentions revVault", !/revVault|rho:rchain:revVault/.test(WRAPPED_TOKEN_RHO));
  ok("all seven verbs defined", VERBS.every((v) => WRAPPED_TOKEN_RHO.includes(`@"${v}"`)));
  ok("transfer self-identifies via rho:rev:address, never a caller-supplied address",
     /contract Wrapped\(_id, @"transfer"[\s\S]*?revAddr!\("fromDeployerId", \*_id/.test(WRAPPED_TOKEN_RHO));
  ok("transfer refuses to alias self as \"to\"", /myAddr == to/.test(WRAPPED_TOKEN_RHO));
  ok("issuer is bound at install, not a runtime arg", !/@"mint", @amount, @holder, @issuer/.test(WRAPPED_TOKEN_RHO));

  const inst = installWrappedProgram("1111backingAddr", "REV");
  ok("install is balanced", balanced(inst));
  ok("install has no template placeholders left", !/\bISSUER\b|\bBACKING_ADDR\b|\bBASE_CURRENCY\b|\bCAPS\b/.test(inst));
  ok("install binds issuer to *deployerId", inst.includes("*deployerId ==") || inst.includes("== *deployerId"));
  ok("install publishes via insertArbitrary", inst.includes("insertArbitrary!("));

  const mint = mintProgram(URI, 10, "1111holder");
  ok("mint carries amount, holder in order", /@verb!\(\*deployerId, "mint", 10, "1111holder", \*ret\)/.test(mint), mint.slice(-200));

  const burn = burnProgram(URI, 10, "claim1");
  ok("burn carries amount, claimId in order", /@verb!\(\*deployerId, "burn", 10, "claim1", \*ret\)/.test(burn));

  const transfer = transferProgram(URI, "1111holder", 10);
  ok("transfer carries to, amount in order", /@verb!\(\*deployerId, "transfer", "1111holder", 10, \*ret\)/.test(transfer), transfer.slice(-200));

  const release = releaseProgram(URI, "claim1");
  ok("release carries only claimId", /@verb!\(\*deployerId, "release", "claim1", \*ret\)/.test(release));

  const info = infoProgram(URI);
  ok("info carries no args", /@verb!\(\*deployerId, "info", \*ret\)/.test(info));

  ok("a non-integer amount is rejected",
     (() => { try { mintProgram(URI, "ten", "1111holder"); return false; } catch { return true; } })());

  const nasty = mintProgram(URI, 5, 'x", *evil) | @"stolen"!("');
  ok("a hostile holder id stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv?.includes("--selftest") &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(selftest() ? 0 : 1);
}
