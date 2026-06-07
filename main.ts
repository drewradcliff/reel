import {
  NodeFileSystem,
  NodeHttpClient,
  NodeRuntime,
} from "@effect/platform-node";
import { load } from "cheerio";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const stateDirectory = ".reel";
const statePath = `${stateDirectory}/watchlist.json`;
const temporaryStatePath = `${statePath}.tmp`;

interface Film {
  readonly title: string;
  readonly url: string;
}

const FilmWithTmdbId = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  tmdbId: Schema.Number,
});
type FilmWithTmdbId = typeof FilmWithTmdbId.Type;

const WatchlistState = Schema.Struct({
  films: Schema.Array(FilmWithTmdbId),
});
type WatchlistState = typeof WatchlistState.Type;

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

const RadarrQuality = Schema.Struct({
  resolution: Schema.Number,
});

const RadarrQualityProfileChildItem = Schema.Struct({
  allowed: Schema.Boolean,
  quality: Schema.optional(RadarrQuality),
});

const RadarrQualityProfileItem = Schema.Struct({
  allowed: Schema.Boolean,
  quality: Schema.optional(RadarrQuality),
  items: Schema.Array(RadarrQualityProfileChildItem),
});

const RadarrQualityProfile = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  items: Schema.Array(RadarrQualityProfileItem),
});

interface RadarrAddConfiguration {
  readonly rootFolder: typeof RadarrRootFolder.Type;
  readonly qualityProfile: typeof RadarrQualityProfile.Type;
}

interface WatchlistPage {
  readonly films: ReadonlyArray<Film>;
  readonly nextUrl: Option.Option<string>;
}

class WatchlistParseError extends Data.TaggedError("WatchlistParseError")<{
  readonly cause: unknown;
}> {}

class FilmPageParseError extends Data.TaggedError("FilmPageParseError")<{
  readonly cause: unknown;
  readonly filmUrl: string;
}> {}

class RadarrConfigurationError extends Data.TaggedError(
  "RadarrConfigurationError",
)<{
  readonly message: string;
}> {}

const parseWatchlistPage = Effect.fn("parseWatchlistPage")(function* (
  html: string,
  pageUrl: string,
) {
  return yield* Effect.try({
    try: (): WatchlistPage => {
      const $ = load(html);
      const posterGrid = $(".poster-grid");

      if (posterGrid.length === 0) {
        throw new Error("Letterboxd response did not contain a watchlist");
      }

      const films = posterGrid
        .find('[data-component-class="LazyPoster"]')
        .toArray()
        .flatMap((element) => {
          const poster = $(element);
          const title = poster.attr("data-item-name");
          const link = poster.attr("data-item-link");

          return link !== undefined && title !== undefined
            ? [{ title, url: new URL(link, pageUrl).href }]
            : [];
        });

      const nextLink = $(".pagination a.next").attr("href");

      return {
        films,
        nextUrl:
          nextLink === undefined
            ? Option.none()
            : Option.some(new URL(nextLink, pageUrl).href),
      };
    },
    catch: (cause) => new WatchlistParseError({ cause }),
  });
});

const fetchWatchlistPage = Effect.fn("fetchWatchlistPage")(function* (
  pageUrl: string,
) {
  const response = yield* HttpClient.get(pageUrl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  );

  return yield* response.text.pipe(
    Effect.flatMap((html) => parseWatchlistPage(html, pageUrl)),
  );
});

const parseTmdbId = Effect.fn("parseTmdbId")(function* (
  html: string,
  filmUrl: string,
) {
  return yield* Effect.try({
    try: (): number => {
      const tmdbId = Number(load(html)("body[data-tmdb-id]").attr("data-tmdb-id"));

      if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
        throw new Error("Letterboxd film page did not contain a valid TMDB ID");
      }

      return tmdbId;
    },
    catch: (cause) => new FilmPageParseError({ cause, filmUrl }),
  });
});

const fetchTmdbId = Effect.fn("fetchTmdbId")(function* (film: Film) {
  const response = yield* HttpClient.get(film.url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  );
  const tmdbId = yield* response.text.pipe(
    Effect.flatMap((html) => parseTmdbId(html, film.url)),
  );

  return { ...film, tmdbId };
});

const fetchWatchlist = Effect.fn("fetchWatchlist")(function* () {
  const watchlistUrl = yield* Config.string("LETTERBOXD_WATCHLIST_URL");
  const films = yield* Stream.paginate(watchlistUrl, (pageUrl) =>
    fetchWatchlistPage(pageUrl).pipe(
      Effect.map((page) => [page.films, page.nextUrl]),
    ),
  ).pipe(Stream.runCollect);

  return yield* Effect.forEach(films, fetchTmdbId, { concurrency: 4 });
});

const readWatchlistState = Effect.fn("readWatchlistState")(function* () {
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

const writeWatchlistState = Effect.fn("writeWatchlistState")(function* (
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

const diffWatchlists = (
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

const executeRadarrRequest = Effect.fn("executeRadarrRequest")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const radarrUrl = yield* Config.string("RADARR_URL").pipe(
    Config.withDefault("http://localhost:7878"),
  );
  const apiKey = yield* Config.redacted("RADARR_API_KEY");
  const client = yield* HttpClient.HttpClient;
  const url = new URL(request.url, radarrUrl);

  return yield* client.execute(
    request.pipe(
      HttpClientRequest.setUrl(url),
      HttpClientRequest.setHeader("X-Api-Key", Redacted.value(apiKey)),
    ),
  ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

const getRadarrJson = <S extends Schema.Top>(path: string, schema: S) =>
  executeRadarrRequest(HttpClientRequest.get(path)).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  );

const isUltraHdProfile = (profile: typeof RadarrQualityProfile.Type) => {
  const allowedResolutions = profile.items.flatMap((item) => [
    ...(item.allowed && item.quality !== undefined
      ? [item.quality.resolution]
      : []),
    ...item.items
      .filter((child) => child.allowed && child.quality !== undefined)
      .map((child) => child.quality?.resolution)
      .filter((resolution) => resolution !== undefined),
  ]);

  return (
    allowedResolutions.length > 0 &&
    allowedResolutions.every((resolution) => resolution === 2160)
  );
};

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
    const searchRequest = yield* HttpClientRequest.post(
      "/api/v3/command",
    ).pipe(
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

const syncWatchlistToRadarr = Effect.fn("syncWatchlistToRadarr")(function* (
  films: ReadonlyArray<FilmWithTmdbId>,
) {
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
      profile.name.toLocaleLowerCase() === qualityProfileName.toLocaleLowerCase(),
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

  if (!isUltraHdProfile(qualityProfile)) {
    return yield* new RadarrConfigurationError({
      message: `Radarr quality profile is not 4K-only: ${qualityProfile.name}`,
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

});

const pollWatchlist = Effect.fn("pollWatchlist")(function* () {
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

const pollAndRecover = pollWatchlist().pipe(
  Effect.catchCause((cause) =>
    Effect.logError("Failed to poll Letterboxd watchlist", cause),
  ),
);

const loadConfigProvider = Effect.fn("loadConfigProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = ConfigProvider.fromEnv();

  if (!(yield* fileSystem.exists(".env"))) {
    return environment;
  }

  const dotEnv = yield* ConfigProvider.fromDotEnv();
  return ConfigProvider.orElse(environment, dotEnv);
});

const program = Effect.gen(function* () {
  const configProvider = yield* loadConfigProvider();

  yield* pollAndRecover.pipe(
    Effect.repeat(Schedule.spaced("30 minutes")),
    Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
  );
}).pipe(
  Effect.provide(Layer.merge(NodeHttpClient.layerFetch, NodeFileSystem.layer)),
);

NodeRuntime.runMain(program);
