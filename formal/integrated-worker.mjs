// Local fixture worker reads disposable keys via stdin, never argv or logs.
import {readFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {createIdentityContext} from './authority-identity.mjs';
import {integrationContext,submitIntegrated} from './authority-integrated.mjs';
const f=JSON.parse(readFileSync(0,'utf8'));
const identity=createIdentityContext(f.stream,f.registry.map(({actor,pem})=>({actor,publicKey:createPublicKey(pem)})));
const writer=createPrivateKey(f.writer);
const ctx=integrationContext(identity,createPublicKey(writer));
const r=submitIntegrated(f.db,ctx,writer,f.envelope,stage=>{if(stage===f.crash)process.kill(process.pid,'SIGKILL');});
console.log(JSON.stringify(r));
