import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('../target/mre-wasm/mre_core.js');
const vectors = JSON.parse(readFileSync('crates/mre-core/tests/qlf_vectors.json', 'utf8')).vectors;
assert.equal(vectors.length, 12);
for (const v of vectors) {
  const out = JSON.parse(wasm.mre_profile_a_json(v.prior, v.p_E_given_H, v.p_E_given_notH));
  assert.equal(out.evidence, v.evidence, v.name + ' evidence');
  assert.equal(out.posteriorGivenE, v.posterior_given_E, v.name + ' E');
  assert.equal(out.posteriorGivenNotE, v.posterior_given_notE, v.name + ' not E');
}
assert.throws(() => wasm.mre_profile_a_json('0','1','1'));
console.log('Actual WASM Profile A QLF conformance: 12/12 PASS');
