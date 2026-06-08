import {
  NodeFileSystem,
  NodeHttpClient,
  NodeRuntime,
} from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Schedule } from "effect";

import { loadConfigProvider } from "./src/config.ts";
import { pollWatchlist } from "./src/polling.ts";

const pollAndRecover = pollWatchlist().pipe(
  Effect.catchCause((cause) =>
    Effect.logError("Failed to poll Letterboxd watchlist", cause),
  ),
);

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
