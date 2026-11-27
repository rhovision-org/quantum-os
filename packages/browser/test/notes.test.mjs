import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const dir=fileURLToPath(new URL('../src/',import.meta.url));
const bundle=await build({stdin:{contents:'export * from "./notes.ts"; export { validateCapability } from "./zfa.ts";',resolveDir:dir,sourcefile:'notes-witness.ts'},bundle:true,format:'esm',platform:'node',external:['@quantum-os/zfa-core'],write:false});
const m=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const cap=h=>'cap:note-TESTA:'+h;
assert.equal(m.validateCapability(cap('45676103')),false,'captured rejected child');
assert.equal(m.splitNote(cap('45676103072725212567'),4),null,'captured invalid parent refused');
assert.equal(m.validateCapability(cap('0303')),true,'legacy aggregate-only closure');
assert.equal(m.splitNote(cap('0303'),1),null,'legacy unpartitionable input retained');
assert.equal(m.splitNote(cap('0101'),1),null,'identical child identities refused');
assert.equal(m.mergeNotes(cap('01'),cap('01')),null,'same token not merged twice');
assert.equal(m.splitNote(cap('0123')+':junk',1),null);
assert.equal(m.splitNote(cap('0123'),0.5),null);
assert.deepEqual(m.splitNote(cap('01234567'),2),[cap('0123'),cap('4567')]);
assert.equal(m.mergeNotes(cap('0123'),cap('4567')),cap('01234567'));
let checked=0;
for(let n=1;n<=64;n++){
 for(let j=0;j<32;j++){
  for(const t of [m.mintNote('TESTA',n),m.mintNoteSeries('TESTA','deadbeef',n),m.mintReceipt('TESTA',n)]){
   assert.equal(m.denomination(t),n);
   assert.ok(m.validateCapability(t),'mint must satisfy unchanged deployed verifier');
   checked++;
  }
  const t=m.mintNote('TESTA',n);
  for(let a=1;a<n;a++){
   const pair=m.splitNote(t,a);
   if(!pair){assert.equal(t.split(':')[2].slice(0,2*a),t.split(':')[2].slice(2*a),'only identical children may refuse a new note');continue;}
   assert.ok(pair.every(m.validateCapability));
   assert.equal(m.denomination(pair[0]),a);
   assert.equal(m.denomination(pair[1]),n-a);
   assert.equal(pair[0].split(':')[2]+pair[1].split(':')[2],t.split(':')[2]);
   checked++;
  }
 }
}
console.log('PASS note closure/split regression; validated cases='+checked+' (TS fallback; WASM build separately)');
