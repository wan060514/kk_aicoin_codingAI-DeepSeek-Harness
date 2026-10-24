/**
 * aicoin-mcp / src / launcher.mjs
 * ---------------------------------------------------------------------------
 * AiCoin.exe lifecycle: locate -> launch (with CDP debug port) -> probe ->
 * stop -> ensure -> restart.
 *
 * Zero dependencies. Node >= 22 (global fetch + global WebSocket). Verified on
 * Node v24.13.0 / Windows 11.
 *
 * ===========================================================================
 * HARD-WON FACTS (all verified by running them on this machine; see
 * research/lifecycle-selftest.md for the exact commands and output)
 * ===========================================================================
 * 1. AiCoin.exe is an Electron 43.2.0 / Chromium 150 application. CDP does not
 *    exist unless the app is started with `--remote-debugging-port=<port>`.
 *    A plain `AiCoin.exe` launch is a normal user window with NO automation
 *    surface at all.
 *
 * 2. DSH injects `ELECTRON_RUN_AS_NODE=1` into every child environment
 *    (verified: `node -e "console.log(process.env.ELECTRON_RUN_AS_NODE)"` -> "1").
 *    If that variable leaks into the AiCoin.exe spawn, the Electron binary
 *    starts in *plain Node mode*, chokes on the Chromium switch and dies with
 *        bad option: --remote-debugging-port=9222
 *    The port never opens and the error is easy to misread as "AiCoin is
 *    broken". => sanitizeEnv() MUST delete ELECTRON_RUN_AS_NODE (and
 *    ELECTRON_NO_ATTACH_CONSOLE) before spawn(). It never mutates process.env.
 *
 * 3. Electron single-instance lock. With a live AiCoin already holding the
 *    Chromium user-data-dir, a second
 *        AiCoin.exe --remote-debugging-port=9333
 *    exits with code 0 in ~0.5 s and NEVER opens port 9333 (verified).
 *    Therefore "spawn + port never appears" is NOT a command failure; it is
 *    almost always the single-instance lock, and it needs a *diagnosis*, never
 *    a "launch ok" verdict. launch() reports reason:
 *    'single-instance-conflict' with the live pids and their debug ports.
 *
 * 4. The verified escape hatch: pass a distinct `--user-data-dir=<dir>`. The
 *    singleton lock is keyed on that directory, so an isolated second instance
 *    starts fine and opens its debug port in ~1 s (verified). This is how you
 *    get a debug-enabled instance while the user's logged-in instance keeps
 *    running untouched.
 *
 * 5. AiCoin also spawns `AiCoin.exe "...\app.asar\childprocess\nodeaddon.js"`
 *    (node mode, and notice: NO `--type=` switch either). A "main browser
 *    process" is therefore the process that has NO `--type=` switch AND NO
 *    positional script argument. Classification below follows that rule.
 *
 * 6. `pwsh` is NOT guaranteed to be on PATH (on this machine only
 *    `powershell.exe` 5.1 exists), so process enumeration tries powershell.exe,
 *    then pwsh.exe, then pwsh.
 * ===========================================================================
 */

import { spawn, execFile } from 'node:child_process';
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default install location of AiCoin on this machine. */
export const DEFAULT_APP_PATH = 'D:\\Program Files\\AiCoin\\AiCoin.exe';
/** Default CDP port used by the rest of aicoin-mcp. */
export const DEFAULT_PORT = 9222;
/** CDP only ever listens on loopback. */
export const CDP_HOST = '127.0.0.1';

/** Chromium user data dir of the real profile (never write into it ourselves). */
export const DEFAULT_USER_DATA_DIR = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'aicoin',
);

/**
 * Environment variables that MUST NOT be inherited by the AiCoin.exe spawn.
 * Matched case-insensitively because Windows env keys are case-insensitive.
 * See HARD-WON FACT #2.
 */
const HARMFUL_ENV_PATTERNS = [
  /^ELECTRON_RUN_AS_NODE$/i,
  /^ELECTRON_NO_ATTACH_CONSOLE$/i,
  /^NODE_OPTIONS$/i,
  /^ELECTRON_ENABLE_LOGGING$/i,
];

const STATE_FILE = path.join(os.tmpdir(), 'aicoin-mcp-launcher-state.json');
const LOG_DIR = path.join(os.tmpdir(), 'aicoin-mcp-logs');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeLog(log, level, message, extra) {
  if (typeof log !== 'function') return;
  try {
    log(level, message, extra);
  } catch {
    /* a logger must never break the lifecycle */
  }
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function errMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/** True when the OS still knows this pid. */
export function isAlive(pid) {
  const n = toInt(pid);
  if (!n || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means "exists but not ours" -> alive.
    return err && err.code === 'EPERM';
  }
}

function looksLikeTimeout(err) {
  return (
    err &&
    (err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      /aborted|timeout/i.test(errMessage(err)))
  );
}

/**
 * Decide whether a just-opened debug port belongs to an instance that survives.
 *
 * Electron opens the DevTools socket before it takes the single-instance lock,
 * so "port answers" can precede a silent handoff-and-exit. Two probes ~700 ms
 * apart, plus the spawned pid still being alive, separate the two cases.
 *
 * @param {{port:number, pid?:number|null, settleMs?:number, gapMs?:number}} opts
 * @returns {Promise<{ok:boolean, portUp:boolean, pidAlive:boolean|null,
 *   firstProbeOk:boolean, secondProbeOk?:boolean, settledMs:number, reason?:string}>}
 */
async function confirmStable({ port, pid, settleMs = 1500, gapMs = 700 } = {}) {
  const started = Date.now();
  await sleep(settleMs);
  const first = await probePort(port, { timeoutMs: 1500 });
  const aliveAfterFirst = pid ? isAlive(pid) : null;
  if (!first.ok) {
    return {
      ok: false,
      portUp: false,
      pidAlive: aliveAfterFirst,
      firstProbeOk: false,
      settledMs: Date.now() - started,
      reason: 'port-dropped-after-open',
    };
  }
  await sleep(gapMs);
  const second = await probePort(port, { timeoutMs: 1500 });
  const aliveAfterSecond = pid ? isAlive(pid) : null;
  const ok = second.ok && aliveAfterSecond !== false;
  return {
    ok,
    portUp: second.ok,
    pidAlive: aliveAfterSecond,
    firstProbeOk: true,
    secondProbeOk: second.ok,
    settledMs: Date.now() - started,
    ...(ok ? {} : { reason: second.ok ? 'process-exited' : 'port-dropped-after-open' }),
  };
}

function describeFetchError(err) {
  if (looksLikeTimeout(err)) return 'timeout';
  const cause = err && err.cause ? errMessage(err.cause) : '';
  const code = (err && err.cause && err.cause.code) || (err && err.code);
  if (code) return `${code}${cause ? ` (${cause})` : ''}`;
  return errMessage(err);
}

/** Same path, case-insensitive compare (Windows semantics). */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Windows command line parsing (CommandLineToArgvW rules, good enough here)
// ---------------------------------------------------------------------------

/**
 * Split a Windows command line into argv, honouring double quotes and
 * backslash escaping. @returns {string[]}
 */
export function parseCommandLine(cmdline) {
  const s = String(cmdline ?? '');
  const args = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  let started = false;

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      let j = i;
      while (j < s.length && s[j] === '\\') {
        n += 1;
        j += 1;
      }
      if (j < s.length && s[j] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          cur += '"';
          j += 1;
        }
        i = j;
        started = true;
        continue;
      }
      cur += '\\'.repeat(n);
      i = j;
      started = true;
      continue;
    }
    if (c === '"') {
      if (inQuotes && s[i + 1] === '"') {
        cur += '"';
        i += 2;
        started = true;
        continue;
      }
      inQuotes = !inQuotes;
      i += 1;
      started = true;
      continue;
    }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started) {
        args.push(cur);
        cur = '';
        started = false;
      }
      i += 1;
      continue;
    }
    cur += c;
    started = true;
    i += 1;
  }
  if (started) args.push(cur);
  return args;
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.toLowerCase().startsWith(prefix.toLowerCase())) {
      return a.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Turn an OS process description into a classified view:
 * {pid, ppid, cmdline, argv, kind, type, isMain, debugPort, userDataDir}
 *
 * kind: 'main' | 'renderer' | 'gpu' | 'utility' | 'crashpad' | 'node' | 'other'
 */
export function classifyProcess(raw = {}) {
  const cmdline = raw.cmdline ?? raw.CommandLine ?? '';
  const argv = parseCommandLine(cmdline);
  const rest = argv.slice(1);

  const typeArg = rest.find((a) => /^--type=/i.test(a));
  const type = typeArg ? typeArg.slice('--type='.length) : null;
  // Positional = not a switch and looks like a path/script. AiCoin's
  // `nodeaddon.js` child has one; the real browser main process never does.
  const positional = rest.filter(
    (a) =>
      !a.startsWith('-') &&
      !a.startsWith('--') &&
      (/[\\/]/.test(a) || /\.(?:js|mjs|cjs|asar)$/i.test(a)),
  );

  let kind = 'other';
  if (type) {
    if (type === 'renderer') kind = 'renderer';
    else if (type.includes('gpu')) kind = 'gpu';
    else if (type.includes('crashpad')) kind = 'crashpad';
    else if (type.includes('utility')) kind = 'utility';
    else kind = 'other';
  } else if (positional.length > 0) {
    kind = 'node';
  } else {
    kind = 'main';
  }

  // A shell / grep / ps row can never be the Electron main process. POSIX scans
  // used to match their own `ps | grep -i aicoin` pipeline and classify both
  // rows as main, so every scan reported phantom pids that changed per call.
  if (kind === 'main' && /^(?:sh|bash|zsh|dash|grep|egrep|fgrep|ps|pgrep|pkill)$/i.test(path.basename(argv[0] ?? ''))) {
    kind = 'other';
  }

  const debugPort = toInt(argValue(rest, 'remote-debugging-port'));

  return {
    pid: toInt(raw.pid ?? raw.ProcessId),
    ppid: toInt(raw.ppid ?? raw.ParentProcessId),
    cmdline,
    argv,
    kind,
    type,
    isMain: kind === 'main',
    debugPort: Number.isInteger(debugPort) ? debugPort : null,
    userDataDir: argValue(rest, 'user-data-dir'),
  };
}

// ---------------------------------------------------------------------------
// App path discovery
// ---------------------------------------------------------------------------

/**
 * Normalise an installed macOS `.app` bundle to the binary spawn() can run.
 *
 * Verified on this machine: `/Applications/AiCoin.app` is a directory, and
 * spawning it fails with EACCES; the real Electron main binary is
 * `/Applications/AiCoin.app/Contents/MacOS/AiCoin`. Windows/Linux paths and
 * already-resolved executables pass through untouched.
 *
 * @param {string} [candidate]
 * @returns {string|undefined}
 */
export function resolveBundleExecutable(candidate) {
  if (!candidate || typeof candidate !== 'string') return candidate;
  if (!/\.app\/?$/i.test(candidate)) return candidate;

  const bundle = candidate.replace(/\/+$/, '');
  const macosDir = path.join(bundle, 'Contents', 'MacOS');

  const fromPlist = () => {
    try {
      const xml = readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
      const match = xml.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      if (match && match[1]) return path.join(macosDir, match[1]);
    } catch {
      /* binary plist or unreadable: fall through to the directory scan */
    }
    return null;
  };
  const fromDir = () => {
    try {
      const entries = readdirSync(macosDir, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && !entry.name.startsWith('.'),
      );
      if (entries.length > 0) return path.join(macosDir, entries[0].name);
    } catch {
      /* not a bundle after all */
    }
    return null;
  };

  return fromPlist() ?? fromDir() ?? path.join(macosDir, 'AiCoin');
}

/**
 * Locate AiCoin.exe.
 * Precedence: explicit argument > config.{appPath,aicoinPath,exePath} >
 * env AICOIN_APP_PATH / AICOIN_EXE > built-in default > scan of known dirs.
 * @returns {{path:string, exists:boolean, source:string, tried:Array}}
 */
export function findAppPath({ appPath, config } = {}) {
  const tried = [];
  const push = (candidate, source) => {
    if (!candidate || typeof candidate !== 'string') return;
    tried.push({ path: candidate, source, exists: existsSync(candidate) });
  };

  // An explicit argument is honoured even when it does not exist: silently
  // falling back to some other install would hide the user's typo.
  if (appPath) {
    const resolved = resolveBundleExecutable(appPath);
    push(resolved, 'argument');
    return { path: resolved, exists: existsSync(resolved), source: 'argument', tried };
  }

  const cfg = config || {};
  push(resolveBundleExecutable(cfg.appPath ?? cfg.aicoinPath ?? cfg.exePath), 'config');
  push(resolveBundleExecutable(process.env.AICOIN_APP_PATH), 'env:AICOIN_APP_PATH');
  push(resolveBundleExecutable(process.env.AICOIN_EXE), 'env:AICOIN_EXE');
  push(DEFAULT_APP_PATH, 'default');

  // macOS / Linux. AiCoin is an Electron app: on macOS the runnable binary lives
  // inside the bundle (AiCoin.app/Contents/MacOS/AiCoin) and spawn() on the .app
  // path itself fails with EACCES. Both forms are accepted and normalised by
  // resolveBundleExecutable().
  if (process.platform === 'darwin') {
    push('/Applications/AiCoin.app/Contents/MacOS/AiCoin', 'scan:/Applications');
    push(path.join(os.homedir(), 'Applications/AiCoin.app/Contents/MacOS/AiCoin'), 'scan:~/Applications');
  } else if (process.platform !== 'win32') {
    push('/opt/AiCoin/aicoin', 'scan:/opt');
    push('/opt/aicoin/aicoin', 'scan:/opt');
    push('/usr/local/bin/aicoin', 'scan:/usr/local/bin');
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    push(path.join(localAppData, 'Programs', 'aicoin', 'AiCoin.exe'), 'scan:LOCALAPPDATA');
    push(path.join(localAppData, 'Programs', 'AiCoin', 'AiCoin.exe'), 'scan:LOCALAPPDATA');
  }
  push('C:\\Program Files\\AiCoin\\AiCoin.exe', 'scan:ProgramFiles');
  push('C:\\Program Files (x86)\\AiCoin\\AiCoin.exe', 'scan:ProgramFilesX86');

  const hit = tried.find((t) => t.exists);
  if (hit) return { ...hit, tried };
  // Nothing exists: report the default as the intended path.
  const chosen = tried[0] ?? { path: DEFAULT_APP_PATH, source: 'default', exists: false };
  return { ...chosen, exists: false, tried };
}

// ---------------------------------------------------------------------------
// HTTP probes (no WebSocket needed)
// ---------------------------------------------------------------------------

/**
 * GET /json/version on a CDP port.
 * @returns {Promise<{ok:boolean, port:number, host:string, url:string,
 *   browser?:string, protocolVersion?:string, userAgent?:string, wsUrl?:string,
 *   latencyMs:number, error?:string, status?:number}>}
 */
export async function probePort(port = DEFAULT_PORT, { timeoutMs = 2000, host = CDP_HOST } = {}) {
  const started = Date.now();
  const p = toInt(port) ?? DEFAULT_PORT;
  const url = `http://${host}:${p}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return {
        ok: false,
        port: p,
        host,
        url,
        status: res.status,
        error: `HTTP ${res.status}`,
        latencyMs: Date.now() - started,
      };
    }
    const json = await res.json();
    return {
      ok: true,
      port: p,
      host,
      url,
      browser: json.Browser,
      protocolVersion: json['Protocol-Version'],
      userAgent: json['User-Agent'],
      v8Version: json['V8-Version'],
      webkitVersion: json['WebKit-Version'],
      wsUrl: json.webSocketDebuggerUrl,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      port: p,
      host,
      url,
      error: describeFetchError(err),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Generic JSON GET against the CDP HTTP endpoints (/json/version, /json/list,
 * /json/protocol).
 */
export async function httpGetJson(port = DEFAULT_PORT, pathname = '/json/list', {
  timeoutMs = 3000,
  host = CDP_HOST,
} = {}) {
  const started = Date.now();
  const p = toInt(port) ?? DEFAULT_PORT;
  const url = `http://${host}:${p}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, port: p, url, status: res.status, error: `HTTP ${res.status}`, body: text.slice(0, 500), latencyMs: Date.now() - started };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, port: p, url, error: 'invalid JSON', body: text.slice(0, 500), latencyMs: Date.now() - started };
    }
    return { ok: true, port: p, url, data: json, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, port: p, url, error: describeFetchError(err), latencyMs: Date.now() - started };
  }
}

/**
 * All CDP targets of a port (/json/list), including non-page targets.
 * @returns {Promise<{ok:boolean, port:number, targets?:Array, error?:string}>}
 */
export async function listTargets(port = DEFAULT_PORT, opts = {}) {
  const res = await httpGetJson(port, '/json/list', opts);
  if (!res.ok) return { ok: false, port: res.port, error: res.error, url: res.url };
  const list = Array.isArray(res.data) ? res.data : [];
  return {
    ok: true,
    port: res.port,
    count: list.length,
    targets: list.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      url: t.url,
      wsUrl: t.webSocketDebuggerUrl,
      faviconUrl: t.faviconUrl,
      attached: t.attached === true,
      description: t.description,
    })),
    raw: list,
  };
}

/** Wait until /json/version answers on `port`. */
export async function waitForPort(port = DEFAULT_PORT, {
  timeoutMs = 30000,
  intervalMs = 300,
  host = CDP_HOST,
  isCancelled,
} = {}) {
  const started = Date.now();
  let attempts = 0;
  let last = null;
  // Always attempt at least once, even with a tiny timeout.
  for (;;) {
    attempts += 1;
    last = await probePort(port, { timeoutMs: Math.max(500, Math.min(2000, timeoutMs)), host });
    if (last.ok) {
      return { ok: true, probe: last, attempts, waitedMs: Date.now() - started };
    }
    const cancel = typeof isCancelled === 'function' ? isCancelled() : null;
    if (cancel) {
      return { ok: false, cancelled: true, cause: cancel, probe: last, attempts, waitedMs: Date.now() - started };
    }
    if (Date.now() - started + intervalMs >= timeoutMs) {
      return { ok: false, timedOut: true, probe: last, attempts, waitedMs: Date.now() - started };
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Process enumeration
// ---------------------------------------------------------------------------

const PS_LIST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}',
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='AiCoin.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine)",
  "if ($p.Count -eq 0) { '[]' } else { '[' + ((@($p) | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']' }",
].join('; ');

const POSIX_LIST_SCRIPT = 'ps -axo pid=,ppid=,command= | grep -i aicoin';

function execFileAsync(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function runPowerShell(script, timeoutMs) {
  const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe', 'pwsh'] : ['pwsh'];
  const errors = [];
  for (const shell of shells) {
    const res = await execFileAsync(
      shell,
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    );
    if (!res.error && res.stdout.trim()) {
      return { ok: true, shell, stdout: res.stdout };
    }
    const code = res.error && typeof res.error.code === 'number' ? `exit ${res.error.code}` : errMessage(res.error);
    errors.push(`${shell}: ${code}`);
    // A shell that does not exist at all is worth trying the next candidate;
    // anything else is reported so the caller can see why enumeration failed.
  }
  return { ok: false, error: errors.join(' | ') || 'no shell available' };
}

/**
 * Enumerate AiCoin.exe processes and classify them.
 * @returns {Promise<{available:boolean, error?:string, processes:Array,
 *   main?:Array, count:number, shell?:string}>}
 */
export async function listAiCoinProcesses({ timeoutMs = 15000 } = {}) {
  if (process.platform === 'win32') {
    const res = await runPowerShell(PS_LIST_SCRIPT, timeoutMs);
    if (!res.ok) {
      return { available: false, error: res.error, processes: [], main: [], count: 0 };
    }
    let raw;
    try {
      raw = JSON.parse(res.stdout.trim());
    } catch (err) {
      return { available: false, error: `cannot parse process list: ${errMessage(err)}`, processes: [], main: [], count: 0, stdout: res.stdout.slice(0, 300) };
    }
    const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
    const processes = list.map((p) =>
      classifyProcess({
        pid: p.ProcessId,
        ppid: p.ParentProcessId,
        cmdline: p.CommandLine,
      }),
    );
    return {
      available: true,
      shell: res.shell,
      processes,
      main: processes.filter((p) => p.isMain),
      count: processes.length,
    };
  }

  // POSIX (macOS / Linux). The `ps ... | grep -i aicoin` pipeline matches its
  // OWN command line, and those two phantom rows used to be classified as
  // "main" processes: every scan reported 2-3 fake pids that changed on each
  // call, which in turn made launch() believe "AiCoin is already running" and
  // refuse to start. Verified on macOS 2026-10-24. Keep a row only when argv[0]
  // is really the AiCoin binary.
  const res = await execFileAsync('sh', ['-c', POSIX_LIST_SCRIPT], { timeout: timeoutMs, encoding: 'utf8' });
  if (res.error) {
    return { available: false, error: errMessage(res.error), processes: [], main: [], count: 0 };
  }
  const processes = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return classifyProcess({ pid: m?.[1], ppid: m?.[2], cmdline: m?.[3] ?? line });
    })
    .filter((proc) => isAiCoinBinary(proc.argv?.[0] ?? proc.cmdline));
  return {
    available: true,
    shell: 'sh',
    processes,
    main: processes.filter((p) => p.isMain),
    count: processes.length,
  };
}

/**
 * True when the executable in `argv[0]` is the AiCoin binary itself.
 *
 * Deliberately strict: `/bin/sh -c ...`, `grep -i aicoin`, editor windows titled
 * "aicoin" and the DeepSeek Harness process (whose argv contains the aicoin-mcp
 * server path) must all be excluded, otherwise they masquerade as a running
 * AiCoin main process.
 *
 * @param {string} [cmdline]
 * @returns {boolean}
 */
export function isAiCoinBinary(cmdline) {
  if (!cmdline || typeof cmdline !== 'string') return false;
  const first = cmdline.trim().split(/\s+/)[0] ?? '';
  if (!first) return false;
  const base = path.basename(first);
  return /^aicoin(\.exe)?$/i.test(base);
}

/**
 * Dual verdict: CDP probe + process enumeration.
 * `running` is true when either signal fires; `attachReady` only when the
 * debug port answers (i.e. the app can actually be controlled).
 */
export async function isRunning({ port = DEFAULT_PORT } = {}) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const [probe, scan] = await Promise.all([probePort(p, { timeoutMs: 1500 }), listAiCoinProcesses()]);
  const mains = scan.main || [];
  const debugPorts = [...new Set(mains.map((proc) => proc.debugPort).filter((n) => Number.isInteger(n)))];
  const otherDebugPorts = debugPorts.filter((n) => n !== p);
  let verdict;
  if (probe.ok) verdict = debugPorts.includes(p) ? 'attachable' : 'attachable-external';
  else if (mains.length > 0) verdict = debugPorts.length > 0 ? 'running-on-other-port' : 'running-without-debug-port';
  else verdict = 'not-running';
  return {
    port: p,
    verdict,
    portUp: probe.ok,
    running: probe.ok || mains.length > 0,
    attachReady: probe.ok,
    version: probe.browser ?? null,
    userAgent: probe.userAgent ?? null,
    wsUrl: probe.wsUrl ?? null,
    mainPids: mains.map((proc) => proc.pid),
    allPids: (scan.processes || []).map((proc) => proc.pid),
    debugPorts,
    otherDebugPorts,
    userDataDirs: [...new Set(mains.map((proc) => proc.userDataDir).filter(Boolean))],
    processScan: { available: scan.available, error: scan.error, count: scan.count, shell: scan.shell },
    error: probe.error,
  };
}

// ---------------------------------------------------------------------------
// Environment sanitation (HARD-WON FACT #2)
// ---------------------------------------------------------------------------

/**
 * Copy an env object without the variables that turn Electron into Node.
 * Never mutates the input (and never touches process.env).
 */
export function sanitizeEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) continue;
    if (HARMFUL_ENV_PATTERNS.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/** Which harmful variables were present in process.env (for diagnostics). */
export function harmfulEnvPresent(env = process.env) {
  return Object.keys(env || {}).filter((key) => HARMFUL_ENV_PATTERNS.some((re) => re.test(key)));
}

// ---------------------------------------------------------------------------
// Launch state (survives MCP server restarts; lives in %TEMP%)
// ---------------------------------------------------------------------------

export function readLaunchState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { launches: {} };
    if (!raw.launches || typeof raw.launches !== 'object') raw.launches = {};
    return raw;
  } catch {
    return { launches: {} };
  }
}

export function getLaunchRecord(port = DEFAULT_PORT) {
  const state = readLaunchState();
  return state.launches[String(toInt(port) ?? DEFAULT_PORT)] ?? null;
}

/**
 * Same as {@link getLaunchRecord}, but reports a record whose process is gone as
 * stale instead of handing it back as if it still described a live instance.
 *
 * A launch that opened the port and then exited (single-instance handoff, or a
 * sandbox-blocked child) leaves a record pointing at a dead pid; without this
 * check the panel keeps claiming "we own a running instance".
 *
 * @returns {{record:object|null, stale?:boolean, reason?:string}}
 */
export function getLiveLaunchRecord(port = DEFAULT_PORT) {
  const record = getLaunchRecord(port);
  if (!record) return { record: null, reason: 'no-record' };
  const pid = toInt(record.pid);
  if (pid && !isAlive(pid)) {
    return { record, stale: true, reason: `记录里的进程 ${pid} 已不存在` };
  }
  return { record };
}

function writeLaunchState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Record (or overwrite) the launch entry for a port. */
export function recordLaunch({ port = DEFAULT_PORT, pid = null, owned = false, appPath = null, userDataDir = null, version = null } = {}) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const state = readLaunchState();
  state.launches[String(p)] = {
    port: p,
    pid: toInt(pid),
    owned: owned === true,
    appPath,
    userDataDir,
    version,
    launchedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();
  writeLaunchState(state);
  return state.launches[String(p)];
}

export function clearLaunchRecord(port = DEFAULT_PORT) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const state = readLaunchState();
  const had = Boolean(state.launches[String(p)]);
  delete state.launches[String(p)];
  state.updatedAt = new Date().toISOString();
  writeLaunchState(state);
  return had;
}

// ---------------------------------------------------------------------------
// stderr log of the spawned app (diagnosis)
// ---------------------------------------------------------------------------

/** Make a directory exist; returns false when the OS refuses. */
function mkdirp(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function logPathFor(port) {
  const p = toInt(port) ?? DEFAULT_PORT;
  mkdirp(LOG_DIR);
  return path.join(LOG_DIR, `launch-${p}.log`);
}

function readTail(file, maxBytes = 4000) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return '';
    const text = readFileSync(file, 'utf8');
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown over CDP (global WebSocket, Node >= 22)
// ---------------------------------------------------------------------------

/**
 * Ask the browser process to exit via the CDP `Browser.close` command.
 * The browser usually kills the socket before replying, so "socket closed
 * right after send" is a success, not a failure.
 * @returns {Promise<{ok:boolean, sent:boolean, replied?:boolean, viaWebSocket?:boolean, error?:string}>}
 */
export async function cdpBrowserClose({ wsUrl, timeoutMs = 4000 } = {}) {
  if (!wsUrl) return { ok: false, sent: false, error: 'no webSocketDebuggerUrl' };
  if (typeof WebSocket !== 'function') {
    return { ok: false, sent: false, error: 'global WebSocket unavailable (Node < 22)' };
  }
  const started = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    let sent = false;
    let ws;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws && ws.readyState === 1) ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ...result, sent, tookMs: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ ok: sent, replied: false, error: sent ? undefined : 'timeout before send' }), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      finish({ ok: false, error: `cannot open websocket: ${errMessage(err)}` });
      return;
    }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }));
        sent = true;
      } catch (err) {
        finish({ ok: false, error: `send failed: ${errMessage(err)}` });
      }
    });
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg && msg.id === 1) finish({ ok: !msg.error, replied: true, error: msg.error ? JSON.stringify(msg.error) : undefined });
      } catch {
        /* non-JSON frames are not our reply */
      }
    });
    ws.addEventListener('close', () => {
      // Browser.close tears the connection down; that is the expected outcome.
      finish({ ok: true, replied: false, viaWebSocket: true });
    });
    ws.addEventListener('error', () => {
      if (!sent) finish({ ok: false, error: 'websocket error before send' });
    });
  });
}

// ---------------------------------------------------------------------------
// launch()
// ---------------------------------------------------------------------------

function conflictDiagnosis({ mains, port, requestedUserDataDir }) {
  const existingDebugPorts = [...new Set(mains.map((proc) => proc.debugPort).filter((n) => Number.isInteger(n)))];
  const sameProfile = mains.find((proc) => requestedUserDataDir && samePath(proc.userDataDir, requestedUserDataDir));
  const pids = mains.map((proc) => proc.pid);
  const debugHint = existingDebugPorts.length
    ? `现有实例已在端口 ${existingDebugPorts.join(', ')} 上开启调试端口，直接使用该端口即可 / an existing instance already exposes CDP on port ${existingDebugPorts.join(', ')} — just use that port.`
    : '现有实例没有开启调试端口 / the existing instance has no debug port.';
  return {
    reason: 'single-instance-conflict',
    message:
      `AiCoin 已在运行 (pid ${pids.join(', ')})，Electron 单实例锁会阻止新进程打开调试端口 ${port}；` +
      `新进程会立即退出且不会监听端口。${debugHint} ` +
      `处理办法：先关闭现有 AiCoin 再启动，或传入 userDataDir 使用隔离 profile 启动第二个实例。` +
      ` / AiCoin is already running (pid ${pids.join(', ')}); the Electron single-instance lock makes the new ` +
      `process exit immediately without opening port ${port}. ${debugHint} Fix: close AiCoin first, or pass ` +
      `userDataDir to start an isolated second instance (separate --user-data-dir bypasses the lock).`,
    // CDP can only be turned on at process start: a running AiCoin can never be
    // attached afterwards. State that once, in machine-readable form, so callers
    // (agent or panel) stop guessing and take the one action that works.
    nextAction: {
      tool: 'aicoin_app_restart',
      args: { port, force: true },
      summary: `以调试端口 ${port} 重启 AiCoin（会关闭当前窗口）`,
      note: 'Electron 的 CDP 只能在进程启动时开启，事后无法附加到已在运行的窗口。',
    },
    runningPids: pids,
    existingDebugPorts,
    sameProfilePid: sameProfile ? sameProfile.pid : null,
    requestedUserDataDir: requestedUserDataDir ?? null,
  };
}

/**
 * Launch AiCoin.exe with a CDP debug port and wait until it is attachable.
 *
 * @param {object} opts
 * @param {number} [opts.port=9222]          debug port to open
 * @param {string} [opts.appPath]            AiCoin.exe path (else config/env/default)
 * @param {object} [opts.config]             MCP config (appPath/appExe override)
 * @param {number} [opts.waitMs=30000]       how long to wait for the port
 * @param {string[]} [opts.args=[]]          extra Electron switches
 * @param {string} [opts.userDataDir]        isolated Chromium profile dir (bypasses single-instance lock)
 * @param {object} [opts.env]                base env (default process.env; always sanitized)
 * @param {Function} [opts.log]              logger
 * @returns {Promise<object>} {ok, reused, pid, port, version, wsUrl, reason?, message?, ...}
 */
export async function launch({
  port = DEFAULT_PORT,
  appPath,
  config,
  waitMs = 30000,
  args = [],
  userDataDir,
  env,
  log,
} = {}) {
  const started = Date.now();
  const p = toInt(port) ?? DEFAULT_PORT;
  const app = findAppPath({ appPath, config });

  if (!app.exists) {
    return {
      ok: false,
      port: p,
      reused: false,
      reason: 'app-not-found',
      appPath: app.path,
      appPathSource: app.source,
      tried: app.tried,
      message:
        `找不到 AiCoin.exe: ${app.path} (来源 ${app.source})。可传入 appPath 或设置 AICOIN_APP_PATH。` +
        ` / AiCoin.exe not found at ${app.path} (source ${app.source}). Pass appPath or set AICOIN_APP_PATH.`,
      tookMs: Date.now() - started,
    };
  }

  // 1) Already attachable -> reuse, never spawn a doomed second instance.
  const pre = await probePort(p, { timeoutMs: 1500 });
  if (pre.ok) {
    const scan = await listAiCoinProcesses();
    const mains = scan.main || [];
    const owner = mains.find((proc) => proc.debugPort === p);
    safeLog(log, 'info', `[launcher] port ${p} already attachable, reusing pid ${owner?.pid ?? 'unknown'}`);
    recordLaunch({ port: p, pid: owner ? owner.pid : null, owned: false, appPath: app.path, version: pre.browser });
    return {
      ok: true,
      reused: true,
      alreadyRunning: true,
      port: p,
      pid: owner ? owner.pid : null,
      appPath: app.path,
      appPathSource: app.source,
      version: pre.browser,
      protocolVersion: pre.protocolVersion,
      userAgent: pre.userAgent,
      wsUrl: pre.wsUrl,
      mainPids: mains.map((proc) => proc.pid),
      debugPorts: [...new Set(mains.map((proc) => proc.debugPort).filter((n) => Number.isInteger(n)))],
      tookMs: Date.now() - started,
      message: `端口 ${p} 已可连接，复用现有实例 / port ${p} is already attachable, reused the running instance.`,
    };
  }

  // 2) Single-instance pre-check: a live AiCoin whose profile matches the one we
  //    are about to open will swallow our launch and never expose the port.
  const scan = await listAiCoinProcesses();
  const mains = scan.main || [];
  let conflict = null;
  if (mains.length > 0) {
    const sameProfile = userDataDir
      ? mains.find((proc) => proc.userDataDir && samePath(proc.userDataDir, userDataDir))
      : null;
    if (userDataDir && sameProfile) {
      conflict = conflictDiagnosis({ mains, port: p, requestedUserDataDir: userDataDir });
      conflict.message =
        `userDataDir 已被现有实例使用 (pid ${sameProfile.pid})，同一 profile 的单实例锁仍会阻止启动。` +
        ` / userDataDir is already in use by pid ${sameProfile.pid}; the per-profile singleton lock still applies.`;
    } else if (!userDataDir) {
      conflict = conflictDiagnosis({ mains, port: p, requestedUserDataDir: null });
    }
  }
  if (conflict) {
    safeLog(log, 'warn', `[launcher] refusing to launch: ${conflict.reason} (${conflict.runningPids.join(', ')})`);
    return {
      ok: false,
      port: p,
      reused: false,
      appPath: app.path,
      appPathSource: app.source,
      ...conflict,
      processScan: { available: scan.available, error: scan.error },
      tookMs: Date.now() - started,
    };
  }

  // 3) Spawn detached, with a sanitized env and stderr captured to a log file.
  const logPath = logPathFor(p);
  let fd = null;
  try {
    fd = openSync(logPath, 'a');
  } catch {
    fd = 'ignore';
  }
  const childEnv = sanitizeEnv(env ?? process.env);
  const spawnArgs = [`--remote-debugging-port=${p}`];
  if (userDataDir) spawnArgs.push(`--user-data-dir=${userDataDir}`);
  for (const a of args) if (a) spawnArgs.push(String(a));

  safeLog(log, 'info', `[launcher] spawning ${app.path} ${spawnArgs.join(' ')}`);

  let child;
  let spawnError = null;
  let exitInfo = null;
  try {
    child = spawn(app.path, spawnArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', fd],
      env: childEnv,
      cwd: path.dirname(app.path),
      windowsHide: true,
    });
  } catch (err) {
    spawnError = errMessage(err);
    if (typeof fd === 'number') {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      port: p,
      reused: false,
      reason: 'spawn-failed',
      appPath: app.path,
      error: spawnError,
      message: `启动进程失败 / failed to spawn: ${spawnError}`,
      tookMs: Date.now() - started,
    };
  }
  if (typeof fd === 'number') {
    try {
      closeSync(fd);
    } catch {
      /* the child owns the handle now */
    }
  }

  child.on('error', (err) => {
    spawnError = errMessage(err);
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, at: Date.now() };
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const pid = child.pid ?? null;
  // Document how the env was sanitized in the result, so a future reader can see
  // the ELECTRON_RUN_AS_NODE trap was handled instead of rediscovering it.
  const stripped = harmfulEnvPresent(env ?? process.env);

  // 4) Wait for the debug port, aborting early when the app exits.
  const wait = await waitForPort(p, {
    timeoutMs: Math.max(1000, waitMs),
    intervalMs: 300,
    isCancelled: () => (spawnError ? `spawn-error: ${spawnError}` : exitInfo ? `process-exited: ${JSON.stringify(exitInfo)}` : null),
  });

  if (wait.ok) {
    // Cross-check against the process table (best effort, verdict only).
    let verification = null;
    try {
      const post = await listAiCoinProcesses({ timeoutMs: 8000 });
      const owner = (post.main || []).find((proc) => proc.debugPort === p);
      verification = {
        available: post.available,
        pidOnPort: owner ? owner.pid : null,
        matchesSpawnedPid: owner && pid ? owner.pid === pid : null,
        mainPids: (post.main || []).map((proc) => proc.pid),
      };
    } catch (err) {
      verification = { available: false, error: errMessage(err) };
    }
    // A port that answers is NOT proof of a usable instance: Electron binds the
    // DevTools socket very early and then exits when the single-instance lock
    // hands off to an already running app. Verified on macOS 2026-10-24: pid
    // 15136 opened 9222, wrote "DevTools listening", and died ~1s later — yet
    // this function reported ok:true. Settle first, then require the port to
    // still answer *and* the spawned process to still be alive.
    const settle = await confirmStable({ port: p, pid });
    if (!settle.ok) {
      const now = await listAiCoinProcesses();
      const nowMains = now.main || [];
      const conflictNow = nowMains.length > 0
        ? conflictDiagnosis({ mains: nowMains, port: p, requestedUserDataDir: userDataDir })
        : null;
      const tail = readTail(logPath);
      return {
        ok: false,
        port: p,
        reused: false,
        reason: conflictNow ? 'single-instance-conflict' : 'exited-after-port-open',
        ...(conflictNow ?? {}),
        appPath: app.path,
        appPathSource: app.source,
        spawnedPid: pid,
        exitInfo,
        logPath,
        stderrTail: tail,
        stability: settle,
        message: conflictNow
          ? `调试端口 ${p} 一度打开，但新进程随即退出（Electron 单实例锁把窗口交给了已在运行的 AiCoin）。` +
            ` ${conflictNow.message}`
          : `调试端口 ${p} 一度打开，但进程随后退出（exitInfo=${JSON.stringify(exitInfo)}）。查看 stderrTail / logPath；` +
            `若 stderr 里出现 "Operation not permitted"，说明启动环境被沙箱限制，不是 AiCoin 的问题。`,
        tookMs: Date.now() - started,
      };
    }

    recordLaunch({ port: p, pid: pid ?? verification?.pidOnPort ?? null, owned: true, appPath: app.path, userDataDir: userDataDir ?? null, version: wait.probe.browser });
    const result = {
      ok: true,
      reused: false,
      alreadyRunning: false,
      port: p,
      pid: verification?.pidOnPort ?? pid,
      spawnedPid: pid,
      appPath: app.path,
      appPathSource: app.source,
      userDataDir: userDataDir ?? null,
      version: wait.probe.browser,
      protocolVersion: wait.probe.protocolVersion,
      userAgent: wait.probe.userAgent,
      wsUrl: wait.probe.wsUrl,
      attempts: wait.attempts,
      waitedMs: wait.waitedMs,
      logPath,
      envSanitized: { strippedVariables: stripped, note: 'ELECTRON_RUN_AS_NODE must never reach AiCoin.exe' },
      processVerification: verification,
      tookMs: Date.now() - started,
      message:
        `AiCoin 已启动并可在端口 ${p} 上控制 / AiCoin launched, CDP attachable on port ${p}.`,
    };
    safeLog(log, 'info', `[launcher] launched pid ${result.pid} on port ${p} in ${wait.waitedMs}ms`);
    return result;
  }

  // 5) Failure: diagnose instead of guessing.
  const stderrTail = readTail(logPath);
  const base = {
    ok: false,
    port: p,
    reused: false,
    appPath: app.path,
    appPathSource: app.source,
    spawnedPid: pid,
    exitInfo,
    spawnError,
    attempts: wait.attempts,
    waitedMs: wait.waitedMs,
    logPath,
    stderrTail,
  };

  if (/bad option:\s*--remote-debugging-port/i.test(stderrTail)) {
    return {
      ...base,
      reason: 'electron-run-as-node',
      message:
        'AiCoin.exe 以 Node 模式启动（ELECTRON_RUN_AS_NODE 泄漏）并拒绝 --remote-debugging-port。' +
        '启动环境已强制清除该变量；若仍出现，说明有包装脚本重新注入。' +
        ' / AiCoin.exe started in Node mode (ELECTRON_RUN_AS_NODE leaked) and rejected --remote-debugging-port.',
      tookMs: Date.now() - started,
    };
  }
  if (exitInfo && (exitInfo.code === 0 || exitInfo.code === null)) {
    const now = await listAiCoinProcesses();
    const nowMains = now.main || [];
    if (nowMains.length > 0) {
      const conflictNow = conflictDiagnosis({ mains: nowMains, port: p, requestedUserDataDir: userDataDir });
      return {
        ...base,
        ...conflictNow,
        message:
          `进程在 ~${wait.waitedMs}ms 内退出 (code ${exitInfo.code})，端口 ${p} 未打开：这是 Electron 单实例锁的表现。` +
          ` ${conflictNow.message}`,
        tookMs: Date.now() - started,
      };
    }
  }

  return {
    ...base,
    reason: wait.cancelled ? 'process-exited' : 'port-timeout',
    message: wait.cancelled
      ? `进程在端口就绪前退出 (${wait.cause ?? 'unknown'})。查看 stderrTail / logPath 定位原因。` +
        ` / the process exited before the CDP port became ready.`
      : `等待 ${wait.waitedMs}ms 后端口 ${p} 仍未就绪。查看 stderrTail / logPath 定位原因。` +
        ` / port ${p} was not ready after ${wait.waitedMs}ms; inspect stderrTail / logPath.`,
    tookMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// ensureRunning() / also aliased: ensure
// ---------------------------------------------------------------------------

/**
 * Reuse an attachable instance, otherwise launch one.
 * @returns {Promise<object>} launch-shaped result with `reused` flag
 */
export async function ensureRunning({ port = DEFAULT_PORT, appPath, config, waitMs = 30000, userDataDir, log } = {}) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const pre = await probePort(p, { timeoutMs: 1500 });
  if (pre.ok) {
    const diag = await isRunning({ port: p });
    // Pick the main process that actually owns this port; mainPids[0] may be a
    // different AiCoin instance (e.g. the user's logged-in 9222 window).
    const scan = await listAiCoinProcesses();
    const owner = (scan.main || []).find((proc) => proc.debugPort === p);
    const pid = owner ? owner.pid : diag.mainPids[0] ?? null;
    recordLaunch({ port: p, pid, owned: false, appPath: findAppPath({ appPath, config }).path, version: pre.browser });
    return {
      ok: true,
      reused: true,
      port: p,
      pid,
      version: pre.browser,
      userAgent: pre.userAgent,
      wsUrl: pre.wsUrl,
      mainPids: diag.mainPids,
      debugPorts: diag.debugPorts,
      verdict: diag.verdict,
      message: `复用已在端口 ${p} 上运行的实例 / reused the instance already listening on port ${p}.`,
    };
  }
  const launched = await launch({ port: p, appPath, config, waitMs, userDataDir, log });
  return launched;
}

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

function taskkill(pid) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, error: error ? errMessage(error) : null, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
      });
    });
  }
  // macOS / Linux have no `taskkill`; `spawn ENOENT` used to make stop/restart
  // fail unconditionally. SIGTERM first, escalate to SIGKILL only if it survives
  // (or refuses to release the port).
  return new Promise((resolve) => {
    execFile('kill', ['-TERM', String(pid)], { timeout: 15000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, error: null, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
        return;
      }
      execFile('kill', ['-KILL', String(pid)], { timeout: 15000 }, (error2, stdout2, stderr2) => {
        resolve({
          ok: !error2,
          error: error2 ? errMessage(error2) : `SIGTERM failed (${errMessage(error)}), used SIGKILL`,
          stdout: String(stdout2 ?? '').trim(),
          stderr: String(stderr2 ?? '').trim(),
        });
      });
    });
  });
}

async function waitGone({ port, pid, timeoutMs = 5000, intervalMs = 250 }) {
  const started = Date.now();
  for (;;) {
    const [probe, alive] = await Promise.all([
      probePort(port, { timeoutMs: 800 }),
      Promise.resolve(pid ? isAlive(pid) : false),
    ]);
    if (!probe.ok && !alive) return { gone: true, waitedMs: Date.now() - started, portUp: false, pidAlive: false };
    if (Date.now() - started + intervalMs >= timeoutMs) {
      return { gone: false, waitedMs: Date.now() - started, portUp: probe.ok, pidAlive: alive };
    }
    await sleep(intervalMs);
  }
}

/**
 * Stop the AiCoin instance that serves `port`.
 *
 * Ownership rules (deliberately conservative):
 *  - a pid we recorded at launch  -> stop it;
 *  - the main process whose --remote-debugging-port equals `port` -> stop it;
 *  - anything else (an instance a human started, e.g. the Lead's 9222 window)
 *    requires `force: true`, otherwise we refuse with reason 'not-owned'.
 *
 * @param {object} opts
 * @param {number} [opts.port=9222]
 * @param {number} [opts.pid]            explicit pid (must still be an AiCoin process)
 * @param {number} [opts.gracefulMs=8000] time allowed for Browser.close
 * @param {boolean} [opts.force=false]
 * @param {boolean} [opts.dryRun=false]
 */
export async function stop({ port = DEFAULT_PORT, pid, gracefulMs = 8000, force = false, dryRun = false, log } = {}) {
  const started = Date.now();
  const p = toInt(port) ?? DEFAULT_PORT;
  const probeBefore = await probePort(p, { timeoutMs: 1500 });
  const scan = await listAiCoinProcesses();
  const mains = scan.main || [];
  const record = getLaunchRecord(p);
  const explicitPid = toInt(pid);

  let targetPid = null;
  let ownership = null;
  const knownPids = new Set((scan.processes || []).map((proc) => proc.pid));

  if (explicitPid) {
    if (!knownPids.has(explicitPid)) {
      return {
        ok: false,
        port: p,
        reason: 'pid-not-found',
        message: `pid ${explicitPid} 不是正在运行的 AiCoin 进程 / pid ${explicitPid} is not a running AiCoin process.`,
        candidatePids: [...knownPids],
        tookMs: Date.now() - started,
      };
    }
    targetPid = explicitPid;
    ownership = 'explicit';
  } else if (record && record.owned === true && record.pid && knownPids.has(record.pid)) {
    targetPid = record.pid;
    ownership = 'recorded';
  } else {
    const byPort = mains.find((proc) => proc.debugPort === p);
    if (byPort) {
      targetPid = byPort.pid;
      ownership = 'debug-port-match';
    } else if (force && mains.length > 0) {
      targetPid = mains[0].pid;
      ownership = 'forced';
    }
  }

  const diag = {
    port: p,
    portUp: probeBefore.ok,
    version: probeBefore.browser ?? null,
    mainPids: mains.map((proc) => proc.pid),
    debugPorts: [...new Set(mains.map((proc) => proc.debugPort).filter((n) => Number.isInteger(n)))],
    record,
    processScan: { available: scan.available, error: scan.error },
  };

  if (!targetPid) {
    if (!probeBefore.ok && mains.length === 0) {
      clearLaunchRecord(p);
      return {
        ...diag,
        ok: true,
        alreadyStopped: true,
        port: p,
        stoppedPids: [],
        method: 'none',
        portUp: false,
        message: `端口 ${p} 上没有可控制的 AiCoin，且没有 AiCoin 进程，无需操作 / nothing to stop.`,
        tookMs: Date.now() - started,
      };
    }
    if (!probeBefore.ok && diag.debugPorts.length === 0) {
      // A user-started AiCoin with no debug port at all: CDP cannot reach it.
      return {
        ...diag,
        ok: false,
        port: p,
        reason: 'no-debug-port',
        message:
          `AiCoin 在运行 (pid ${diag.mainPids.join(', ')}) 但没有开启任何调试端口，无法通过 CDP 关闭，` +
          `且该实例不是本服务启动的。传入 force=true 可强制结束，或手动关闭 AiCoin。` +
          ` / AiCoin is running without any debug port; it was not started by this server. Pass force=true to terminate it.`,
        tookMs: Date.now() - started,
      };
    }
    if (!probeBefore.ok) {
      // Nothing serves the requested port; other instances live on other ports.
      // Leave them alone and say so explicitly.
      clearLaunchRecord(p);
      return {
        ...diag,
        ok: true,
        alreadyStopped: true,
        port: p,
        stoppedPids: [],
        method: 'none',
        portUp: false,
        otherDebugPorts: diag.debugPorts,
        message:
          `端口 ${p} 上没有实例，无需停止；其它实例在端口 ${diag.debugPorts.join(', ')} 上运行，未被触碰。` +
          ` / Nothing listens on port ${p}; other instances on port ${diag.debugPorts.join(', ')} were left untouched.`,
        tookMs: Date.now() - started,
      };
    }
    return {
      ...diag,
      ok: false,
      port: p,
      reason: 'not-owned',
      message:
        `端口 ${p} 可连接，但该实例不是本服务启动的（外部手动启动）。为避免误杀用户正在使用的窗口，` +
        `默认不结束它；确认要停止请传 force=true（或 pid）。` +
        ` / Port ${p} is attachable but the instance was not launched by this server; pass force=true to stop it anyway.`,
      tookMs: Date.now() - started,
    };
  }

  const plan = {
    targetPid,
    ownership,
    gracefulMs,
    strategy: probeBefore.ok ? 'Browser.close -> taskkill fallback' : 'taskkill',
  };
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      port: p,
      wouldStop: targetPid,
      ownership,
      ...diag,
      plan,
      message: `dryRun：将结束 pid ${targetPid} (${ownership}) / would stop pid ${targetPid}.`,
      tookMs: Date.now() - started,
    };
  }

  // Step 1: graceful Browser.close over CDP.
  let browserClose = null;
  let method = 'none';
  if (probeBefore.ok && probeBefore.wsUrl) {
    browserClose = await cdpBrowserClose({ wsUrl: probeBefore.wsUrl, timeoutMs: Math.min(gracefulMs, 4000) });
    if (browserClose.sent) method = 'browser.close';
    safeLog(log, browserClose.ok ? 'info' : 'warn', `[launcher] Browser.close sent=${browserClose.sent} replied=${browserClose.replied} err=${browserClose.error ?? 'none'}`);
  }

  let gone = await waitGone({ port: p, pid: targetPid, timeoutMs: gracefulMs, intervalMs: 250 });
  let kill = null;

  // Step 2: process fallback.
  if (!gone.gone) {
    kill = await taskkill(targetPid);
    method = method === 'browser.close' ? 'browser.close+taskkill' : 'taskkill';
    gone = await waitGone({ port: p, pid: targetPid, timeoutMs: 5000, intervalMs: 250 });
  }

  clearLaunchRecord(p);
  const ok = gone.gone;
  const result = {
    ...diag,
    ok,
    port: p,
    stoppedPids: gone.gone ? [targetPid] : [],
    targetPid,
    ownership,
    method,
    browserClose,
    taskkill: kill,
    portUp: gone.portUp,
    processAlive: gone.pidAlive,
    waitedMs: gone.waitedMs,
    message: ok
      ? `已停止端口 ${p} 上的 AiCoin (pid ${targetPid}, ${method}) / stopped AiCoin pid ${targetPid}.`
      : `停止失败：pid ${targetPid} 仍存活或端口 ${p} 仍可连接 / stop failed for pid ${targetPid}.`,
    tookMs: Date.now() - started,
  };
  safeLog(log, ok ? 'info' : 'error', `[launcher] stop port ${p} -> ${ok ? 'stopped' : 'failed'} (${method})`);
  return result;
}

// ---------------------------------------------------------------------------
// restart()
// ---------------------------------------------------------------------------

/**
 * Stop whatever serves `port` (respecting the ownership rules of stop(), or
 * `force`), then launch a fresh debug-enabled instance.
 */
export async function restart({ port = DEFAULT_PORT, appPath, config, waitMs = 30000, gracefulMs = 8000, force = false, userDataDir, log } = {}) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const stopped = await stop({ port: p, gracefulMs, force, log });
  if (!stopped.ok && stopped.reason === 'not-owned') {
    return {
      ok: false,
      port: p,
      reason: 'not-owned',
      stop: stopped,
      launch: null,
      message: stopped.message,
      tookMs: stopped.tookMs,
    };
  }
  const launched = await launch({ port: p, appPath, config, waitMs, userDataDir, log });
  return {
    ok: launched.ok,
    port: p,
    stop: stopped,
    launch: launched,
    pid: launched.pid ?? null,
    version: launched.version ?? null,
    message: launched.ok
      ? `已重启端口 ${p} 上的 AiCoin / restarted AiCoin on port ${p}.`
      : `重启失败：${launched.message ?? 'unknown'} / restart failed.`,
    tookMs: stopped.tookMs + launched.tookMs,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics snapshot (used by aicoin_status / aicoin_launch tool results)
// ---------------------------------------------------------------------------

/** One-call diagnostic: probe + process table + launch record. */
export async function diagnose({ port = DEFAULT_PORT, appPath, config } = {}) {
  const p = toInt(port) ?? DEFAULT_PORT;
  const app = findAppPath({ appPath, config });
  const [probe, scan] = await Promise.all([probePort(p, { timeoutMs: 1500 }), listAiCoinProcesses()]);
  const mains = scan.main || [];
  return {
    port: p,
    appPath: app.path,
    appPathExists: app.exists,
    appPathSource: app.source,
    portUp: probe.ok,
    version: probe.browser ?? null,
    userAgent: probe.userAgent ?? null,
    wsUrl: probe.wsUrl ?? null,
    verdict: probe.ok ? 'attachable' : mains.length ? 'running-without-debug-port' : 'not-running',
    mainProcesses: mains.map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      debugPort: proc.debugPort,
      userDataDir: proc.userDataDir,
      cmdline: proc.cmdline,
    })),
    aiCoinProcessCount: scan.count,
    processScan: { available: scan.available, error: scan.error, shell: scan.shell },
    launchRecord: getLaunchRecord(p),
  };
}

export default {
  DEFAULT_APP_PATH,
  DEFAULT_PORT,
  CDP_HOST,
  findAppPath,
  probePort,
  httpGetJson,
  listTargets,
  waitForPort,
  parseCommandLine,
  classifyProcess,
  listAiCoinProcesses,
  isRunning,
  isAlive,
  sanitizeEnv,
  harmfulEnvPresent,
  cdpBrowserClose,
  launch,
  ensureRunning,
  stop,
  restart,
  diagnose,
  readLaunchState,
  getLaunchRecord,
  recordLaunch,
  clearLaunchRecord,
};
