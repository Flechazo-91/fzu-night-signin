// 福大晚点名签到 —— 前端加密算法的等价实现
//
// 前端 `Encrypt()` 是 AES，密钥硬编码在打包后的 JS 里：
//
//   const KEY = "apexinfoapexinfo";                 // 16 字节 → AES-128
//   CryptoJS.AES.encrypt(word, KEY, {
//     iv: KEY, mode: CBC, padding: Pkcs7
//   }).toString();                                  // → Base64
//
// 注意 key 与 iv 是同一个常量，且 CryptoJS 在显式传入 WordArray key 时不做
// 口令派生（无 Salted__ 前缀），所以 `toString()` 就是纯粹的 Base64(ciphertext)。

import crypto from 'node:crypto';

/** 前端硬编码密钥（16 字节 / AES-128 / 同时用作 IV） */
export const KEY = 'apexinfoapexinfo';

const KEY_BUF = Buffer.from(KEY, 'utf8');

function assertKey() {
  if (KEY_BUF.length !== 16 && KEY_BUF.length !== 24 && KEY_BUF.length !== 32) {
    throw new Error(`密钥长度异常: ${KEY_BUF.length} 字节（应为 16/24/32）`);
  }
}

/**
 * 等价于前端 `Encrypt(obj)`
 * @param {object|string} input 对象会被 JSON.stringify
 * @returns {string} Base64 密文
 */
export function encrypt(input) {
  assertKey();
  const plain = typeof input === 'string' ? input : JSON.stringify(input);
  const cipher = crypto.createCipheriv(`aes-${KEY_BUF.length * 8}-cbc`, KEY_BUF, KEY_BUF);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * 等价于前端 `Decrypt(b64)` —— 主要用于自检与调试
 * @param {string} b64
 * @returns {string} 明文
 */
export function decrypt(b64) {
  assertKey();
  const decipher = crypto.createDecipheriv(`aes-${KEY_BUF.length * 8}-cbc`, KEY_BUF, KEY_BUF);
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * 把密文编码成可直接拼进 URL 的 param。
 *
 * 坑在这里：前端是
 *   axios.get(url, { params: { param: encodeURIComponent(Encrypt(obj)) } })
 * axios 会对 params 的值**再编码一次**，而服务端只解一层，
 * 所以线上真实 URL 上是**双重编码**。只编码一次会被判成
 * `{"msg":"打卡地点校验发生异常"}`。
 */
export function encodeParam(input) {
  return encodeURIComponent(encodeURIComponent(encrypt(input)));
}
