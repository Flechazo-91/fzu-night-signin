// CLI 公共件：参数解析 + 带时间戳的日志 + 每日日志文件

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../../lib/config.mjs';

/** 解析 `--flag` / `--key=value` / 位置参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const kv = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        kv[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--') && /^-?\d+(\.\d+)?$/.test(next)) {
          kv[name] = next;
          i++;
        } else {
          flags.add(name);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return {
    flags,
    kv,
    positional,
    has: (k) => flags.has(k) || k in kv,
    get: (k, d = undefined) => (k in kv ? kv[k] : d),
    num: (k, d = undefined) => (k in kv ? Number(kv[k]) : d),
  };
}

/**
 * 造一个带时间戳的 logger，同时写当日日志文件
 * @param {{quiet?:boolean, file?:boolean}} opts
 */
export function createLogger({ quiet = false, file = false } = {}) {
  let filePath = null;
  if (file) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    filePath = path.join(LOG_DIR, 'sign-' + new Date().toISOString().slice(0, 10) + '.log');
    // UTF-8 BOM：记事本 / Get-Content 都能正确识别中文
    if (!fs.existsSync(filePath)) {
      try { fs.writeFileSync(filePath, '\uFEFF', 'utf8'); } catch { }
    }
  }

  const stamp = () => '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + ']';

  const log = (...args) => {
    const line = stamp() + ' ' + args.join(' ');
    if (!quiet) console.log(line);
    if (filePath) { try { fs.appendFileSync(filePath, line + '\n', 'utf8'); } catch { } }
  };

  log.filePath = filePath;
  return log;
}

/** 进程退出码约定 */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  BAD_USAGE: 2,
  NOT_IN_WINDOW: 3,
  NO_FENCE: 4,
  COOKIE_DEAD: 5,
};
