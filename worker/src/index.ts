/**
 * TURN credential minter for No Man's Land online play.
 *
 * GET /ice -> JSON array of RTCIceServer (Cloudflare STUN + TURN with short-lived
 * credentials). The long-lived TURN key never leaves this Worker; browsers only
 * ever see credentials that expire after TTL_SECONDS.
 *
 * Secrets (wrangler secret put ...): TURN_KEY_ID, TURN_KEY_API_TOKEN
 * Vars (wrangler.toml): ALLOWED_ORIGINS, comma-separated
 */

interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
  ALLOWED_ORIGINS: string;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Long enough for any session; the game refetches well before this runs out. */
const TTL_SECONDS = 6 * 60 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    // Only the game's own pages may ask. (A script can fake Origin, so this keeps
    // casual use off your quota rather than being real security.)
    if (!allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403, null);
    const cors = origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(cors) });
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/ice') return json({ error: 'not found' }, 404, cors);

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!res.ok) return json({ error: `cloudflare ${res.status}` }, 502, cors);
    const { iceServers } = (await res.json()) as { iceServers: IceServer[] };

    // Browsers block port 53, and a TURN URL on it just times out; drop those.
    const cleaned = iceServers
      .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return json(cleaned, 200, cors, { 'Cache-Control': 'no-store' });
  },
};

function corsHeaders(origin: string | null): Record<string, string> {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' }
    : {};
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...extra },
  });
}
