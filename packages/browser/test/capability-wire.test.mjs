// Same synthetic wire fixtures through actual built WASM and pure TS fallback.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/zfa.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false,external:['@quantum-os/zfa-core']});
const fallback=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const wasm=await import('../../zfa-core-wasm/zfa_core.js');
await wasm.default({module_or_path:await readFile(new URL('../../zfa-core-wasm/zfa_core_bg.wasm',import.meta.url))});
const fixtures=[['cap:test:67',true],['cap:test:01',true],['cap:test:0033',true],['cap:test:03',false],['cap:test:',false],['cap:test:6x7',false],['cap:test:6789',false],['cap:test:67:extra',false],['bad:test:67',false],['cap:test: 67',false],['cap:test:67\n',false]];
for(const [token,want] of fixtures){assert.equal(fallback.validateCapability(token),want,`TS ${JSON.stringify(token)}`);assert.equal(wasm.wasm_capability_valid(token),want,`WASM ${JSON.stringify(token)}`);}
console.log(`PASS: ${fixtures.length} synthetic capability wire fixtures in WASM and TS fallback; not authorization proof`);
