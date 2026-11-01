// fzu-signin status —— 只读查询今日状态
//
// 注意：不要用 App 页面判断状态。那个 H5 是 SPA，进页面取一次 init 之后
// 不自动刷新，会在已签到后仍显示「未签到」。以这里的结果为准。

import { parseArgs, createLogger, EXIT } from '../lib/cli.mjs';
import { prepareJar } from '../lib/runtime.mjs';
import { status } from '../../lib/sign.mjs';

const args = parseArgs();
const log = createLogger({ quiet: args.has('quiet') });

try {
  const { jar } = prepareJar({ sync: !args.has('no-adb'), jarFile: args.get('jar'), log });
  const s = await status({ jar, log });

  if (args.has('json')) {
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.signed ? EXIT.OK : EXIT.FAILED);
  }

  console.log('');
  console.log(`  姓名     ${s.name}`);
  console.log(`  学号     ${s.userId}`);
  console.log(`  班级     ${s.className}`);
  console.log(`  日期     ${s.date}`);
  console.log(`  时段     ${s.window.start} - ${s.window.end}（迟到线 ${s.window.late}）`);
  console.log(`  状态     ${s.signed ? '✔ ' : '✘ '}${s.state}${s.checkInTime ? '  ' + s.checkInTime.trim() : ''}`);
  if (s.checkInLocation) console.log(`  位置     ${s.checkInLocation}`);
  if (s.reason) console.log(`  备注     ${s.reason}`);
  console.log(`  校区     ${s.campuses.map((c) => `${c.name}#${c.id}`).join(', ')}`);
  for (const c of s.campuses) {
    if (c.fence) console.log(`           ${c.name}围栏 lng ${c.fence.lng[0]}~${c.fence.lng[1]} / lat ${c.fence.lat[0]}~${c.fence.lat[1]}（${c.fence.count} 块）`);
  }
  console.log('');

  process.exit(s.signed ? EXIT.OK : EXIT.FAILED);
} catch (e) {
  log('✘ ' + e.message);
  process.exit(EXIT.FAILED);
}
