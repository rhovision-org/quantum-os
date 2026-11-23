// attachments.ts — images, audio, video and files over the data channel.
//
// There is no server to upload to, so an attachment travels the way everything
// else does: chunked over the WebRTC data channel, broadcast to whoever is in
// the room. That decides the shape of the whole thing — the size cap, the
// chunking, and the pacing all exist because the channel is the transport
// rather than a convenience in front of one.
//
// Base64 rather than binary frames, because the envelopes are JSON and a chunk
// has to survive being a string. That costs a third in size, which the cap
// already accounts for.
//
// Like calls.ts, this reaches app.ts through a host interface rather than
// importing it: the peer is asked for, not held, because which peer is current
// changes as the user switches room tabs.

import type { QOSPeer } from "./peer.js";

export type MediaKind = "image" | "audio" | "video" | "file";

export interface MediaAttachment {
  mediaKind: MediaKind;
  name: string;
  mime: string;
  size: number;
  /** A data: url. Stripped when the transcript is persisted — see renderMedia. */
  url: string;
}

/** 8 MB per attachment. The channel is the transport; this is what it will carry. */
export const FILE_MAX = 8 * 1024 * 1024;
/** Base64 chars per data-channel message. */
const FILE_CHUNK = 16 * 1024;

export interface AttachmentHost {
  /** The active room's peer, or null when not connected. */
  peer(): QOSPeer | null;
  /** Put a line in the transcript. */
  say(text: string): void;
  /** Display name for a peer id. */
  label(peerId: string): string;
  /** Put an attachment in the transcript, which is app.ts's chat log to keep. */
  addMedia(from: string, media: MediaAttachment, kind: "peer" | "self", label?: string): void;
}

export interface Attachments {
  /** Send each file to the room. */
  send(files: FileList | File[]): void;
  /** Inbound `file-start`. */
  fileStart(d: Record<string, unknown>): void;
  /** Inbound `file-chunk`; completes the transfer when the last one lands. */
  fileChunk(from: string, d: Record<string, unknown>): void;
}

export function fmtSize(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** What to render this as. The mime type first, the extension when it is silent. */
export function mediaKindOf(mime: string, name: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "opus", "aac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  return "file";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const STEP = 0x8000;   // apply() has an argument limit; stay well under it
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/**
 * Draw an attachment into a chat line.
 *
 * Pure DOM, so it belongs here rather than with the chat renderer: what an
 * attachment looks like is a property of the attachment.
 */
export function renderMedia(host: HTMLElement, m: MediaAttachment): void {
  if (!m.url) {   // persisted placeholder — the data url was stripped on save
    const span = document.createElement("span");
    span.className = "media-file";
    span.textContent = `📎 ${m.name} (${fmtSize(m.size)})`;
    host.appendChild(span);
    return;
  }
  if (m.mediaKind === "image") {
    const img = document.createElement("img");
    img.className = "media-img"; img.src = m.url; img.alt = m.name; img.loading = "lazy";
    img.title = `${m.name} (${fmtSize(m.size)}) — click to open`;
    img.addEventListener("click", () => window.open(m.url, "_blank", "noopener"));
    host.appendChild(img);
  } else if (m.mediaKind === "audio") {
    const a = document.createElement("audio"); a.controls = true; a.src = m.url; a.preload = "metadata";
    host.appendChild(a);
  } else if (m.mediaKind === "video") {
    const v = document.createElement("video"); v.className = "media-vid"; v.controls = true; v.src = m.url; v.preload = "metadata";
    host.appendChild(v);
  } else {
    const a = document.createElement("a");
    a.className = "media-file"; a.href = m.url; a.download = m.name;
    a.textContent = `📎 ${m.name} (${fmtSize(m.size)})`;
    host.appendChild(a);
  }
}

/** Inbound reassembly: transfer id → what has arrived so far. */
interface IncomingFile {
  name: string; mime: string; size: number; mediaKind: MediaKind;
  total: number; chunks: string[]; got: number;
}

export function createAttachments(host: AttachmentHost): Attachments {
  const incoming = new Map<string, IncomingFile>();
  let seq = 0;

  /** Wait until the channel's send buffers drain below ~1 MB. */
  function paceSend(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const peer = host.peer();
        if (!peer || peer.maxBufferedAmount() < (1 << 20)) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
  }

  async function sendOne(file: File): Promise<void> {
    const peer = host.peer();
    if (!peer) { host.say("connect to a room before sending attachments"); return; }
    if (file.size > FILE_MAX) {
      host.say(`⚠ "${file.name}" is ${fmtSize(file.size)} — over the ${fmtSize(FILE_MAX)} attachment limit`);
      return;
    }
    const b64 = arrayBufferToBase64(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    const mediaKind = mediaKindOf(file.type, file.name);
    const id = `${peer.peerId.slice(-6)}-${Date.now()}-${seq++}`;
    const total = Math.ceil(b64.length / FILE_CHUNK);
    // Bulk: the WebRTC overlay, never the relay (see peer.ts SendOptions).
    peer.broadcast({ kind: "file-start", id, name: file.name, mime, size: file.size, total, mediaKind }, { bulk: true });
    for (let i = 0; i < total; i++) {
      peer.broadcast({ kind: "file-chunk", id, seq: i, data: b64.slice(i * FILE_CHUNK, (i + 1) * FILE_CHUNK) }, { bulk: true });
      // Every 32 chunks, let the buffers catch up rather than outrunning them.
      if ((i & 31) === 31) await paceSend();
    }
    host.addMedia("", { mediaKind, name: file.name, mime, size: file.size, url: `data:${mime};base64,${b64}` }, "self");
  }

  return {
    send(files) { for (const f of Array.from(files)) void sendOne(f); },

    fileStart(d) {
      // Nothing here is trusted: a sender that claims a size or a chunk count
      // the cap does not allow is refused rather than allocated for.
      const id = String(d.id ?? "");
      const size = Number(d.size ?? 0);
      const total = Number(d.total ?? 0);
      if (!id || size > FILE_MAX || total <= 0 || total > Math.ceil(FILE_MAX / FILE_CHUNK) + 2) return;
      incoming.set(id, {
        name: String(d.name ?? "file"),
        mime: String(d.mime ?? "application/octet-stream"),
        size,
        mediaKind: (d.mediaKind as MediaKind) ?? "file",
        total,
        chunks: new Array(total).fill(""),
        got: 0,
      });
    },

    fileChunk(from, d) {
      const id = String(d.id ?? "");
      const f = incoming.get(id);
      if (!f) return;
      const seqNo = Number(d.seq ?? -1);
      // Out of range, or already filled: a repeat must not double-count `got`.
      if (seqNo < 0 || seqNo >= f.total || f.chunks[seqNo] !== "") return;
      f.chunks[seqNo] = String(d.data ?? "");
      f.got++;
      if (f.got < f.total) return;
      incoming.delete(id);
      host.addMedia(from,
        { mediaKind: f.mediaKind, name: f.name, mime: f.mime, size: f.size,
          url: `data:${f.mime};base64,${f.chunks.join("")}` },
        "peer", host.label(from));
    },
  };
}
