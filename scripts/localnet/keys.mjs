#!/usr/bin/env node
// keys.mjs — REV addresses for a local node's genesis.
//
//   node keys.mjs                 → the address of every key in pk.txt
//   node keys.mjs --generate      → a fresh key, printed (nothing written)
//   node keys.mjs --wallet 1000000000000 > wallet.txt
//                                 → a genesis wallets file funding pk.txt's keys
//
// A REV address is derived from the public key the way the node derives it
// (rholang/src/util/rev_address.rs), because a wallets file that funds an
// address nobody holds a key for funds nobody:
//
//   eth     = last 20 bytes of keccak256(pubkey without its 0x04 prefix)
//   payload = 00000000 ++ keccak256(eth)
//   address = base58(payload ++ first 4 bytes of blake2b256(payload))
//
// Verified against rholo's own devnet key, which derives to the address
// its devnet.sh publishes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HERE = dirname(fileURLToPath(import.meta.url));

const unhex = (s) => new Uint8Array((s.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = ALPHABET[0] + out; }
  return out;
}

export function publicKeyOf(secretHex) {
  return hex(secp256k1.getPublicKey(unhex(secretHex), false));
}

export function revAddressOf(secretHex) {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  const eth = hex(keccak_256(pub.slice(1))).slice(-40);
  const payload = new Uint8Array([0, 0, 0, 0, ...keccak_256(unhex(eth))]);
  const checksum = blake2b(payload, { dkLen: 32 }).slice(0, 4);
  return base58(new Uint8Array([...payload, ...checksum]));
}

/** Every `name=hexkey` line in pk.txt, comments and blanks skipped. */
export function readKeys(path = join(HERE, "pk.txt")) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, key] = l.split("=");
      return { name: name.trim(), key: (key ?? "").trim() };
    })
    .filter((k) => k.key);
}

if (process.argv[1] && process.argv[1].endsWith("keys.mjs")) {
  const args = process.argv.slice(2);
  if (args.includes("--generate")) {
    const k = hex(secp256k1.utils.randomSecretKey());
    console.log(`private ${k}`);
    console.log(`public  ${publicKeyOf(k)}`);
    console.log(`address ${revAddressOf(k)}`);
  } else if (args.includes("--wallet")) {
    const balance = args[args.indexOf("--wallet") + 1] ?? "1000000000000";
    for (const { key } of readKeys()) console.log(`${revAddressOf(key)},${balance}`);
  } else {
    for (const { name, key } of readKeys()) {
      console.log(`${name.padEnd(10)} ${revAddressOf(key)}`);
      console.log(`${"".padEnd(10)} public ${publicKeyOf(key)}`);
    }
  }
}
