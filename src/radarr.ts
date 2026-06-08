import { Config, Data, Effect, Redacted, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { FilmWithTmdbId } from "./film.ts";

const RadarrMovieLookup = Schema.Struct({
  title: Schema.String,
  titleSlug: Schema.String,
  tmdbId: Schema.Number,
  year: Schema.Number,
});

const RadarrMovieFields = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  tmdbId: Schema.Number,
  qualityProfileId: Schema.Number,
});

const RadarrMovieResource = Schema.Record(Schema.String, Schema.Unknown);

const RadarrRootFolder = Schema.Struct({
  path: Schema.String,
});

const RadarrQualityProfile = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

interface RadarrAddConfiguration {
  readonly rootFolder: typeof RadarrRootFolder.Type;
  readonly qualityProfile: typeof RadarrQualityProfile.Type;
}

class RadarrConfigurationError extends Data.TaggedError(
  "RadarrConfigurationError",
)<{
  readonly message: string;
}> {}

const executeRadarrRequest = Effect.fn("executeRadarrRequest")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const radarrUrl = yield* Config.string("RADARR_URL").pipe(
    Config.withDefault("http://localhost:7878"),
  );
  const apiKey = yield* Config.redacted("RADARR_API_KEY");
  const client = yield* HttpClient.HttpClient;
  const url = new URL(request.url, radarrUrl);

  return yield* client
    .execute(
      request.pipe(
        HttpClientRequest.setUrl(url),
        HttpClientRequest.setHeader("X-Api-Key", Redacted.value(apiKey)),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

const getRadarrJson = <S extends Schema.Top>(path: string, schema: S) =>
  executeRadarrRequest(HttpClientRequest.get(path)).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  );

const updateMovieQualityProfile = Effect.fn("updateMovieQualityProfile")(
  function* (
    movie: {
      readonly fields: typeof RadarrMovieFields.Type;
      readonly resource: typeof RadarrMovieResource.Type;
    },
    qualityProfile: typeof RadarrQualityProfile.Type,
  ) {
    const updateRequest = yield* HttpClientRequest.put(
      `/api/v3/movie/${movie.fields.id}`,
    ).pipe(
      HttpClientRequest.bodyJson({
        ...movie.resource,
        qualityProfileId: qualityProfile.id,
      }),
    );
    const searchRequest = yield* HttpClientRequest.post("/api/v3/command").pipe(
      HttpClientRequest.bodyJson({
        name: "MoviesSearch",
        movieIds: [movie.fields.id],
      }),
    );

    yield* executeRadarrRequest(updateRequest);
    yield* executeRadarrRequest(searchRequest);
    yield* Effect.logInfo(
      `Updated Radarr quality profile: ${movie.fields.title} -> ${qualityProfile.name}`,
    );
  },
);

const addMovieToRadarr = Effect.fn("addMovieToRadarr")(function* (
  film: FilmWithTmdbId,
  configuration: RadarrAddConfiguration,
) {
  const movie = yield* getRadarrJson(
    `/api/v3/movie/lookup/tmdb?tmdbId=${film.tmdbId}`,
    RadarrMovieLookup,
  );
  const { qualityProfile, rootFolder } = configuration;

  const request = yield* HttpClientRequest.post("/api/v3/movie").pipe(
    HttpClientRequest.bodyJson({
      ...movie,
      qualityProfileId: qualityProfile.id,
      rootFolderPath: rootFolder.path,
      monitored: true,
      minimumAvailability: "released",
      addOptions: {
        searchForMovie: true,
      },
    }),
  );

  yield* executeRadarrRequest(request);
  yield* Effect.logInfo(
    `Added to Radarr: ${film.title} (${qualityProfile.name}, released)`,
  );
});

export const syncWatchlistToRadarr = Effect.fn("syncWatchlistToRadarr")(
  function* (films: ReadonlyArray<FilmWithTmdbId>) {
    const existingMovieResources = yield* getRadarrJson(
      "/api/v3/movie",
      Schema.Array(RadarrMovieResource),
    );
    const existingMovies = yield* Effect.forEach(
      existingMovieResources,
      (resource) =>
        Schema.decodeUnknownEffect(RadarrMovieFields)(resource).pipe(
          Effect.map((fields) => ({ fields, resource })),
        ),
    );
    const existingTmdbIds = new Set(
      existingMovies.map((movie) => movie.fields.tmdbId),
    );
    const watchlistTmdbIds = new Set(films.map((film) => film.tmdbId));
    const missingMovies = films.filter(
      (film) => !existingTmdbIds.has(film.tmdbId),
    );

    const rootFolders = yield* getRadarrJson(
      "/api/v3/rootfolder",
      Schema.Array(RadarrRootFolder),
    );
    const qualityProfiles = yield* getRadarrJson(
      "/api/v3/qualityprofile",
      Schema.Array(RadarrQualityProfile),
    );
    const qualityProfileName = yield* Config.string(
      "RADARR_QUALITY_PROFILE",
    ).pipe(Config.withDefault("Ultra-HD"));
    const rootFolder = rootFolders[0];
    const qualityProfile = qualityProfiles.find(
      (profile) =>
        profile.name.toLocaleLowerCase() ===
        qualityProfileName.toLocaleLowerCase(),
    );

    if (rootFolder === undefined) {
      return yield* new RadarrConfigurationError({
        message: "Radarr does not have a root folder configured",
      });
    }

    if (qualityProfile === undefined) {
      return yield* new RadarrConfigurationError({
        message: `Radarr does not have the requested quality profile: ${qualityProfileName}`,
      });
    }

    const moviesUsingWrongProfile = existingMovies.filter(
      (movie) =>
        watchlistTmdbIds.has(movie.fields.tmdbId) &&
        movie.fields.qualityProfileId !== qualityProfile.id,
    );

    yield* Effect.forEach(
      missingMovies,
      (film) => addMovieToRadarr(film, { rootFolder, qualityProfile }),
      { concurrency: 1 },
    );
    yield* Effect.forEach(
      moviesUsingWrongProfile,
      (movie) => updateMovieQualityProfile(movie, qualityProfile),
      { concurrency: 1 },
    );
  },
);
