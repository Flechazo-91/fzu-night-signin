// 解码 SSO 的 SOURCEID_TGC（JWT）看有效期，并直接请求一次 authorize 判断会话是否真死
import fs from 'node:fs';
import { loadJar } from '../../lib/config.mjs';

const jar = loadJar();
const tgc = (jar['sso.fzu.edu.cn'] || []).find((c) => c.startsWith('SOURCEID_TGC='));
if (!tgc) { console.log('没有 SOURCEID_TGC'); process.exit(1); }

const jwt = tgc.slice('SOURCEID_TGC='.length);
// TGC 的值本身可能又是一个 JWT（嵌套），逐层解
function decodeToken(t, depth = 0) {
  const parts = t.split('.');
  if (parts.length !== 3) return { note: 'not a JWT', raw: t.slice(0, 60) };
  const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  let header, payload;
  try { header = JSON.parse(b64(parts[0])); } catch { header = parts[0]; }
  try { payload = JSON.parse(b64(parts[1])); } catch { payload = parts[1]; }
  const out = { depth, header, payload };
  // 很多 CAS 会把真正的 TGC 塞在某个字段里再套一层 JWT
  if (typeof payload === 'string' && payload.split('.').length === 3 && depth < 3) {
    out.inner = decodeToken(payload, depth + 1);
  } else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.split('.').length === 3 && v.length > 60) {
        out.inner = out.inner || {};
        out.inner[k] = decodeToken(v, depth + 1);
      }
    }
  }
  return out;
}

const info = decodeToken(jwt);
console.log('=== SOURCEID_TGC 解码 ===');
console.log(JSON.stringify(info, null, 2).slice(0, 3000));

// 找所有 exp
function collectExp(o, acc = []) {
  if (!o || typeof o !== 'object') return acc;
  if (typeof o.exp === 'number') acc.push(o.exp);
  for (const v of Object.values(o)) collectExp(v, acc);
  return acc;
}
const exps = collectExp(info);
if (exps.length) {
  for (const e of exps) {
    const d = new Date(e * 1000);
    console.log(`exp=${e} → ${d.toLocaleString('zh-CN')}  ${d.getTime() > Date.now() ? '✔ 未过期' : '✘ 已过期'}`);
  }
} else {
  console.log('（没找到 exp 字段）');
}

console.log('\n=== 直接测 authorize ===');
const { request } = await import('../../lib/http.mjs');
const { CookieJar } = await import('../../lib/http.mjs');
const r = await request('GET', 'https://yzsxg.fzu.edu.cn/livecloud/project/fzu/attn/oauth2/authorize.action', { jar: new CookieJar(jar) });
console.log('最终 URL:', r.url.slice(0, 130));
console.log(r.url.includes('sso.fzu.edu.cn/login') ? '→ 会话已失效，被打回登录页' : '→ 会话可能仍有效');
