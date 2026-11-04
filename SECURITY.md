# Security policy

## Supported versions

Only the [latest release](https://github.com/JakeTheRabbit/grabbit/releases/latest) gets security fixes. Please update before reporting.

| Version | Supported |
|---|---|
| Latest 2.x | ✓ |
| Older 2.x | ✗ |
| 0.1 (legacy WPF) | ✗ |

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: **[Security → Report a vulnerability](https://github.com/JakeTheRabbit/grabbit/security/advisories/new)**.

Include what's affected, how to reproduce it, and what an attacker could do with it. You'll get a reply within 7 days. Once a fix is released, the advisory is published and you're credited unless you'd rather not be.

## What's in scope

Grabbit sees your screen, your clipboard, your microphone and the keys you add for AI and sharing, so these matter most:

- Captures, recordings, keys or settings leaving the computer without the user pressing Share or an AI button.
- Keys or tokens written anywhere other than the settings file, or included in a settings backup without the box ticked.
- The `grabbit://` link handler or command-line words doing more than they say (for example writing files outside the captures folder).
- Hidden-detail redaction or metadata stripping that leaves the data recoverable.
- The invisible watermark revealing more than the name and capture id it's meant to carry.

Unsigned-installer warnings from SmartScreen, Gatekeeper or Defender's machine-learning detections are known and covered in [docs/signing.md](docs/signing.md); they aren't vulnerabilities on their own.
