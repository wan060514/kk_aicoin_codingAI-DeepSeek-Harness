# aicoin-mcp — drive the AiCoin desktop client from an agent

> A **zero-dependency MCP** (Model Context Protocol) server plus a DeepSeek Harness
> bridge plugin. It attaches to a running **AiCoin desktop client** (Electron) over
> Chrome DevTools Protocol and lets an agent read state, switch symbol/timeframe,
> read custom-indicator sources, call the client's own authenticated API, take
> screenshots, and (only with explicit confirmation) save an AiScript indicator.

- Server: `aicoin-mcp/` — `node src/server.mjs`, plain Node >= 20, no third-party packages.
- Harness plugin: `aicoin-mcp/dsh-plugin/` — registers the MCP tools as `aicoin_app_*`.
- Reverse-engineering evidence: `docs/asar-recon.md` (static) + `research/runtime-probe.md` (runtime).

---

## 1. Why this exists

AiCoin exposes no public API and has no plugin system. Its capabilities live inside
the Electron renderer: the login session, an axios instance with RSA/AES request
interceptors, a redux store, hash routing, and the AiScript editor.

This project **does not modify a single file under the install directory**. It only:

1. starts AiCoin with `--remote-debugging-port=9222`, and
2. uses `Runtime.evaluate` inside the page to reach the client's **own** axios
   instance and redux store — so every request carries the client's real session
   and encryption, instead of a re-implementation guessing the signing scheme.

## 2. Architecture

```
DeepSeek Harness
  └─ dsh-plugin-aicoin-mcp
       │  1. spawns: node <serverRoot>/src/server.mjs --port 9222
       │  2. MCP handshake (initialize / tools/list)
       │  3. registers every MCP tool as a harness tool
       └─ aicoin-mcp server (stdio JSON-RPC 2.0)
            ├─ src/cdp.mjs        hand-written WebSocket CDP client (target selection)
            ├─ src/inject.mjs     page kernel: webpack require, axios, redux actions
            ├─ src/launcher.mjs   start/stop AiCoin (env sanitising, single-instance diagnosis)
            └─ src/tools/*.mjs    lifecycle / system / api / domain tools
```

The MCP server is generic: any MCP client (Claude Desktop, Cursor, …) can use it
directly; the Harness plugin is only a convenience bridge.

## 3. Install

### 3.1 Into DeepSeek Harness

```powershell
cd 'D:\deepseek Harness work\aicoin-mcp'
node install.mjs --enable --run-pnpm
```

`install.mjs` does four things (backing up both edited files):

1. copies `dsh-plugin/` to `<profile>\plugins\dsh-plugin-aicoin-mcp`
2. adds a `link:` dependency to the profile's `package.json`
3. appends an `id: aicoin-mcp` row to the profile's `cordis.patch.yml`
4. runs the profile's `pnpm install`

The patch layer hot-reloads, so the `aicoin_app_*` tools appear in the running
session. Uninstall with `node install.mjs --uninstall --run-pnpm`.

### 3.2 Into any other MCP client

```json
{
  "mcpServers": {
    "aicoin": {
      "command": "node",
      "args": ["D:/deepseek Harness work/aicoin-mcp/src/server.mjs", "--port", "9222"],
      "env": { "AICOIN_CDP_PORT": "9222" }
    }
  }
}
```

> Harness runs inside Electron and passes `ELECTRON_RUN_AS_NODE=1` to children.
> The plugin launches the server with `process.execPath`, which is fine; **but the
> server must strip that variable before spawning `AiCoin.exe`**, otherwise the
> client runs as Node and dies with `bad option: --remote-debugging-port=9222`.
> `src/launcher.mjs` does this for you.

## 4. Tools

Names are prefixed `aicoin_app_` to avoid colliding with `kk_aicoin_codingAI`'s
`aicoin_validate` & friends. The authoritative list is `tools/list`
(`node scripts/mcp-handshake.mjs` prints it).

| Tool | Purpose | Notes |
| --- | --- | --- |
| `aicoin_mcp_status` | bridge self-check (plugin side) | not an MCP tool |
| `aicoin_app_connect` | one-shot "make it work": attach, or restart with a debug port, or launch | mutating; `allowRestart:true` to let it close the running window |
| `aicoin_app_launch` | start/reuse AiCoin with a debug port | mutating |
| `aicoin_app_stop` | stop the instance on a port | mutating; `dryRun` supported |
| `aicoin_app_restart` | stop + relaunch (e.g. to make an externally started client controllable) | mutating |
| `aicoin_app_status` | port/version/processes/all windows/login heuristic | read-only |
| `aicoin_app_targets` | every CDP target with page indexes | read-only |
| `aicoin_app_windows` | attachable windows: index/title/hash/isMain | read-only |
| `aicoin_app_eval` | evaluate JS in a chosen window | side effects possible |
| `aicoin_app_console` | page console + uncaught exceptions | read-only; uses an in-page hook |
| `aicoin_app_screenshot` | PNG/JPEG/WebP into `shots/` | returns path/size, never raw base64 |
| `aicoin_app_snapshot` | page snapshot (route, chart state, DOM selectors) | read-only |
| `aicoin_app_api` | call the client's own API with its session + crypto | read-only by default; write paths need `allowWrite:true` |
| `aicoin_app_navigate` | hash route / symbol / timeframe | mutates UI state |
| `aicoin_app_indicators_list` | my indicators (summary by default) | read-only |
| `aicoin_app_indicators_get` | one indicator's full AiScript source | read-only |
| `aicoin_app_indicator_save` | create/overwrite an indicator | **writes the account**; needs `confirm:true` |
| `aicoin_app_indicator_publish` | write the script into AiCoin **and** return the server compile verdict, mapped to `errLine` + the offending source line | **writes the account**; `mode:verify` deletes its probe afterwards |
| `aicoin_app_indicator_del` | delete an indicator (cleanup of probes / bad drafts) | **writes the account**; irreversible; `confirm:true` |
| `aicoin_data_catalog` | list the 183 read-only Open Data v3 endpoints (group / group detail / one signature) | no key beyond the bundled free one |
| `aicoin_data_capabilities` | which endpoints **this key** can really call (`probe:true` to actually hit them) | costs request quota when probing |
| `aicoin_data_query` | call any read-only endpoint (endpoint + params) | **GET only**; unknown paths are rejected before any request |
| `aicoin_quote` | price / 24h &amp; 7d change / turnover / net inflow | free key works |
| `aicoin_kline` | OHLCV klines + high/low/first/last summary | free key works |
| `aicoin_indicator_kline` | AiCoin's own indicator time series (`indicator_key`) | paid key |
| `aicoin_derivatives` | funding rates / open interest ranking / long-short / liquidations | paid key |
| `aicoin_news` | newsflashes / articles / keyword search | paid key |

### "I started AiCoin myself, so CDP cannot connect" — expected, not a bug

Electron opens the DevTools socket **only at process start** (`--remote-debugging-port`).
An AiCoin that the user double-clicked cannot be attached afterwards, no matter what
CDP client asks — so the bridge reports `running-without-debug-port` and hands back a
machine-readable `nextAction`:

```json
{ "process": { "verdict": "running-without-debug-port", "mainPids": [13686] },
  "nextAction": { "tool": "aicoin_app_connect", "args": { "port": 9222, "allowRestart": true } } }
```

Call `aicoin_app_connect` (or the panel's 「以调试模式重启」) once and the instance is
restarted with the port open; from then on it is attachable. Two related traps this
code now handles:

- the POSIX process scan used to count its own `sh -c … | grep -i aicoin` pipeline as
  two extra AiCoin main processes (fake pids, wrong `verdict`); the scan now filters on
  `basename(argv[0]) == aicoin(.exe)`;
- a port that opens and then dies (single-instance handoff, sandbox-blocked child) used
  to be reported as `ok:true`; `confirmStable()` re-probes after 1.5 s and 0.7 s more and
  requires the spawned pid to still be alive.

### Market data (Open Data v3) — what the free key can and cannot do

The `aicoin_data_*` tools do **not** go through CDP at all: they call AiCoin's public
read-only API (`https://open.aicoin.com/api/v3/…`, HMAC-SHA1 signed header auth). That is
the only way to get clean numbers — the client UI can show you a chart but cannot hand
back 500 candles.

The bundled **free key** (IP rate-limited, 15 req/min) is narrow. Measured 2026-10-24:

| Works with the free key | Returns 403 (needs your own key) |
| --- | --- |
| `market/ticker`, `market/tickers`, `market/klines` | funding rates, open interest, long/short, liquidations |
| `coins/tickers`, `coins/search`, `markets` | newsflashes, articles, X posts |
| `hyperliquid/tickers`, `airdrops`, `_catalog` | indexes, macro, signals, indicator klines, orderbook, big orders |

So: quotes, klines, symbol search and the endpoint catalog work out of the box; everything
else answers `403` and the tools return `needs_paid_key: true` plus the exact matrix
instead of a vague failure. To unlock the rest, get a key at
<https://www.aicoin.com/opendata> and export it before starting the bridge:

```bash
export AICOIN_ACCESS_KEY_ID=…
export AICOIN_ACCESS_SECRET=…
```

Two deliberate limits: this client implements **GET only** (23 of the 183 endpoints are
POST — Hyperliquid batch queries, treasury, average price — and are refused with
`READ_ONLY`), and it never touches exchange credentials, so no tool here can place or
cancel an order. Trading routes live in the official `@aicoin/aicoin-mcp` package, which we
deliberately did not vendor (it pulls in `ccxt` and needs exchange keys).

#### Verified against a real account (2026-10-24)

`aicoin_app_indicator_publish` was exercised against the live client, not just mocked:

| case | result |
|---|---|
| valid script, `mode:"verify"` | `compile.pass: true`, `verified: true`, probe created then **deleted** (`cleanup.ok: true`) |
| invalid script (`var int t0 = time`), `mode:"verify"` | `compile.pass: false`, `errLine: 2`, `errColumn: 8`, `err: "第 2 行第 8 列：cannot use float as type int in assignment"`, `sourceLine: "var int t0 = time"`, `caret: "       ^"`, probe deleted |
| real 123-line pivot indicator, `mode:"publish"` | written into the account as indicator id `1423518`, `compile.pass: true`, `aicoin_app_indicators_list` reads it back |

Two things that only show up on a real account:

- **A freshly launched AiCoin may reject the first save** with `PAGE_EXCEPTION: AxiosError: Network Error`
  (the renderer has not installed its axios interceptors yet). The tool now waits 1.5 s and retries
  once, so a cold start does not read like a compile failure.
- **`compileResult` arrives on success too**, not only on failure — `securityCount` and `warnMessage[]`
  are worth reading even when `pass` is true (a script using 40 data sources compiles but will trip the
  40014 limit later).

## Write → compile → deliver, without the editor

`aicoin_app_indicator_save` only tells you whether the request was accepted. The actual
AiScript compilation happens **server-side**, and the verdict comes back inside the save
response as `data.compileResult`:

```json
{ "pass": false, "errLine": 34, "errColumn": 10,
  "err": "cannot use float as type int in assignment",
  "securityCount": "1", "hasAlert": false, "hasTrade": false,
  "warnMessage": [{ "line": 12, "column": 0, "message": "…" }] }
```

`aicoin_app_indicator_publish` wraps the whole loop and maps that back to your source:

```jsonc
{ "ok": false, "mode": "verify", "name": "枢轴点-当日 · 编译探针",
  "compile": { "pass": false, "errLine": 34, "errColumn": 10,
               "err": "cannot use float as type int in assignment",
               "sourceLine": "var int   t0 = time",
               "caret": "         ^", "verified": true },
  "cleanup": { "id": 8123, "ok": true, "reason": "verify 模式的临时探针" },
  "summary": "第 34 行第 10 列: cannot use float as type int in assignment" }
```

Two modes:

- `mode: "verify"` (recommended first pass) — creates `<name> · 编译探针`, keeps it only long
  enough to read the verdict, then **deletes it**, so the account is left untouched.
- `mode: "publish"` — same-name indicator is adopted and updated instead of duplicated;
  on a compile failure the freshly created (broken) draft is deleted unless `keepOnFail:true`.

So the delivery loop is: `aicoin_validate` (offline, catches most) → `indicator_publish`
(`mode:verify`, real compiler) → fix by `compile.errLine`/`sourceLine` → publish → deliver.
No copy-paste into the client editor, and no junk indicators left behind.

### Multiple windows: pick the target

The client keeps 4 page targets alive (`#/main/exchange`, `#/chat`,
`#/asset-sync`, `#/notice`). Each is a separate renderer with its own store, so
attaching to "the first page" drives the wrong window. Every page-scoped tool takes
`target`: `main` | `chart` | `notice` | `chat` | a URL substring | an index.
The default is the `#/main` window, and every result echoes the window it used.

### Business errors come back as HTTP 200

The client reports failures as **HTTP 200 + `{success:false,status:<code>}`**.
`aicoin_app_api` returns `httpOk / success / status / message` separately:

| status | meaning |
| --- | --- |
| `403` + "login expired" | session gone (the client logs out on this) |
| `10510` | indicator was deleted |
| `40003` | line failover retry |

## 5. Typical session

```
# state first
aicoin_app_status

# switch the K-line window to BTC perpetual, 15m
aicoin_app_navigate { "symbol": "BTCUSDT", "type": "perp", "timeframe": "15m" }

# read my indicators, then one script, then validate statically
aicoin_app_indicators_list
aicoin_app_indicators_get { "id": 12345 }
aicoin_validate { ... }        # from kk_aicoin_codingAI

# a read-only business call
aicoin_app_api { "method": "post", "path": "upgrade/customIndicator/script/list" }

# overwriting a script (writes the account, explicit confirmation)
aicoin_app_indicator_save { "id": 12345, "name": "...", "source": "...", "confirm": true }
```

## 6. Safety and limits

- **The debug port is full control.** Any local process that can reach it can read
  the session and drive the client. Stop AiCoin (or don't launch it with the port)
  when you are done.
- **Read-only by default.** Of the account-writing endpoints only
  `indicator_save` is exposed, it requires `confirm:true`, and deletion is not
  implemented at all.
- **No backtests, no performance numbers.** The client has no local compiler; the
  real compile happens server-side on save. Any win-rate/Sharpe/drawdown figure
  would be fabricated, so this project never emits one.
- **Session reuse.** Tools use the client's own login; credentials are never copied
  out.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `bad option: --remote-debugging-port=9222` | `ELECTRON_RUN_AS_NODE=1` leaked into AiCoin's env; `aicoin_app_launch` strips it |
| Port closed but AiCoin is running | single-instance lock: the running instance has no debug port. Use `aicoin_app_stop` (or `aicoin_app_restart force:true`) |
| Only `aicoin_mcp_status` is listed | the MCP child failed to start / `serverRoot` is wrong; check its "last error" |
| eval returns another window's data | wrong `target`; inspect `aicoin_app_targets` |
| Edited `src/*.mjs`, tools unchanged | the plugin caches `tools/list`; toggle the plugin in Settings → Plugins |
| Chinese text turns into `???` / `U+FFFD` | writing source through a PowerShell redirect uses the ANSI code page; use the write/edit tools and check `node -e "…(s.match(/\uFFFD/g)||[]).length"` is 0 |

## 8. Self-checks

```powershell
cd 'D:\deepseek Harness work\aicoin-mcp'
node scripts/mcp-handshake.mjs     # MCP protocol + tool list + a real call
node scripts/bridge-selftest.mjs   # bridge with a stubbed plugin context
node test/run.mjs                  # unit tests (mock CDP + mock MCP client)
```
