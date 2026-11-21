import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// The #601 harness can reuse an existing Rholo HTTP API without changing the
// browser's mixed-content and CORS safety model. The harness binds Vite to
// loopback and rejects insecure non-loopback node URLs.
const rnodeProxyTarget = process.env.QOS_RNODE_PROXY_TARGET ?? "http://127.0.0.1:40403";

// The version the app reports about itself. Read from package.json at build
// time so there is one place it is written down, and it cannot drift from what
// was actually shipped.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Which build this actually is. `version` moves when someone remembers to move
// it; a commit does not, and "are you on the new build?" has been the first
// question of every peer-connection puzzle. Falls back to a timestamp where
// there is no git (a deploy from a tarball).
const build = (() => {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return new Date().toISOString().slice(0, 16).replace("T", " "); }
})();

// The app derives every identity from SHA-256 via Web Crypto, which browsers
// expose only in a secure context. http://localhost is one; http://<lan-ip> is
// not — so a dev server reached from anywhere but this machine's loopback (a
// ChromeOS browser talking to the Linux VM, a phone on the same network) fails
// to start at all, with "Web Crypto is unavailable".
//
// basic-ssl generates a self-signed cert on first run and caches it outside the
// repo: no per-developer setup, no key committed, nothing to rotate.
//
// Chrome will still show its "not private" interstitial, and no SAN tinkering
// avoids it — the cert is signed by nobody the browser trusts, and matching the
// IP would need an iPAddress SAN, which this plugin cannot emit (it writes
// every name as dNSName, which Chrome ignores for an IP URL). Click through
// once per origin. What Web Crypto is gated on is a secure context, and
// bypassing the interstitial grants one; the app starts normally after that.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD__: JSON.stringify(build),
  },
  plugins: [basicSsl({ name: "quantum-os-dev" })],
  base: "/quantum-os/",   // GitHub Pages repo subpath
  build: {
    outDir: "dist",
    target: "es2022",
  },
  optimizeDeps: {
    exclude: ["@quantum-os/zfa-core"],  // WASM module — don't pre-bundle
  },
  server: {
    port: 5173,
    // Proxy the local signaling server onto this origin as /signal.
    //
    // The page is https, and a browser refuses a ws:// connection from an https
    // page as mixed content — so a local signaling server would otherwise need a
    // certificate of its own, and a second interstitial to click through. Coming
    // through here it is wss:// on the origin the page already loaded from, on
    // the cert already accepted.
    //
    // Point the browser at it with:  /signal wss://<this-host>:5173/signal
    // Agents run in Node, which has no mixed-content rule, so they connect to
    // ws://127.0.0.1:4444 directly and skip the proxy.
    proxy: {
      "/signal": { target: "ws://127.0.0.1:4444", ws: true, changeOrigin: true },
      // And rnode, for the same reason. The page is https; the node speaks
      // plain http, and a browser refuses http to any host but loopback — where
      // "loopback" means the machine the BROWSER runs on. On a Chromebook that
      // is ChromeOS, while the node is inside the Linux VM, so 127.0.0.1 finds
      // nothing and the VM's own address is blocked as mixed content.
      //
      // Coming through here it is https on the origin the page already loaded
      // from, on the cert already accepted:  /rholang rnode https://<host>:5173/rnode
      "/rnode": {
        target: rnodeProxyTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rnode/, ""),
      },
    },
    // Listen on every interface: the point of the cert is to be reachable from
    // somewhere that is not this machine's loopback.
    host: true,
  },
});
