/* ============================================================
 * config.js — 线上运行配置【这个文件会提交进仓库】
 *
 * 2026-11-19 起：Web 服务 Key 不再放这里！
 *   它被移到了 supabase/functions/amap（Edge Function）的服务端环境变量
 *   AMAP_KEY 里，前端所有 restapi.amap.com 请求经该函数转发（见 __AMAP_PROXY__）。
 *   GitHub 仓库和浏览器 Network 面板里都看不到 Key。
 *
 *   __AMAP_PROXY_AUTH__ 是 Supabase 的 publishable 公钥（anon key），
 *   它本来就公开（js/cloud-config.js 里也有一份），只用于过网关的
 *   Authorization 校验，不承担任何权限（真正的写权限由数据库 RLS 控制）。
 *
 *   __AMAP_JS_KEY__（结果页地图）是「Web端(JS API)」类型，本来就必须暴露在
 *   页面源码里，安全靠高德控制台的**域名白名单**兜底（已绑
 *   zhy-246-bd.github.io），别人拿走 Key 放在自己站上会直接报
 *   INVALID_USER_DOMAIN，用不了。
 *
 * 页面加载顺序是 config.js 先、config.local.js 后，本地开发时
 * config.local.js 里的同名值会覆盖这里，不会互相干扰。
 *
 * 线上为什么必须有这个文件：GitHub Pages 只托管仓库里的文件，
 * config.local.js 被 .gitignore 排除、不会上传——线上曾经一直读不到
 * JS Key，结果页地图空白（现已并入本文件）。
 *
 * Key 在哪：https://console.amap.com/dev/key/app
 * ============================================================ */
(function (g) {
  g.__AMAP_KEY__ = "";   /* 已移交服务端代理，这里留空（不要再填回来） */

  g.__AMAP_PROXY__ = "https://bsiprxvkbnmmdkxtxokq.supabase.co/functions/v1/amap";
  g.__AMAP_PROXY_AUTH__ = "sb_publishable_O0AS0RikutJv7089NwttRw_0NRqgiGI";

  g.__AMAP_JS_KEY__ = "7e1a4c92cd2f4832356b98a25cf3489b";
  g.__AMAP_JS_CODE__ = "267f1c341085e0475542285e1aae1dc0";
})(typeof globalThis !== "undefined" ? globalThis : window);
