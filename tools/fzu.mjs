#!/usr/bin/env node
// 主入口：fzu-signin <command> [options]
//
// 也行：node tools/fzu.mjs <command>

import { createLogger, parseArgs, EXIT } from './lib/cli.mjs';

const COMMANDS = {
  sign: './commands/sign.mjs',
  status: './commands/status.mjs',
  run: './commands/run.mjs',
  cookies: './commands/cookies.mjs',
  doctor: './commands/doctor.mjs',
  selftest: './verify/selftest.mjs',
};

const HELP = `
fzu-night-signin · 福大晚点名签到

用法
  fzu-signin <command> [options]

命令
  sign        立即签到（--dry 演练 / --lat= --lng= 覆盖坐标）
  status      查今天状态（只读）
  run         定时任务入口：同步 cookie → 签到 → 失败自愈重试
  cookies     从模拟器同步 App 的 WebView cookie
  doctor      环境自检（文件/设备/cookie/接口/围栏/计划任务）
  selftest    首次安装后的启动测试

常用 options
  --dry             只演练，不提交
  --no-adb          不碰模拟器，只用本地缓存 cookie
  --jar=<path>      指定 cookie 文件（形如 {"host":["k=v"]}）
  --lat=<num>       覆盖纬度
  --lng=<num>       覆盖经度
  --quiet           不打印到控制台
  --json            以 JSON 输出结果

示例
  fzu-signin doctor
  fzu-signin status
  fzu-signin sign --dry
  fzu-signin sign --lat=26.056 --lng=119.196
  fzu-signin run
`;

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(HELP.trim());
  process.exit(cmd ? EXIT.OK : EXIT.BAD_USAGE);
}

const target = COMMANDS[cmd];
if (!target) {
  console.error(`未知命令: ${cmd}\n`);
  console.log(HELP.trim());
  process.exit(EXIT.BAD_USAGE);
}

// 把子命令自己的参数交过去，再动态加载对应模块
const url = new URL(target, import.meta.url);
process.argv = [process.argv[0], decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1')), ...rest];
await import(url.href);
