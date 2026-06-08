import { Effect, FileSystem, Option, Schema } from "effect";

import type { FilmWithTmdbId } from "./film.ts";

import { FilmWithTmdbId as FilmWithTmdbIdSchema } from "./film.ts";

const stateDirectory = ".reel";
export const statePath = `${stateDirectory}/watchlist.json`;
const temporaryStatePath = `${statePath}.tmp`;

const WatchlistState = Schema.Struct({
  films: Schema.Array(FilmWithTmdbIdSchema),
});
type WatchlistState = typeof WatchlistState.Type;

export const readWatchlistState = Effect.fn("readWatchlistState")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  if (!(yield* fileSystem.exists(statePath))) {
    return Option.none<WatchlistState>();
  }

  const contents = yield* fileSystem.readFileString(statePath);
  const state = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(WatchlistState),
  )(contents);

  return Option.some(state);
});

export const writeWatchlistState = Effect.fn("writeWatchlistState")(function* (
  state: WatchlistState,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(WatchlistState)(state);

  yield* fileSystem.makeDirectory(stateDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    temporaryStatePath,
    `${JSON.stringify(encoded, null, 2)}\n`,
  );
  yield* fileSystem.rename(temporaryStatePath, statePath);
});

const indexByTmdbId = (films: ReadonlyArray<FilmWithTmdbId>) => {
  const index = new Map<number, FilmWithTmdbId>();

  for (const film of films) {
    index.set(film.tmdbId, film);
  }

  return index;
};

export const diffWatchlists = (
  previous: WatchlistState,
  currentFilms: ReadonlyArray<FilmWithTmdbId>,
) => {
  const previousById = indexByTmdbId(previous.films);
  const currentById = indexByTmdbId(currentFilms);

  return {
    added: currentFilms.filter((film) => !previousById.has(film.tmdbId)),
    removed: previous.films.filter((film) => !currentById.has(film.tmdbId)),
  };
};
