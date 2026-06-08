import { load } from "cheerio";
import { Config, Data, Effect, Option, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { Film } from "./film.ts";

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
      const tmdbId = Number(
        load(html)("body[data-tmdb-id]").attr("data-tmdb-id"),
      );

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

export const fetchWatchlist = Effect.fn("fetchWatchlist")(function* () {
  const watchlistUrl = yield* Config.string("LETTERBOXD_WATCHLIST_URL");
  const films = yield* Stream.paginate(watchlistUrl, (pageUrl) =>
    fetchWatchlistPage(pageUrl).pipe(
      Effect.map((page) => [page.films, page.nextUrl]),
    ),
  ).pipe(Stream.runCollect);

  return yield* Effect.forEach(films, fetchTmdbId, { concurrency: 4 });
});
