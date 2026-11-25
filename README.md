# Token Radar (radar-11)

[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/roymaster46/token-radar-r11/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/roymaster46/token-radar-r11/reward.svg)](https://make.fun/bounty/token-radar-01)

Entry for [token-radar-01](https://make.fun/bounty/token-radar-01): a radar that
ranks pre-token DeFi protocols by the implied value of the token they have not
launched yet, from the sealed snapshot alone.

The model is a power-law size curve with a curvature term, a winsorised concave
growth term, a mild negative age term and shrunk category factors, fitted on the
snapshot's own traded tokens. Every term earns its place on both held-out tests
(leave-one-out and walk-forward); the dashboard's Method panel shows the
ablation table, including the terms that were tried and dropped. Each board row
carries its P25–P75 plausible range, its launch odds from the age-cohort read,
and an eight-step farm plan costed on the protocol's cheapest chain. The
coverage ledger accounts for all 758 protocols in the snapshot in ten groups.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`node main.ts` writes `board.json` (the ranked board, a bare array),
`data.js` (the dashboard dataset), the dashboard and screenshots into the
output directory, and `dossier.json` last. Node 22 or later, standard library
only — no dependencies to install.

## Layout

- `main.ts` — the entrypoint: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the value model, its validation and the farm economics.
- `dashboard/` — the static dashboard (no framework, no network).
- `vendor/makefun-board.ts` — the vendored dossier builder.
- `screenshots/` — the four dashboard screenshots the dossier carries.

## License

MIT — see [LICENSE](LICENSE).
