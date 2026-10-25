import { CONFIG } from '../config';

/**
 * ICE servers for WebRTC. STUN (free, always on) lets two players connect directly
 * when their networks allow it. Many don't (mobile data, strict home routers,
 * different networks), and then a TURN relay is required. PeerJS's built-in
 * relays no longer exist, so a relay has to be supplied at build time:
 *
 *   VITE_TURN_CREDENTIALS_URL  GET returns a JSON array of RTCIceServer. This project's
 *                              Cloudflare Worker (worker/) serves exactly that at /ice.
 *   VITE_TURN_URLS             comma-separated turn:/turns: URLs, with
 *   VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL   static credentials
 *
 * Anything baked into the build ships to every player, so only use credentials
 * meant to be public (scoped API keys or quota-limited accounts).
 */

const env = import.meta.env;

let cached: Promise<RTCIceServer[]> | null = null;
let cachedAt = 0;
let relay = false;
/** Fetched TURN credentials are short-lived; get fresh ones well before they lapse. */
const REFRESH_MS = 60 * 60 * 1000;

/** True once a TURN relay has been configured and loaded. */
export const hasRelay = () => relay;

export function iceServers(): Promise<RTCIceServer[]> {
  if (!cached || Date.now() - cachedAt > REFRESH_MS) {
    cachedAt = Date.now();
    cached = load();
  }
  return cached;
}

async function load(): Promise<RTCIceServer[]> {
  relay = false;
  const servers: RTCIceServer[] = CONFIG.net.stunUrls.map((urls) => ({ urls }));
  const url = env.VITE_TURN_CREDENTIALS_URL as string | undefined;
  if (url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const turn = (await res.json()) as RTCIceServer[];
      if (Array.isArray(turn) && turn.length) { servers.push(...turn); relay = true; }
    } catch (err) {
      console.warn('Could not load TURN credentials; online play is direct-only.', err);
    }
  }
  const urls = (env.VITE_TURN_URLS as string | undefined)?.split(',').map((u) => u.trim()).filter(Boolean);
  if (urls?.length) {
    servers.push({ urls, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL });
    relay = true;
  }
  return servers;
}
