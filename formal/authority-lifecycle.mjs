// Research-only, serial reference reducer. Never imported by production.
// Actor IDs are supplied by a hypothetical trusted authenticator.
// State is internal trusted state, not an externally authenticated snapshot.
const validId = x => Number.isSafeInteger(x) && x >= 0;
const validMask = x => Number.isInteger(x) && x >= 0 && x < 64;
const GRANT = 8;
export function genesis() {
  return {grants:[{id:0,holder:0,process:7,mask:63,lineage:[0]}],revoked:[],seen:[]};
}
const deny = (state,reason) => ({accepted:false,reason,state});
const live = (state,g) => g.lineage.every(id=>!state.revoked.includes(id));
const find = (state,id) => state.grants.find(g=>g.id===id);
export function step(state,actor,command) {
  if (!validId(actor) || !command || !validId(command.request)) return deny(state,'malformed');
  if (state.seen.includes(command.request)) return deny(state,'replay');
  const accept = delta => ({accepted:true,reason:'accepted',state:{...state,...delta,seen:[...state.seen,command.request]}});
  if (command.kind==='revoke') {
    if(!validId(command.id)) return deny(state,'malformed');
    if(actor!==0) return deny(state,'owner-only');
    if(!find(state,command.id)) return deny(state,'unknown-grant');
    if(state.revoked.includes(command.id)) return deny(state,'already-revoked');
    return accept({revoked:[...state.revoked,command.id]});
  }
  if(command.kind!=='grant'&&command.kind!=='execute') return deny(state,'malformed');
  if(!validId(command.parent)||!validId(command.process)) return deny(state,'malformed');
  const parent=find(state,command.parent);
  if(!parent) return deny(state,'unknown-grant');
  if(parent.holder!==actor) return deny(state,'wrong-holder');
  if(!live(state,parent)) return deny(state,'revoked');
  if(parent.process!==command.process) return deny(state,'wrong-process');
  if(command.kind==='execute'){
    if(!Number.isInteger(command.right)||command.right<0||command.right>5) return deny(state,'malformed');
    if(!(parent.mask&(1<<command.right))) return deny(state,'missing-right');
    return accept({});
  }
  if(!validId(command.id)||!validId(command.target)||!validMask(command.mask)) return deny(state,'malformed');
  if(!(parent.mask&GRANT)) return deny(state,'missing-right');
  if(find(state,command.id)||state.revoked.includes(command.id)) return deny(state,'id-used');
  if((command.mask&parent.mask)!==command.mask) return deny(state,'amplification');
  return accept({grants:[...state.grants,{id:command.id,holder:command.target,process:command.process,mask:command.mask,lineage:[command.id,...parent.lineage]}]});
}
