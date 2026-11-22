// A finite cross-validator observation, not a universal consensus proof.
import assert from "node:assert/strict";
export function lightBlock(value) {
  const b=value?.blockInfo ?? value;
  if (!b || !/^[a-f0-9]{64}$/i.test(b.blockHash ?? "") ||
      !Number.isSafeInteger(b.blockNumber) || b.blockNumber<0 ||
      !/^[a-f0-9]{64}$/i.test(b.postStateHash ?? ""))
    throw new Error("invalid BlockInfo identity");
  return {hash:b.blockHash,height:b.blockNumber,postStateHash:b.postStateHash};
}
export function witness(rows,anchor,expectedDigest,count=4) {
  if(!Array.isArray(rows)||rows.length!==count||
     new Set(rows.map(r=>r.node)).size!==count||
     new Set(rows.map(r=>r.identity)).size!==count||
     rows.some(r=>!r.identity || r.network!=="omega-g4-isolated" ||
       r.healthy!==true || r.finalized!==true || r.anchor?.hash!==anchor.hash ||
       r.anchor?.height!==anchor.height || r.anchor?.postStateHash!==anchor.postStateHash ||
       r.head?.height<anchor.height || !r.head ||
       r.snapshotDigest!==expectedDigest || r.nativeWinner!=="approve"))
    return false;
  return true;
}
if(process.argv.includes("--selftest")){
  const h="a".repeat(64),p="b".repeat(64), d="c".repeat(64);
  const a=lightBlock({blockInfo:{blockHash:h,blockNumber:5,postStateHash:p}});
  const row=i=>({node:i,identity:"peer"+i,network:"omega-g4-isolated",healthy:true,finalized:true,anchor:a,head:{...a,height:7},snapshotDigest:d,nativeWinner:"approve"});
  const all=[0,1,2,3].map(row);
  assert(witness(all,a,d));
  for(const change of [
    {finalized:false},{finalized:"true"},{identity:"peer0"},{healthy:false},
    {network:"testnet"},{snapshotDigest:"wrong"},{nativeWinner:"reject"},
    {anchor:{...a,postStateHash:h}},{head:{...a,height:4}}
  ]) assert(!witness([...all.slice(0,3),{...all[3],...change}],a,d));
  assert(!witness(all.slice(0,3),a,d));
  assert.throws(()=>lightBlock({blockHash:h,blockNumber:5}));
  console.log("PASS strict finalized envelope and 10 negative witness controls");
}
