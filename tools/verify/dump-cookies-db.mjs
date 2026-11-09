// 诊断：直接看 cookie 库里到底有什么
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const p = process.argv[2] || 'D:/dsh-work/fzu-night-signin/dump/ck.db';
console.log('file:', p, fs.statSync(p).size, 'bytes');

const db = new DatabaseSync(p, { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('tables:', tables.map((t) => t.name).join(', '));

try {
  const cols = db.prepare('PRAGMA table_info(cookies)').all();
  console.log('columns:', cols.map((c) => c.name).join(', '));
} catch (e) { console.log('PRAGMA 失败:', e.message); }

const rows = db.prepare('SELECT host_key, name, value, length(encrypted_value) AS ev, is_secure, is_httponly FROM cookies').all();
console.log('cookies rows:', rows.length);
for (const r of rows) {
  console.log(`  ${r.host_key} | ${r.name} | value=${String(r.value).slice(0, 60)} | enc=${r.ev}B`);
}
db.close();
