import { ConfigProvider, Effect, FileSystem } from "effect";

export const loadConfigProvider = Effect.fn("loadConfigProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = ConfigProvider.fromEnv();

  if (!(yield* fileSystem.exists(".env"))) {
    return environment;
  }

  const dotEnv = yield* ConfigProvider.fromDotEnv();
  return ConfigProvider.orElse(environment, dotEnv);
});
