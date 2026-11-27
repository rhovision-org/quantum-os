// #283: deterministic device ABI. No host APIs in this module.
export const DEVICE_OPS=["dev_define","dev_grant","dev_open","dev_close","dev_list","dev_request","dev_observe"] as const;
export type DeviceOp=typeof DEVICE_OPS[number];
export const DEVICE_KINDS=["opfs-block","zfa","rholo-status","data-channel","media-track","mesh-socket"] as const;
export type DeviceKind=typeof DEVICE_KINDS[number];
export const DEVICE_MAX_BYTES=4096;
export const DEVICE_MAX_REQUESTS=1024;
export const DEVICE_MAX_DESCRIPTORS=128;
export type DeviceDescriptor={id:string;kind:DeviceKind;owner:string;rights:number};
export type DeviceRequest={action:"read";limit:number}|{action:"write";hex:string}|{action:"ioctl";code:"status"|"zfa";hex:string};
export type DeviceObservation={ok:true;hex:string;count:number;timestamp:string|null}|{ok:false;errno:"EIO"|"EACCES"|"EAGAIN"|"ENOTSUP"|"EINVAL"|"EINTR";effect:"none"|"unknown"};
export type DeviceTicket={id:string;pid:string;handle:string;handleVersion:string;device:string;request:DeviceRequest;version:string;observation:DeviceObservation|null};
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export const deviceHex=(x:unknown):x is string=>typeof x==="string"&&x.length<=DEVICE_MAX_BYTES*2&&/^(?:[0-9a-f]{2})*$/.test(x);
export function deviceRequest(x:unknown,kind?:DeviceKind):DeviceRequest|null{
 if(!x||typeof x!=="object"||Array.isArray(x))return null;
 const a=x as Record<string,unknown>;
 if(a.action==="read"){
  if(!exact(x,["action","limit"])||typeof a.limit!=="number"||!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>DEVICE_MAX_BYTES||kind==="zfa")return null;
 }else if(a.action==="write"){
  if(!exact(x,["action","hex"])||!deviceHex(a.hex)||(kind!==undefined&&!["opfs-block","data-channel","mesh-socket"].includes(kind)))return null;
 }else if(a.action==="ioctl"){
  if(!exact(x,["action","code","hex"])||!deviceHex(a.hex))return null;
  if(a.code==="status"){if(a.hex!=="")return null;}
  else if(a.code==="zfa"){if(kind!==undefined&&kind!=="zfa"||!a.hex||a.hex.length>512||!/^0[0-7](?:0[0-7])*$/.test(a.hex))return null;}
  else return null;
 }else return null;
 return JSON.parse(JSON.stringify(x)) as DeviceRequest;
}
export function deviceRight(r:DeviceRequest):number{return r.action==="write"?2:r.action==="ioctl"&&r.code==="zfa"?4:1;}
export function deviceRights(k:DeviceKind){return k==="zfa"?5:["opfs-block","data-channel","mesh-socket"].includes(k)?3:1;}
export function deviceObservation(x:unknown,r:DeviceRequest):DeviceObservation|null{
 if(!x||typeof x!=="object"||Array.isArray(x))return null;
 const a=x as Record<string,unknown>;
 if(a.ok===false){
  if(!exact(x,["ok","errno","effect"])||!["EIO","EACCES","EAGAIN","ENOTSUP","EINVAL","EINTR"].includes(a.errno as string)||!["none","unknown"].includes(a.effect as string))return null;
 }else{
  if(a.ok!==true||!exact(x,["ok","hex","count","timestamp"])||!deviceHex(a.hex)||typeof a.count!=="number"||!Number.isSafeInteger(a.count)||a.count<0||
   !(a.timestamp===null||typeof a.timestamp==="string"&&a.timestamp.length<=128&&!/[\u0000-\u001f]/.test(a.timestamp)))return null;
  if(r.action==="write"){if(a.hex!==""||a.count>r.hex.length/2)return null;}
  else if(a.count!==a.hex.length/2||r.action==="read"&&a.count>r.limit)return null;
 }
 return JSON.parse(JSON.stringify(x)) as DeviceObservation;
}
