/* ============================================================
 * cloud-config.js — 云数据库配置（Supabase，11-16）
 *
 * 为什么换 Supabase（答辩可讲）：
 *   原 WorkBuddy 云服务强制精确 Origin 匹配，GitHub Pages 来源被 403
 *   拒绝且无法加白名单；Supabase CORS 开放、免费、免实名备案，
 *   免费额度 5 万月活 / 5GB，课程原型绰绰有余。
 *
 * 这两个值来自 Supabase 控制台 → Project Settings → API：
 *   supabaseUrl    —— 项目地址，形如 https://xxxx.supabase.co
 *   supabaseAnonKey —— 匿名公钥，本来就会出现在浏览器里，可进仓库
 *                     （真正的权限由 RLS 行级策略控制，见 supabase-schema.sql）
 *
 * ⚠️ 未填入时房间功能会明确提示"云数据库还没配置好"，不会静默失败。
 * ============================================================ */
(function (g) {
  g.JBX_CLOUD = {
    backend: "supabase",
    supabaseUrl: "REPLACE_WITH_YOUR_SUPABASE_URL",        // ← 组长填这里
    supabaseAnonKey: "REPLACE_WITH_YOUR_SUPABASE_ANON_KEY", // ← 组长填这里
    /* supabase-js v2 UMD 版，从 jsDelivr 懒加载（纯 HTML 项目，没有构建步骤） */
    sdkUrl: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
