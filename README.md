# PNG Squeeze — Squeeze screenshots into the smallest PNG

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/aramexbit/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/aramexbit/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

An entry for the [make.fun](https://make.fun/c/png-squeeze-01-run-20261127) competition **png-squeeze-01-run-20261127**: write one program that rewrites 1280×720 RGBA screenshots as the smallest possible lossless PNG.

`main.ts` (Node 22, no dependencies) decodes each screenshot, reduces its colour type per image (palette, grey, grey+alpha, RGB, RGBA), picks each row's PNG filter by real deflate size, and deflates at zlib level 9 — deterministically, within the 60-second wall for the whole set of 8.

## Run it

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Practice-set score (kit scorer): **695,625** — baseline fixed-paeth scores 420,399.
