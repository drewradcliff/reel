# reel

Polls a Letterboxd watchlist every 30 minutes and stores the latest snapshot in
`.reel/watchlist.json`. Every poll reconciles the current watchlist with Radarr,
adding any movies that are not already present and correcting existing
watchlist movies to the configured 4K quality profile. The snapshot is used to
report newly added and removed watchlist movies. Removed movies are logged but
are not removed from Radarr.

Radarr additions are monitored, searched immediately, use the `released`
minimum availability setting, and use the configured 4K quality profile.

## Run

Create `.env` from `.env.example` and set the Radarr API key from
**Settings > General > Security**:

```sh
cp .env.example .env
pnpm start
```

Configuration values can also be supplied as environment variables, which take
priority over `.env`:

- `LETTERBOXD_WATCHLIST_URL` is required.
- `RADARR_URL` defaults to `http://localhost:7878`.
- `RADARR_API_KEY` is required to reconcile the watchlist with Radarr.
- `RADARR_QUALITY_PROFILE` defaults to `Ultra-HD`. It must match a Radarr
  quality profile that only allows 2160p qualities.

The first configured Radarr root folder is used when adding a movie.
