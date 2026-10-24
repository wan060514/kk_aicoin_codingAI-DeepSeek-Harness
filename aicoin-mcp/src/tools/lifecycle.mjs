/**
 * tools/lifecycle.mjs — AiCoin 客户端进程生命周期工具。
 *
 * 工具名统一用 `aicoin_app_` 前缀（同一台机器上还装了 kk_aicoin_codingAI 插件，
 * 它已经注册了一批 `aicoin_*` 工具；我们再叫 `aicoin_launch` 之类会撞车）。
 *
 * 三个工具都是 mutating（会创建/结束真实进程）：
 *   aicoin_app_launch    启动带 --remote-debugging-port 的 AiCoin（已在跑且可连则复用）
 *   aicoin_app_stop      结束指定端口上的 AiCoin（Browser.close 优先，taskkill 兜底）
 *   aicoin_app_restart   先 stop 再 launch
 *
 * 真正的实现全部在 ../launcher.mjs；这里只做参数规范化 + 结果包装。
 * 关键坑见 launcher.mjs 顶部注释：ELECTRON_RUN_AS_NODE 必须清掉、单实例锁会让
 * 新进程静默退出、隔离 profile 用 --user-data-dir 绕过单实例锁。
 */

import path from 'node:path';

import {
  launch,
  stop,
  restart,
  probePort,
  findAppPath,
  listAiCoinProcesses,
  DEFAULT_PORT,
  DEFAULT_USER_DATA_DIR,
} from '../launcher.mjs';

/** 端口参数规范化：args.port > ctx.port > 默认 9222。 */
function resolvePort(args, ctx) {
  const candidates = [args?.port, ctx?.port, DEFAULT_PORT];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

/** ctx.log 可能是函数或对象；安全取出。 */
function loggerOf(ctx) {
  return typeof ctx?.log === 'function' ? ctx.log : null;
}

/** ctx.appPath 可能为 null；只有非空字符串才作为覆盖。 */
function appPathOf(args, ctx) {
  if (typeof args?.appPath === 'string' && args.appPath.trim()) return args.appPath.trim();
  if (typeof ctx?.appPath === 'string' && ctx.appPath.trim()) return ctx.appPath.trim();
  return undefined;
}

/** 路径比较（Windows 语义：大小写不敏感、忽略结尾分隔符）。 */
function normalizePath(value) {
  if (!value) return '';
  try {
    return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

/**
 * force 模式要结束「到底是谁挡住了启动」，而不是随便挑一个 AiCoin。
 * 优先级：
 *   1. 本次请求的 userDataDir 对应的实例（同 profile 的单实例锁）；
 *   2. 默认 profile 的实例（不带 userDataDir 启动时真正的阻挡者）；
 *   3. 第一个主进程（兜底）。
 */
async function pickBlockingPid({ result, userDataDir }) {
  if (Number.isInteger(result?.sameProfilePid)) return { pid: result.sameProfilePid, why: 'same-profile' };
  const scan = await listAiCoinProcesses();
  const mains = scan.main || [];
  if (mains.length === 0) return { pid: null, why: 'no-main-process' };
  if (userDataDir) {
    const same = mains.find((m) => m.userDataDir && normalizePath(m.userDataDir) === normalizePath(userDataDir));
    if (same) return { pid: same.pid, why: 'same-profile-scan' };
  }
  const defaultProfile = mains.find(
    (m) => !m.userDataDir || normalizePath(m.userDataDir) === normalizePath(DEFAULT_USER_DATA_DIR),
  );
  if (defaultProfile) return { pid: defaultProfile.pid, why: 'default-profile' };
  return { pid: mains[0].pid, why: 'first-main' };
}

const PORT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 65535,
  description: 'CDP 调试端口，默认取服务器配置（9222）。Debug port; defaults to the configured port (9222).',
};

export const tools = [
  {
    name: 'aicoin_app_launch',
    title: '启动 AiCoin（带调试端口）',
    description:
      '启动 AiCoin.exe 并让它开启 CDP 调试端口。若端口已可连接则直接复用，不会重复启动。' +
      '会自动清除会破坏启动的 ELECTRON_RUN_AS_NODE 环境变量；若检测到 AiCoin 已在运行（Electron 单实例锁会让新进程静默退出），' +
      '会返回 single-instance-conflict 诊断而不是假装成功；传 force=true 会先结束现有实例，' +
      '或传 userDataDir 用隔离 profile 启动第二个实例（不影响用户已登录的窗口）。' +
      ' / Launch AiCoin.exe with a CDP debug port. Reuses an attachable instance; strips ELECTRON_RUN_AS_NODE; ' +
      'diagnoses the Electron single-instance lock instead of faking success; force=true stops the existing instance first.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
        appPath: {
          type: 'string',
          description: 'AiCoin.exe 的路径，默认 D:\\Program Files\\AiCoin\\AiCoin.exe 或 AICOIN_APP_PATH。 / Path to AiCoin.exe.',
        },
        waitMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: '等待调试端口就绪的最长时间（毫秒），默认 30000。 / Max wait for the port, default 30000 ms.',
        },
        userDataDir: {
          type: 'string',
          description:
            '隔离的 Chromium 用户目录（--user-data-dir），用于在用户已登录的实例之外再启动一个可调试实例。' +
            ' / Isolated Chromium profile dir; bypasses the single-instance lock.',
        },
        force: {
          type: 'boolean',
          description:
            '遇到 single-instance-conflict 时先结束现有 AiCoin 实例再启动（会关掉用户正在用的窗口，磁盘数据不受影响）。' +
            ' / On single-instance conflict, stop the running instance first.',
        },
        gracefulMs: {
          type: 'integer',
          minimum: 500,
          maximum: 60000,
          description: 'force 结束现有实例时给 Browser.close 的宽限时间，默认 8000。 / Grace period for the forced stop.',
        },
      },
      additionalProperties: false,
    },
    mutating: true,
    readOnly: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const appPath = appPathOf(args, ctx);
      const log = loggerOf(ctx);
      const common = { port, appPath, waitMs: args.waitMs, userDataDir: args.userDataDir, log };

      let result = await launch(common);

      // force: 把「被单实例锁挡住」变成「先释放再启动」，但必须明确记录做了这件事。
      if (!result.ok && args.force === true && result.reason === 'single-instance-conflict') {
        const blockedPids = Array.isArray(result.runningPids) ? result.runningPids : [];
        const blocker = await pickBlockingPid({ result, userDataDir: args.userDataDir });
        const freed = blocker.pid
          ? await stop({ port, pid: blocker.pid, gracefulMs: args.gracefulMs, force: true, log })
          : { ok: false, reason: 'no-blocker', message: '找不到阻挡启动的 AiCoin 主进程 / no blocking main process found' };
        if (freed.ok) {
          const again = await launch(common);
          result = {
            ...again,
            forcedStop: {
              requested: true,
              blockedPids,
              blockerPid: blocker.pid,
              blockerReason: blocker.why,
              ok: freed.ok,
              method: freed.method,
              stoppedPids: freed.stoppedPids,
              message: freed.message,
            },
          };
        } else {
          result = {
            ...result,
            forcedStop: {
              requested: true,
              blockedPids,
              blockerPid: blocker.pid ?? null,
              blockerReason: blocker.why,
              ok: false,
              reason: freed.reason,
              message: freed.message,
            },
            message: `${result.message}\n[force] 结束现有实例失败 / failed to stop the blocking instance: ${freed.message}`,
          };
        }
      }

      return {
        ...result,
        tool: 'aicoin_app_launch',
        appPathResolved: result.appPath ?? findAppPath({ appPath }).path,
      };
    },
  },

  {
    name: 'aicoin_app_stop',
    title: '结束 AiCoin',
    description:
      '结束服务在指定端口上的 AiCoin 实例：先走 CDP Browser.close 优雅退出，超时再用 taskkill 结束进程树，并验证端口确实已关闭。' +
      '只处理「本服务启动过（有记录）」或「该主进程的调试端口正好等于请求端口」的实例；' +
      '外部手动启动的实例需要 force=true 才会结束，避免误杀用户正在使用的窗口。' +
      ' / Stop the AiCoin instance serving the given port: graceful Browser.close, then taskkill fallback, then verify the port is closed. ' +
      'Instances started outside this server require force=true.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
        pid: {
          type: 'integer',
          minimum: 1,
          description: '直接指定要结束的 AiCoin 进程 pid（必须是正在运行的 AiCoin 进程）。 / Explicit pid to stop.',
        },
        gracefulMs: {
          type: 'integer',
          minimum: 500,
          maximum: 60000,
          description: 'Browser.close 之后等待进程退出的宽限时间（毫秒），默认 8000。 / Grace period before taskkill.',
        },
        force: {
          type: 'boolean',
          description: '允许结束非本服务启动的实例（例如用户手动开的窗口）。 / Allow stopping an instance this server did not launch.',
        },
        dryRun: {
          type: 'boolean',
          description: '只报告将结束哪个 pid，不真的结束。 / Report what would be stopped without doing it.',
        },
      },
      additionalProperties: false,
    },
    mutating: true,
    readOnly: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const result = await stop({
        port,
        pid: args.pid,
        gracefulMs: args.gracefulMs,
        force: args.force === true,
        dryRun: args.dryRun === true,
        log: loggerOf(ctx),
      });
      return { ...result, tool: 'aicoin_app_stop' };
    },
  },

  {
    name: 'aicoin_app_restart',
    title: '重启 AiCoin（带调试端口）',
    description:
      '先结束指定端口上的 AiCoin，再以调试端口重新启动。用于把「用户手动打开、没有调试端口」的 AiCoin 换成可被 MCP 控制的实例：' +
      '这种情形需要 force=true 才会结束那个外部实例。' +
      ' / Stop AiCoin on the port, then relaunch it with a debug port. Use force=true when the running instance was not started by this server.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
        appPath: {
          type: 'string',
          description: 'AiCoin.exe 的路径，默认自动定位。 / Path to AiCoin.exe.',
        },
        force: {
          type: 'boolean',
          description: '允许结束非本服务启动的实例。 / Allow stopping an instance this server did not launch.',
        },
        waitMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: '等待调试端口就绪的最长时间（毫秒），默认 30000。 / Max wait for the port.',
        },
        gracefulMs: {
          type: 'integer',
          minimum: 500,
          maximum: 60000,
          description: '停止阶段的宽限时间，默认 8000。 / Grace period for the stop phase.',
        },
        userDataDir: {
          type: 'string',
          description: '隔离的 Chromium 用户目录，透传给启动阶段。 / Isolated profile dir for the launch phase.',
        },
      },
      additionalProperties: false,
    },
    mutating: true,
    readOnly: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const result = await restart({
        port,
        appPath: appPathOf(args, ctx),
        waitMs: args.waitMs,
        gracefulMs: args.gracefulMs,
        force: args.force === true,
        userDataDir: args.userDataDir,
        log: loggerOf(ctx),
      });
      return { ...result, tool: 'aicoin_app_restart' };
    },
  },

  {
    // 「为什么没通过 aicoin mcp 打开就连不通」的正面回答：CDP 只能在进程启动时
    // 通过 --remote-debugging-port 开启，事后无法附加。所以本工具把「连上」这件
    // 事收敛成一次调用：能连就复用，没端口就（经允许）重启成有端口的，没开就直接开。
    name: 'aicoin_app_connect',
    title: '连上 AiCoin（必要时以调试模式重启）',
    description:
      '一步把 AiCoin 变成可控制状态：端口已可连则直接复用；AiCoin 已开但没有调试端口时（CDP 无法事后附加），' +
      'allowRestart=true 会以调试端口重启它（会关闭当前窗口），否则只返回 needs-restart 和下一步动作；' +
      'AiCoin 没开则直接带调试端口启动。遇到「所有 aicoin_app_* 工具都连不通」时先调它。' +
      ' / One-shot "make AiCoin controllable": reuse an attachable port, otherwise (allowRestart) restart it with a debug port, or start it.',
    inputSchema: {
      type: 'object',
      properties: {
        port: PORT_SCHEMA,
        appPath: {
          type: 'string',
          description: 'AiCoin 可执行文件路径（macOS 也接受 .app 包路径），默认自动定位。 / Executable path; macOS .app bundles are accepted.',
        },
        allowRestart: {
          type: 'boolean',
          description:
            '允许结束「正在运行但没开调试端口」的 AiCoin，再以调试端口启动（会关闭用户当前窗口，磁盘数据不受影响）。' +
            ' / Allow killing the running non-debug instance and relaunching it with CDP.',
        },
        waitMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: '等待调试端口就绪的最长时间（毫秒），默认 30000。 / Max wait for the port.',
        },
        gracefulMs: {
          type: 'integer',
          minimum: 500,
          maximum: 60000,
          description: '重启时给优雅退出的宽限时间（毫秒），默认 8000。 / Grace period for the stop phase.',
        },
        userDataDir: {
          type: 'string',
          description: '隔离的 Chromium 用户目录，透传给启动阶段。 / Isolated profile dir for the launch phase.',
        },
      },
      additionalProperties: false,
    },
    mutating: true,
    readOnly: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args = {}, ctx) => {
      const port = resolvePort(args, ctx);
      const appPath = appPathOf(args, ctx);
      const log = loggerOf(ctx);

      const probe = await probePort(port, { timeoutMs: 2000 });
      if (probe.ok) {
        return {
          ok: true,
          tool: 'aicoin_app_connect',
          verdict: 'attachable',
          reused: true,
          port,
          browser: probe.browser ?? null,
          wsUrl: probe.wsUrl ?? null,
          message: `端口 ${port} 已可连接，直接复用现有实例 / port ${port} already answers CDP.`,
        };
      }

      const scan = await listAiCoinProcesses();
      const mains = scan.main || [];
      const runningPids = mains.map((proc) => proc.pid);
      const debugPorts = [...new Set(mains.map((proc) => proc.debugPort).filter((n) => Number.isInteger(n)))];

      // Already debugging on some other port: restarting would be destructive
      // and pointless — just point the caller at the working port.
      if (debugPorts.length > 0 && !debugPorts.includes(port)) {
        return {
          ok: false,
          tool: 'aicoin_app_connect',
          verdict: 'running-on-other-port',
          port,
          runningPids,
          existingDebugPorts: debugPorts,
          message:
            `AiCoin 已经在端口 ${debugPorts.join(', ')} 上开好了调试端口，改用该端口即可，不要重启。` +
            ` / AiCoin already exposes CDP on ${debugPorts.join(', ')}; use that port instead.`,
          nextAction: {
            tool: 'aicoin_app_status',
            args: { port: debugPorts[0] },
            summary: `改用端口 ${debugPorts[0]}`,
          },
        };
      }

      if (mains.length > 0) {
        if (args.allowRestart !== true) {
          return {
            ok: false,
            tool: 'aicoin_app_connect',
            verdict: 'needs-restart',
            port,
            runningPids,
            message:
              `AiCoin 正在运行（pid ${runningPids.join(', ')}）但没有开启调试端口。` +
              `Electron 的 CDP 只能在进程启动时由 --remote-debugging-port 打开，事后无法附加，所以只能重启它。` +
              `确认可以关闭当前窗口后，传 allowRestart=true 再调一次（等价于 aicoin_app_restart + force）。` +
              ` / AiCoin runs without a debug port; CDP cannot be attached after start — restart it with allowRestart=true.`,
            nextAction: {
              tool: 'aicoin_app_restart',
              args: { port, force: true },
              summary: `以调试端口 ${port} 重启 AiCoin（会关闭当前窗口）`,
            },
          };
        }
        const restarted = await restart({
          port,
          appPath,
          waitMs: args.waitMs,
          gracefulMs: args.gracefulMs,
          force: true,
          userDataDir: args.userDataDir,
          log,
        });
        return {
          ...restarted,
          tool: 'aicoin_app_connect',
          verdict: restarted.ok ? 'restarted' : 'restart-failed',
          restartedBecause: 'running-without-debug-port',
        };
      }

      const launched = await launch({ port, appPath, waitMs: args.waitMs, userDataDir: args.userDataDir, log });
      return {
        ...launched,
        tool: 'aicoin_app_connect',
        verdict: launched.ok ? 'launched' : 'launch-failed',
      };
    },
  },
];

export default { tools };
