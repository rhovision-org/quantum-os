// Runtime compatibility witness, not a statistical entropy certification.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as cli from '../../../scripts/qos-cli/zfa.mjs';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/zfa.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false,external:['@quantum-os/zfa-core']});
const ts=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const wasm=await import('../../zfa-core-wasm/zfa_core.js');
await wasm.default({module_or_path:await readFile(new URL('../../zfa-core-wasm/zfa_core_bg.wasm',import.meta.url))});
const generators=[['TS',ts.generateCapabilityV2Candidate],['CLI',cli.generateCapabilityV2Candidate],['WASM',wasm.wasm_capability_v2_candidate]];
const validators=[ts.validateCapability,cli.validateCapability,wasm.wasm_capability_valid];
for(const [name,generate] of generators){
  for(let i=0;i<32;i++){
    const token=generate('fixture');const digits=token.split(':')[2];
    assert.equal(digits.length,68,name);
    assert.match(digits,/^(?:[0246][1357]){34}$/);
    for(const check of validators)assert.equal(check(token),true,name);
  }
}
for(const generate of [ts.generateCapability,cli.generateCapability]){
  const token=generate('fixture');assert.equal(token.split(':')[2].length,32);
  for(const check of validators)assert.equal(check(token),true);
}
console.log('PASS: 96 candidate samples across three runtimes, legacy issuance shape preserved; no entropy inference from samples');
