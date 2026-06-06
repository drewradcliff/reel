#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"
effect_version=$(node -p "require('./package.json').dependencies.effect")
repo_ref="effect@$effect_version"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone --branch "$repo_ref" --depth 1 "$repo_url" "$repo_dir"
