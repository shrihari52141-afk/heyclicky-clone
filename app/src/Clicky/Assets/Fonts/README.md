# Fonts (public OFL releases — downloaded at build time)

This folder holds the UI fonts at runtime, but the `.ttf` files are NOT
stored in the repo (binary files cannot go through the repo's push route).

- **Patrick Hand** (Regular) — handwritten text (answers, drawings).
- **Barlow** (Regular / Medium / SemiBold) — clean UI text.

Source: the public OFL releases in
https://github.com/google/fonts (`ofl/patrickhand/`,
`ofl/barlow/`). The GitHub Actions workflow downloads them before the
build (see `.github/workflows/build-windows.yml`); for a local Windows
build run `scripts/fetch-fonts.ps1`. If a font file is missing, WinUI
falls back to the system font — the build never fails for it.
