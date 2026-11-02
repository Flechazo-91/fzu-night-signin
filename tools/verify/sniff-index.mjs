// 最后一招：不带 token 打开 index.action，看 HTML 里有没有埋初始数据/token
import { CookieJar, request } from '../../lib/http.mjs';
import { loadJar } from '../../lib/config.mjs';

const jar = new CookieJar(loadJar());
const r = await request('GET', 'https://yzsxg.fzu.edu.cn/plug-in/livecloud/project/fzu/attn/index.action?contextPath=', { jar, follow: true });

console.log('status', r.status, 'len', r.body.length);
console.log('final:', r.url.slice(0, 140));
console.log('--- body head ---');
console.log(r.body.slice(0, 1200));

const hits = [...r.body.matchAll(/token["'\s:=]+([A-Za-z0-9]{16,})/g)].map((m) => m[1]);
console.log('\n--- token 候选 ---');
console.log(hits.length ? [...new Set(hits)].join('\n') : '（无）');

// 顺带看 set-cookie
console.log('\n--- 当前 cookie ---');
for (const [host, arr] of Object.entries(jar.jar)) {
  console.log(host, arr.map((c) => c.split('=')[0]).join(','));
}
