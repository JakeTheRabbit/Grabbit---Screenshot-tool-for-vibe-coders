# Windows signing and Defender

Unsigned Windows builds get flagged by Microsoft Defender's machine-learning detections:

| Detection | On | What Defender sees |
|---|---|---|
| `Behavior:Win32/Persistence.A!ml` | `grabbit.exe`, a few seconds after it starts | An unsigned exe in `%LOCALAPPDATA%` with a Run key, writing registry keys at start-up |
| `Trojan:Win32/Bearfoos.A!ml` | `Grabbit_x.y.z_x64-setup.exe` | An unsigned NSIS installer with no reputation yet |

Remediation deletes the exe, its shortcuts, the Run key and the uninstall entry, so to the user it looks as if Grabbit uninstalled itself. Check `Get-MpThreatDetection` before you chase anything else.

## What the code already does

- Windows doesn't re-register the `grabbit://` scheme on every start (`lib.rs`): the NSIS and MSI installers register it. Rewriting `HKCU\Software\Classes` at start-up, next to a Run key, is the pattern the behaviour detection keys on.
- `tauri.conf.json` sets `publisher`, `copyright` and `homepage`, so the exe's version info carries a real CompanyName and LegalCopyright instead of `grabbit`.
- "Start with your computer" stays opt-in. The installer never writes the Run key.

None of this replaces a signature. Reputation is tied to the signing certificate, and an unsigned exe has none.

## Report a false positive (each release, until signed)

1. Go to <https://www.microsoft.com/wdsi/filesubmission> and sign in.
2. Choose **Software developer**, product **Microsoft Defender Antivirus (Windows client)**.
3. Upload `Grabbit_x.y.z_x64-setup.exe` and `grabbit.exe` from the installed folder, choose **Incorrectly detected as malware/malicious**, and paste the detection name.
4. Microsoft usually clears the hash within a few days. It doesn't carry over to the next release.

## Sign the builds (the real fix)

Options, cheapest first:

1. **SignPath Foundation**: free code signing for open-source projects. Apply at <https://signpath.org/apply>. The repo must be public, the licence OSI-approved (MIT is) and builds must come from CI, all of which Grabbit already does. The certificate is in SignPath Foundation's name, and each release is approved in their web UI.
2. **OV code-signing certificate** (Certum, Sectigo and others; about USD 150–300 a year, token or cloud HSM). It's in your own name, and reputation builds up over a few weeks of downloads.
3. **Azure Artifact Signing** (formerly Trusted Signing): cheap, but only for organisations in the US, Canada, EU and UK, so not available from NZ.

### Wiring SignPath into CI once approved

SignPath gives you an organisation id, a project slug and a signing-policy slug, and you add an API token as the `SIGNPATH_API_TOKEN` secret. In `.github/workflows/build.yml`, the Windows leg of the `release` job then:

1. builds without uploading (`tauri build`, not `tauri-action`), and uploads `app/src-tauri/target/release/bundle/nsis/*.exe` and `msi/*.msi` with `actions/upload-artifact`;
2. runs `signpath/github-action-submit-signing-request@v1` with `organization-id`, `project-slug`, `signing-policy-slug`, `github-artifact-id` (from the upload step), `wait-for-completion: true` and `output-artifact-directory: signed`;
3. uploads `signed/*` to the draft release with `gh release upload "$TAG" signed/* --clobber`.

The project's SignPath artifact configuration should sign `grabbit.exe` inside the installer as well as the installer itself, so both files show the signature.
