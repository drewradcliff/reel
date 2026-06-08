import { Effect, Option } from "effect";

import { fetchWatchlist } from "./letterboxd.ts";
import { syncWatchlistToRadarr } from "./radarr.ts";
import {
  diffWatchlists,
  readWatchlistState,
  statePath,
  writeWatchlistState,
} from "./watchlist-state.ts";

export const pollWatchlist = Effect.fn("pollWatchlist")(function* () {
  const films = yield* fetchWatchlist();
  const previousState = yield* readWatchlistState();
  const changes = Option.match(previousState, {
    onNone: () => ({ added: films, removed: [] }),
    onSome: (state) => diffWatchlists(state, films),
  });

  yield* Effect.logInfo("Polled Letterboxd watchlist", {
    count: films.length,
    added: changes.added.length,
    removed: changes.removed.length,
    ...(changes.added.length > 0
      ? { addedTitles: changes.added.map((film) => film.title) }
      : {}),
    ...(changes.removed.length > 0
      ? { removedTitles: changes.removed.map((film) => film.title) }
      : {}),
  });
  yield* syncWatchlistToRadarr(films);
  yield* writeWatchlistState({ films });

  if (Option.isNone(previousState)) {
    yield* Effect.logInfo("Initialized Letterboxd watchlist state", {
      count: films.length,
      statePath,
    });
  }
});
