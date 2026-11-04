# Contributing to Grabbit

Thanks for helping. Bug reports, ideas and pull requests are all welcome. By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open an [issue](https://github.com/JakeTheRabbit/grabbit/issues/new/choose) with the bug form. The most useful things to include:

- Grabbit version (the installer name, or the exe's file properties), OS and version, and how many screens you have.
- What you did, what you expected, and what happened instead.
- The log, `grabbit.log`: `%LOCALAPPDATA%\app.grabbit\logs\` on Windows, `~/Library/Logs/app.grabbit/` on macOS, `~/.local/share/app.grabbit/logs/` on Linux.

Don't attach captures of anything private. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

Needs [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh), and ffmpeg for recording. Linux also needs the WebKitGTK and capture libraries listed in [the CI workflow](.github/workflows/build.yml).

```bash
git clone https://github.com/JakeTheRabbit/grabbit
cd grabbit/app
bun install
bunx tauri dev
```

Use Bun for JavaScript dependencies (the lockfile is `bun.lock`), not npm.

## Before you open a pull request

Run what CI runs, from `app/`:

```bash
bun run typecheck
bun run build
cargo test --lib --manifest-path src-tauri/Cargo.toml
bunx tauri build --debug --no-bundle
./src-tauri/target/debug/grabbit --self-test out
```

`--self-test` captures the screens, round-trips every encoder, reads text, checks the clipboard and records a few seconds, so run it on a desktop you don't mind being captured.

UI changes can be checked without touching your real screen in the [studio](docs/demo/studio): the app's pages run in headless Chrome with a faked core. `markup-sweep.mjs`, `editor-sweep.mjs`, `layers-check.mjs` and `audit.mjs` (every screen in light and dark, checking text size, contrast and fit) print PASS/FAIL per check.

## Pull requests

- Keep each pull request to one change, and say what it fixes or adds and how you checked it.
- Match the code around you: names, comment style, file layout. Avoid drive-by refactors.
- User-facing text is plain English: say what a button does ("Copy for chat"), not how it works.
- Add a line under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Screenshots or a short clip help for UI changes. Use the studio or a test desktop, not your real one.

## How releases are made

1. Move the **[Unreleased]** notes in `CHANGELOG.md` under a new version heading.
2. Bump the version in `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock` (the `grabbit` entry) and `app/src-tauri/tauri.conf.json`.
3. Commit as `Version x.y.z`, tag `vx.y.z`, and push the branch and the tag.
4. CI tests on Windows, macOS and Linux, then builds the installers into a draft release.
5. Paste that version's changelog section into the release notes and publish it.

## Licence

Contributions are released under the [MIT licence](LICENSE), the same as the rest of Grabbit.
