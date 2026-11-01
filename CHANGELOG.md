# 更新日志

## v1.0.0 —— 第一版（2026-11-01）

> 主题：**不去骗检测，而是绕过检测发生的那个位置。**

### 能用了

- **协议层签到**：`sign` 直接调 `clockIn.action`，不经过 App、不经过高德
  - 实测回执：`{"success":true,"code":1,"data":{"msg":"打卡成功","attn":{"checkInTime":"2026-11-01 22:12:16"}}}`
- **五个接口全部打通**：`authorize` → `init` → `check` → `clockIn`（+ `currentTimestamp`）
- **加密复现**：AES-128-CBC / key=iv=`apexinfoapexinfo` / Pkcs7 / Base64
- **每日 21:30 自动化**：`scripts/install-task.ps1` 注册 Windows 计划任务
  - 3 次重试 × 10 分钟，全部落在 22:30 迟到线之前
- **失败自愈**：会话过期 → 唤醒 App 重建 SSO 会话 → 再试一次
- **幂等**：已签到 / `way=3` / 不在时段 → 零写请求直接退出

### 踩过的坑（都修了，写在这里免得有人再踩）

1. **`param` 必须双重 URL 编码**
   前端 `axios.get(url, {params:{param: encodeURIComponent(密文)}})`，axios 会再编码一次，
   服务端只解一层。单次编码 → `打卡地点校验发生异常`。

2. **`range` 必须传 JSON 字符串**
   传数组或省略 → `当前点不在选定的范围区域内`。前端就是 `JSON.stringify(schoolPosition)`。

3. **`startTime` / `endTime` 保留尾部空格**
   服务端返回 `"21:00     "`，前端原样回传。trim 掉之后打卡失败。

4. **`collUnit` 是数字**
   `userData.FCollUnit` 是学院 id（如 `35`），不是学院名字符串。

5. **App 页面状态不可信**
   签到页是 SPA，进页面只请求一次 `init`，打完卡仍显示「未签到」。
   判断状态用 `status`（每次重新 `init`），不要截图看页面。

6. **模拟器虚拟定位的纬度超出了围栏**
   很多人从地图上抄 `26.0735`，而围栏纬度上界是 `26.0679`（差约 600 米），
   App 会一直说「不在签到范围内」。默认坐标取围栏内的 `26.056, 119.196`。

### 顺带排除的干扰

- **LocationSpoofer 的全局 hook 会吞定位**
  它 `system_hook_global_mode=true` 但 `is_spoofing_active=false`、`lat/lng=0` 时，
  hook 生效却不给坐标，App 的定位请求被直接跳过（logcat 满屏
  `[listen:inactive] ... skipped: active=false`），表现为签到页永远「定位中...」。
  本项目不需要它，但它留着会影响 App 内手动签到。
