# reel

Syncs a Letterboxd watchlist to Radarr.

Watchlist stored in `.reel/watchlist.json`.

## Setup

```sh
pnpm install
cp .env.example .env
pnpm start
```

Set these values in `.env` or the environment:

- `LETTERBOXD_WATCHLIST_URL`: required
- `RADARR_API_KEY`: required; found in **Settings > General > Security**
- `RADARR_URL`: defaults to `http://localhost:7878`
- `RADARR_QUALITY_PROFILE`: defaults to `Ultra-HD`

The quality profile must exist in Radarr. 

