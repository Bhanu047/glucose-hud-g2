# Glucose HUD for Even G2

Glanceable CGM glucose on Even Realities G2 glasses — for yourself or the people you care for.

![states](shots/contact-sheet-v2.png)

- **Any CGM:** FreeStyle Libre (via LibreLinkUp), Dexcom (via Share), or **Nightscout** (any sensor, including DIY-loop setups)
- **Predicted lows:** projects the last 20 minutes forward and warns *before* you cross your low line — `▼ LOW in ~18 min`
- **Caregiver mode:** follow several people (a child, a partner, a parent) and swipe between them on the glasses or ring
- **3-hour chart** with your target range, plus **time in range**, average, min/max
- Big number, trend arrow, change per 5 min, reading age; LOW / HIGH / URGENT / STALE states; mg/dL or mmol/L; your own thresholds
- **Demo mode:** tap "Try demo" to see everything on your glasses without a sensor or account
- Tap to refresh, swipe to switch person, double-tap to exit

**Not a medical device.** For convenience only. Confirm with your meter or CGM app before treatment decisions.

## How it works

```
G2 glasses ⇄ Even app (phone, runs this plugin) → relay (Cloudflare Worker) → Nightscout / LibreLinkUp / Dexcom Share
```

| File | Role |
|---|---|
| `src/glucose.ts` | Units, trends, ranges, time-in-range stats, linear prediction (pure, unit-tested) |
| `src/sources.ts` | People/profiles and the three data sources; session reuse so credentials only travel on login |
| `src/settings.ts` | Storage in the Even app; migrates v0.1 settings |
| `src/render.ts` | Canvas → PNG for the big number and the 3 h chart (on/off pixels only; grey levels aren't reliable) |
| `src/hud.ts` | 576×288 layout: 2 image + 3 text containers, in-place updates, full rebuild on foreground |
| `src/phone-ui.ts`, `index.html` | Phone settings: people list/editor, display settings, live preview |
| `relay/worker.js` | Stateless relay. `/entries` (Nightscout), `/libre`, `/dexcom`. Credentials only in POST bodies, never logged; returns session tokens to the phone |
| `scripts/dev-relay.mjs` | Runs the relay locally with fake LibreLinkUp/Dexcom servers |
| `mock/` | Fake Nightscout and a realistic synthetic CGM curve |

### Why a relay
Even Hub plugins can only reach origins whitelisted in `app.json` (no wildcards), every Nightscout site has a different host, and LibreLinkUp/Dexcom don't send CORS headers. The relay is one fixed origin that forwards requests. It keeps no state: LibreLinkUp tokens and Dexcom session IDs are returned to the phone and sent back on the next poll, so passwords are only transmitted when a fresh login is needed.

LibreLinkUp notes (state Nov 2026): client `version` ≥ 4.16.0, `product: llu.android`, and an `account-id` header = SHA-256 of the user id are required; region redirects are followed once.

## Develop

```bash
npm install
node mock/nightscout.mjs        # fake Nightscout :1337 (/normal /falling /low /uhigh /flat /stale)
node scripts/dev-relay.mjs      # relay :8787 with fake Libre (2 followers) + Dexcom; password "pw"
npm run dev                     # vite :5173
npm run simulate                # Even Hub simulator
```

Dev-only URL overrides skip the settings form, e.g.
`http://localhost:5173/?ns=http://localhost:1337/falling` or
`?relay=http://localhost:8787&src=libre&user=a@b.c&pass=pw`.

```bash
npm test                        # 28 tests: glucose logic, demo data, relay with stubbed upstreams
bash scripts/sim-shots.sh       # headless simulator screenshots of every state → shots/
```

## Ship

1. Deploy `relay/worker.js` to Cloudflare Workers (dashboard → Worker → Edit code → paste → Deploy, or `cd relay && npx wrangler deploy`).
2. Put the worker's origin in `app.json` → `permissions[0].whitelist` and in `PUBLIC_RELAY` (`src/settings.ts`).
3. `npm run build && npx evenhub pack app.json dist -o glucose-hud.ehpk --sdk-ver 0.0.10`
4. Upload in the [Even Hub developer console](https://hub.evenrealities.com/).

## Known limits

- Even Hub has no background or push API, so there are **no alerts while the plugin is closed**. It's a glance tool, not an alarm.
- LibreLinkUp's graph is 15-minute resolution, so Libre charts are coarser than Dexcom/Nightscout.
- Dexcom Share must be enabled with at least one follower.

## License

MIT
