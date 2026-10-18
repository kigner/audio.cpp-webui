# Aixora Studio portable updater

```powershell
.\update.bat --check
.\update.bat --apply
.\update.bat --dry-run
.\update.bat --manifest C:\release\manifest-v0.7.1.json --dry-run
```

Close Studio, dictation and other portable processes before applying an update.
Running `update.bat` without arguments asks for confirmation. It does not run
silently when Studio starts.

## Full-package baseline and naming

**0.7.0 starts a new update baseline.** Older installations can still use their
legacy channel to update to 0.6.0. They cannot incrementally upgrade to 0.7.0
or later; install the complete `Aixora-Studio.zip` package first.

The full package is hosted in [kigner/audio.cpp-webui on Hugging Face](https://huggingface.co/kigner/audio.cpp-webui/tree/main).
Its name is always **`Aixora-Studio.zip`**, including future full-package
baselines. Replace that root file when publishing a new full package. Baidu
Netdisk and Google Drive copies are uploaded manually as full-package backups;
they are not automatic updater sources.

Incremental archives keep the existing project names:

- `audiocpp-app-v<VERSION>.zip`
- `audiocpp-core-cpu-win-x64-v<VERSION>.zip`
- `audiocpp-core-cuda-win-x64-v<VERSION>.zip`
- `audiocpp-core-vulkan-win-x64-v<VERSION>.zip`
- `audiocpp-python-deps-py311-win-x64-v<VERSION>.zip` when dependencies change
- `audiocpp-updater-v<UPDATER_VERSION>.zip` when the updater changes

## Channels and automatic fallback

For 0.7.0 and later, updater 1.2.0 checks these sources in order:

1. `https://github.com/kigner/audio.cpp-webui/releases/latest/download/stable-v0.7.0.json`
2. `https://huggingface.co/kigner/audio.cpp-webui/resolve/main/updates/v0.7.0/stable.json`
3. `https://hf-mirror.com/kigner/audio.cpp-webui/resolve/main/updates/v0.7.0/stable.json`

Download failures, invalid pointers, invalid manifest signatures and incompatible
manifests trigger the next source. Components also try their backup URLs on
download, size or SHA-256 failures. The host that supplied a valid manifest is
preferred for component downloads. Each network URL is attempted up to three
times, with a 45-second timeout per attempt. A valid up-to-date feed ends the
check; this is ordered failover, not a fastest-source or newest-mirror search.

`-StableUrl <URL>` overrides the feed for one invocation. PowerShell callers may
pass `-StableUrls @(<URL1>, <URL2>, ...)` for isolated tests. `--manifest` uses
only the explicitly supplied signed manifest. Public assets require HTTPS;
plain HTTP is permitted only for loopback acceptance tests.

The old `releases/latest/download/stable.json` must remain a pointer to the
published **0.6.0** manifest. Every future GitHub Latest release must include
that legacy pointer as well as `stable-v0.7.0.json`. Do not overwrite the old
pointer with a 0.7.x manifest. The builder copies the legacy pointer from
`scripts/update_legacy_stable.json`.

## Validation and self-update

The updater verifies the manifest with the bundled minisign public key, then
checks each archive's size, SHA-256 and file index. Models, voices, outputs,
logs, API keys and user settings remain protected. Application failures roll
back managed files from `_update/backup/`.

CPU, CUDA and Vulkan components contain their three executables and bundled
DLLs. This updates backend runtimes; it does not install GPU drivers.

An `updater` component can update the updater itself. Increment
`updater/updater.version`, update the updater component in `version.json`, and
build with `-IncludeUpdater`. A separate helper waits for the original updater
to exit, backs up and replaces the allowed files, checks the new updater, then
resumes the same manifest. A failed self-check restores updater files. If the
later application update fails, the validated new updater remains installed.

Keep the production minisign private key outside the repository and portable
package. Never replace the bundled public key with a placeholder.

## Building and publishing

Build from a clean, tested commit and already verified portable binaries:

```powershell
.\scripts\build_update_release.ps1 `
  -Version 0.7.1 `
  -MinisignSecretKey C:\secure\audio-cpp.key `
  -MinisignPublicKey C:\release-tools\audio-cpp.pub `
  -MinisignPath C:\release-tools\minisign.exe `
  -Stable
```

`-SupportedFrom` can narrow eligibility but cannot remove the `>=0.7.0` floor.
The signed manifest records `update_baseline: "0.7.0"`; another baseline is
rejected. Building version 0.7.0 creates an initial no-change feed for full-package
installations. It does not enable 0.6.0 to 0.7.0 upgrades.

The builder produces signed manifests, components, release notes and signed
SHA256SUMS, plus these publication files:

| File | Destination |
|---|---|
| `stable.json` | GitHub Release; preserves the legacy 0.6.0 pointer |
| `stable-v0.7.0.json` | GitHub Release; new baseline pointer |
| `stable-v0.7.0.huggingface.json` | HF `updates/v0.7.0/stable.json` after asset verification |
| `huggingface-upload.json` | Local upload plan; does not upload anything |

Upload identical signed assets to GitHub and HF `updates/v0.7.0/v<VERSION>/`.
Follow the upload plan's `assets` entries first, verify them, then publish its
`promote-after-verification` entry. The HF pointer uses relative manifest and
signature paths so the same bytes work through hf-mirror. Preserve exact bytes
of signed JSON and signatures; avoid Git line-ending conversion and web edits.

Keep historical version directories and all legacy 0.6.0 release assets.
Only the root full-package ZIP is replaced under a fixed filename; incremental
assets are immutable versioned snapshots. Future full baselines need their own
channels, while existing baseline pointers must remain available.

Run `tests/updater/run_tests.ps1` before release. Those isolated fixtures use
test signature verifiers; production release still requires real signature,
remote asset and clean-bundle upgrade checks. Check mirror downloads separately:
a redirect to HF does not demonstrate an independent cached copy. `-AllowDirty`
is not a substitute for release verification.

## Optional offline Python dependencies

Pass `-PythonDepsSource` when dependencies change. Its directory contains:

```text
wheels/*.whl
requirements-update.txt
before-install.json
after-install-checks.json
```

Each requirement must be an exact `name==version` with `--hash=sha256:<HASH>`.
Arbitrary indexes, URLs, editable installs, markers, Torch, Python itself, CUDA
and Triton are rejected. Both JSON files use `{"schema": 1, "packages": [...]}`.
Each package declares its `name`, `version` and explicit `paths` under
`venv/Lib/site-packages/`, including the package and exact `.dist-info` directory.
The before file describes installed paths to back up; the after file describes
target paths and versions to verify and remove during rollback.

## Packaging boundaries

Root `run_webui.bat`, `_env.bat`, `webui/start_webui.bat`, backend probing and
both Studio READMEs are application inputs. `update.bat` belongs to the updater
component. Native UI runtime assets remain included; native frontend source,
tests, user data and development dependencies are excluded.

`-IncludeStandaloneApi` adds the standalone server launchers and must be used on
each later release that should keep them. Obsolete files are listed individually
in `files.json`; their removal is backed up and rolled back on health failure.

The bootstrap builder now targets 0.7.0 or later only. Keep the published legacy
bootstrap for old installations; do not overlay a new bootstrap onto an old
package to bypass the full-package requirement.
