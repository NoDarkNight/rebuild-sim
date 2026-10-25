# TURN credential Worker

A tiny Cloudflare Worker that lets players on different networks connect for online play. It keeps your Cloudflare TURN key secret and hands browsers short-lived (6 hour) relay credentials at `GET /ice`. Only the pages listed in `ALLOWED_ORIGINS` (`wrangler.toml`) may ask.

## One-time setup

1. **Create a TURN key.** In the Cloudflare dashboard, open **Realtime > TURN** and create a key. Copy its **Key ID** and **API token**; the token is shown only once.

2. **Deploy the Worker.** From this folder:

   ```bash
   npx wrangler login
   ```

   ```bash
   npx wrangler secret put TURN_KEY_ID
   ```

   ```bash
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

   ```bash
   npx wrangler deploy
   ```

   The deploy prints the Worker's address, for example `https://nml-turn.<your-subdomain>.workers.dev`.

3. **Check it.** This should print a JSON list containing `turn:` URLs with a username and credential:

   ```bash
   curl -H "Origin: https://nodarknight.github.io" https://nml-turn.<your-subdomain>.workers.dev/ice
   ```

4. **Point the site at it.** Save the address plus `/ice` as the `TURN_CREDENTIALS_URL` repository secret, then redeploy the site:

   ```bash
   gh secret set TURN_CREDENTIALS_URL --repo NoDarkNight/rebuild-sim --body "https://nml-turn.<your-subdomain>.workers.dev/ice"
   ```

   ```bash
   gh workflow run deploy.yml --repo NoDarkNight/rebuild-sim
   ```

For local testing, put `VITE_TURN_CREDENTIALS_URL=<same URL>` in `.env.local` at the repo root and restart `npm run dev`.

## Notes

- **Cost:** Cloudflare's TURN has a free monthly allowance, about 1,000 GB at the time of writing, and charges per GB beyond it. A relayed joiner uses about 170 MB per hour, and only players who can't connect directly use the relay. Consider a billing alert in the Cloudflare dashboard.
- **Origin check:** the `Origin` check keeps casual use off your quota, but a script can fake that header. If abuse ever shows up, rotate the TURN key; credentials it already issued expire within 6 hours.
- **Port 53:** the Worker drops TURN URLs on port 53, which browsers block and would only time out on.
- **More sites:** to allow another site, such as a custom domain or a different local port, add it to `ALLOWED_ORIGINS` and run `npx wrangler deploy` again.
