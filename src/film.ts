import { Schema } from "effect";

export interface Film {
  readonly title: string;
  readonly url: string;
}

export const FilmWithTmdbId = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  tmdbId: Schema.Number,
});
export type FilmWithTmdbId = typeof FilmWithTmdbId.Type;
