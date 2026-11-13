/* ============================================================
 * config.example.js — 配置模板【这个文件可以提交进仓库】
 *
 * 用法（第一次拉代码的人都要做一次）：
 *   1. 把本文件复制一份，改名为 config.local.js
 *   2. 把下面引号里填上高德 Web 服务 Key
 *   3. 刷新页面即可；控制台执行 amapStats() 能看到请求数
 *
 * 为什么不在代码里直接写 Key：
 *   仓库会同步给 6 个人，将来还可能公开或做成作品集展示。
 *   Key 一旦进了仓库历史，删掉也还在历史里，只能作废重申请。
 *   所以 Key 只放本地 config.local.js，该文件不进仓库。
 *
 * Key 在哪：https://console.amap.com/dev/key/app → 类型选「Web服务」
 * 没填 Key 也能跑：全部走本地估算，页面不报错，只是数据是估的。
 * ============================================================ */
(function (g) {
  g.__AMAP_KEY__ = "";   // ← 填你自己的 Key（32 位十六进制），类型必须选「Web服务」

  /* 张宇桐的地图用（result.html 结果页）：类型必须是「Web端(JS API)」，和上面的 Web服务 Key 不是同一个！
     2021-12 之后申请的 JS Key 必须配套安全密钥，两行要一起填。都找雷馨怡拿。 */
  g.__AMAP_JS_KEY__ = "";   // ← Web端(JS API) 类型的 Key
  g.__AMAP_JS_CODE__ = "";  // ← 该 Key 配套的安全密钥（jscode）
})(typeof globalThis !== "undefined" ? globalThis : window);
