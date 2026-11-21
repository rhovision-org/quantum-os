// #282: individual identity and resource-side revocable proxies.
// Group authority must not be inferred from a user UID or local roster (#103).
export const IDENTITY_OPS=["id_info","id_groups","id_cap","id_chmod","id_chown","proxy_create","proxy_set","proxy_use","group_action"] as const;
export type IdentityOp=typeof IDENTITY_OPS[number];
export const PROXY_ACTIONS=["stat","read","ls","mkdir","unlink","put","signal"] as const;
export type ProxyAction=typeof PROXY_ACTIONS[number];
export const MAX_PROXIES=256;
export interface AuthorityProxy {
  token:string;owner:string;ownerPid:string;targetHandle:string;holder:string;
  rights:number;ceiling:number;enabled:boolean;version:string;
}
export const isUid=(x:unknown):x is string=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
export const isProxyToken=(x:unknown):x is string=>typeof x==="string"&&/^proxy:[0-9a-f]{64}$/.test(x);
