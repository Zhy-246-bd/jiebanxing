/* ============================================================
 * config.js — 线上运行配置【这个文件会提交进仓库】
 *
 * 为什么这个文件可以进仓库（和 config.local.js 的分工）：
 *   · __AMAP_JS_KEY__（结果页地图）是「Web端(JS API)」类型，本来就必须暴露在
 *     页面源码里，安全靠高德控制台的**域名白名单**兜底（已绑
 *     zhy-246-bd.github.io），别人拿走 Key 放在自己站上会直接报
 *     INVALID_USER_DOMAIN，用不了；
 *   · __AMAP_KEY__（路线/地理编码）是「Web服务」类型，无法绑域名，公开后
 *     存在配额被别人刷掉的风险 → 答辩结束后请到控制台重置该 Key，
 *     重置不会影响已部署的代码逻辑，只需把新值替换到本文件；
 *   · 页面加载顺序是 config.js 先、config.local.js 后，本地开发时
 *     config.local.js 里的值会覆盖这里，不会互相干扰。
 *
 * 线上为什么必须有它：GitHub Pages 只托管仓库里的文件，
 * config.local.js 被 .gitignore 排除、不会上传，所以线上曾经一直读不到 Key，
 * 全程走"本地估算"的假距离、结果页地图也空白。
 *
 * Key 在哪：https://console.amap.com/dev/key/app
 *   Web服务 → __AMAP_KEY__；Web端(JS API) + 安全密钥 → __AMAP_JS_KEY__ / __AMAP_JS_CODE__
 * ============================================================ */
(function (g) {
  g.__AMAP_KEY__ = "73d09b6d9754a314ce45bbbd7b892a69";

  g.__AMAP_JS_KEY__ = "7e1a4c92cd2f4832356b98a25cf3489b";
  g.__AMAP_JS_CODE__ = "267f1c341085e0475542285e1aae1dc0";
})(typeof globalThis !== "undefined" ? globalThis : window);
