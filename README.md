# dsh-usage-monitor

[![CI](https://github.com/ericceg/dsh-usage-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/ericceg/dsh-usage-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Always-visible DeepSeek credits in the DSH Web GUI: balance left, spend per
chat, today, this month and all time — in Swiss francs, without opening
Settings → Account. The whole UI is monochrome; no accent or status colours.

## Features

- **Floating card** — draggable, CHF only. Total left, this chat, today, this
  month, all time and a 14-day histogram (hover or arrow-key a bar for the
  exact amount). Double-click the header, the chevron or Enter collapses it;
  position, collapsed state and visibility persist per device. In a chat it
  adds tokens, cache-hit rate and model, outside one the recent chats.
- **Sidebar chip** — credits left in CHF above the Settings row; click for
  details. A hollow dot marks a low balance.
- **Composer pill** — estimated cost of the current chat, `≈ CHF 0.16`.
- **Details panel** — balance, this chat/today/month/all-time, top-up and
  granted balances, daily histogram, spend by model, token counts, FX rate,
  refresh and a link to the Platform usage page.
- **Settings → General** — a switch to show or hide the card on this device
  (the same switch is at the bottom of the panel).

## Install

Requires DeepSeek Harness 0.2.x and a signed-in DeepSeek account. From a
checkout:

```sh
dsh plugin --profile desktop add link:/path/to/dsh-usage-monitor
```

Or from GitHub:

```sh
dsh plugin --profile desktop add git+https://github.com/ericceg/dsh-usage-monitor.git
```

Replace `desktop` with your profile name.

## Configure

Optional overrides in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-usage-monitor
  name: dsh-usage-monitor
  config:
    defaultModel: deepseek-flash   # model for the per-chat estimate
    lowBalanceChf: 2               # low-balance warning threshold
    floatingCard: true             # initial card visibility
    refreshSeconds: 60             # client poll interval
    fxFallbackRates:
      CNY: 8.05
      USD: 1.21
```

## Privacy

Balance and usage are read on the Host through DSH's account service; the
browser gets aggregates only and never an account token. Calls go only to the
DeepSeek Platform and `api.frankfurter.dev` (ECB CHF rates, cached 6 hours).
Card position, collapsed state, preference and recent chats stay in
`localStorage` on this device. No telemetry.

## Notes

Per-chat cost is an **estimate** (provider-reported tokens × list prices, `≈`).
Peak pricing is Beijing weekdays 09:00–12:00 and 14:00–18:00; holidays are not
modelled. Monthly and daily usage come from private dashboard endpoints and may
change without notice. Prices live in `PRICE_TABLE` in `lib/index.js`; per 1M
tokens, off-peak / peak:

| Model | Cache hit | Cache miss | Output |
|---|---|---|---|
| `deepseek-flash` (CNY) | ¥0.02 / ¥0.04 | ¥1 / ¥2 | ¥4 / ¥8 |
| `deepseek-v4-pro` (CNY) | ¥0.15 / ¥0.30 | ¥4.5 / ¥9 | ¥13.5 / ¥27 |
| `deepseek-flash` (USD) | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` (USD) | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

## Development

No dependencies; plain Node (20+) and a fake React. CI runs the first three:

```sh
node --check lib/index.js && node --check lib/client.js
node test/client-smoke.mjs
node test/client-render.mjs
node test/host-live.mjs   # live Platform probe, needs a signed-in account
```

## License

[MIT](LICENSE)
