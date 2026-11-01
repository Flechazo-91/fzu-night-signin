// 编排层：一次完整的签到尝试
//
// 顺序刻意做成「先判定、后提交」：
//   拿到 init → 已签到/无需签到 → 直接退出（零写请求）
//             → 时间窗不对 → 直接退出（等调度器重试）
//             → 围栏不命中 → 直接退出（说明坐标要改）
// 只有全部通过才发 clockIn。

import { CookieJar } from './http.mjs';
import { fetchToken, fetchInit, fetchCheck, clockIn, fetchServerTime, buildClockPayload } from './api.mjs';
import {
  isSigned, isLate as calcLate, needsGeofence, needsNoClock,
  checkWindow, pickMatchedCampus, describeFence,
} from './state.mjs';

/**
 * @typedef {object} SignResult
 * @property {boolean} ok        是否达成目标（含「本来就不用签」）
 * @property {boolean} [skipped] 是否什么都没做
 * @property {string}  reason    人话说明
 * @property {object}  [detail]  服务端回执
 */

/**
 * @param {object} opts
 * @param {object} opts.jar      cookie 罐（CookieJar 或普通对象）
 * @param {number} opts.lat
 * @param {number} opts.lng
 * @param {string} opts.address
 * @param {boolean} [opts.dry]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<SignResult>}
 */
export async function sign({ jar, lat, lng, address, dry = false, log = () => {} }) {
  const jarBox = jar instanceof CookieJar ? jar : new CookieJar(jar);

  // ── 1. 换 token ──────────────────────────────────────────
  let token;
  try {
    const r = await fetchToken(jarBox);
    token = r.token;
    log('token = ' + token);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  // ── 2. 今日计划 ──────────────────────────────────────────
  let data;
  try {
    data = await fetchInit(jarBox, token);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  const P = data.paramsData || {};
  const U = data.userData || {};
  const campuses = data.schoolData || [];
  log(`用户: ${U.FName || '?'} / ${U.UserId || '?'} / ${U.FClass || '?'}`);
  log(`校区: ${campuses.map((c) => `${c.FName}#${c.ID}`).join(',') || '无'} | 状态: ${U.FState}`);

  // ── 3. 短路 ─────────────────────────────────────────────
  if (isSigned(U.FState)) {
    return { ok: true, skipped: true, reason: `今天已签到 ${U.FCheckInTime || U.FState}` };
  }
  if (needsNoClock(U.FWay)) {
    return { ok: true, skipped: true, reason: '今天无需签到 (way=3)' };
  }

  // ── 4. 时间窗（用服务端时间，别信本机时钟）───────────────
  const ts = await fetchServerTime(jarBox, token);
  const now = ts ? new Date(ts) : new Date();
  const win = checkWindow(now, P.FStartTime, P.FEndTime);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  log(`窗口 ${String(P.FStartTime).trim()}-${String(P.FEndTime).trim()} 迟到线 ${String(P.FLateTime).trim()} 现在 ${hhmm}`);
  if (!win.inWindow) {
    return { ok: false, reason: win.reason };
  }
  const late = calcLate(now, P.FLateTime);

  // ── 5. 围栏匹配 ──────────────────────────────────────────
  let matched = null;
  let matchedCampus = null;

  if (needsGeofence(U.FWay)) {
    for (const c of campuses) {
      let res;
      try {
        res = await fetchCheck(jarBox, token, { lat, lng, range: c.FPosition });
      } catch (e) {
        log(`check ${c.FName}#${c.ID} 异常: ${e.message}`);
        continue;
      }
      const hit = pickMatchedCampus(res);
      log(`check ${c.FName}#${c.ID}: ${hit ? '命中' : (res.msg || '不在范围')}`);
      if (hit) {
        matched = { ...hit, title: hit.title || c.FName };
        matchedCampus = c;
        break;
      }
    }
    if (!matched) {
      const fence = describeFence(campuses[0]?.FPosition);
      const hint = fence
        ? `（当前围栏 lng ${fence.lng[0]}~${fence.lng[1]} / lat ${fence.lat[0]}~${fence.lat[1]}）`
        : '';
      return { ok: false, reason: `坐标 ${lat},${lng} 不在任何校区围栏内${hint}` };
    }
  } else {
    // 外勤打卡不校验围栏，直接用默认校区
    const c = campuses[0];
    matched = { id: String(c?.ID ?? ''), title: String(c?.FName ?? '') };
    matchedCampus = c;
    log(`外勤打卡 (way=${U.FWay})，跳过围栏校验`);
  }

  // ── 6. 提交 ─────────────────────────────────────────────
  const payload = buildClockPayload({
    campusId: matched.id,
    campusTitle: matched.title || matchedCampus?.FName || '',
    lat,
    lng,
    startTime: P.FStartTime,
    endTime: P.FEndTime,
    userData: U,
    address,
    isLate: late,
  });
  log('参数: ' + JSON.stringify(payload));

  if (dry) return { ok: true, skipped: true, reason: '--dry 演练，未提交', detail: payload };

  let res;
  try {
    res = await clockIn(jarBox, token, payload);
  } catch (e) {
    return { ok: false, reason: '提交异常: ' + e.message };
  }
  log('回执: ' + JSON.stringify(res));

  if (res.success && res.code === 1) {
    return { ok: true, reason: res.data?.msg || '打卡成功', detail: res.data?.attn || res.data };
  }
  if (/重复/.test(res.msg || '')) {
    return { ok: true, skipped: true, reason: '请勿重复打卡（今天已完成）' };
  }
  return { ok: false, reason: res.msg || '未知失败' };
}

/** 只读：查今日状态，不提交任何写请求 */
export async function status({ jar, log = () => {} }) {
  const jarBox = jar instanceof CookieJar ? jar : new CookieJar(jar);
  const { token } = await fetchToken(jarBox);
  const data = await fetchInit(jarBox, token);
  const U = data.userData || {};
  const P = data.paramsData || {};
  return {
    name: U.FName,
    userId: U.UserId,
    className: U.FClass,
    planId: U.FPlanID,
    date: P.PD,
    state: U.FState,
    checkInTime: U.FCheckInTime,
    checkInLocation: U.FActualLocation,
    reason: U.FReason,
    campus: U.FCampus,
    way: U.FWay,
    window: { start: String(P.FStartTime || '').trim(), end: String(P.FEndTime || '').trim(), late: String(P.FLateTime || '').trim() },
    signed: isSigned(U.FState),
    campuses: (data.schoolData || []).map((c) => ({ id: c.ID, name: c.FName, fence: describeFence(c.FPosition) })),
  };
}
