/* ============================================================
 * 高德 Web 服务代理（Supabase Edge Function）
 *
 * 目的：把「Web 服务 Key」藏在服务端环境变量里。
 *   前端只请求 {SUPABASE_URL}/functions/v1/amap?q=/v3/...&...，
 *   由本函数带上 Key 去调 restapi.amap.com，再把 JSON 原样返回。
 *   这样浏览器的 Network 面板和 GitHub 仓库里都不会出现 Key。
 *
 * 附带防护（因为函数 URL 本身是公开的）：
 *   1. 接口白名单 —— 只放行项目真正用到的路径，别人拿去也当不了通用高德代理；
 *   2. 只接受 GET / OPTIONS，上游超时 7 秒。
 *
 * ── 部署步骤（Supabase 控制台，约 3 分钟，2026-11-19 按新版界面写）──
 *   1. Edge Functions → Create new edge function（网址 /functions/new 的在线编辑器）
 *   2. 函数名填 amap（必须叫这个，URL 才对得上）
 *   3. 把编辑器里的模板代码全部删掉，粘贴本文件全部内容 → Deploy
 *   4. 左侧 Secrets 菜单 → 新增 AMAP_KEY = 高德「Web服务」Key
 *   5. 不用找 JWT 开关：本函数没有用模板里的 withSupabase.auth(...) 包装，
 *      新版的鉴权发生在函数代码层，不包就是公开函数（前端不带任何头也能调）
 *   6. 自测：浏览器打开
 *      https://<项目>.supabase.co/functions/v1/amap?q=%2Fv3%2Fgeocode%2Fgeo%3Faddress%3D北京
 *      能看到 {"status":"1", ...} 即成功
 * ============================================================ */

const AMAP_KEY = Deno.env.get("AMAP_KEY") ?? "";
const AMAP_BASE = "https://restapi.amap.com";

/* 白名单：项目实际用到的接口（js/amap-api.js 里拼出来的那几条） */
const ALLOW_PREFIX = [
  "/v3/geocode/geo",
  "/v3/geocode/regeo",
  "/v3/assistant/inputtips",
  "/v3/direction/",
  "/v4/direction/",
  "/v5/direction/",
  "/v3/distance",
];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!AMAP_KEY) return json({ error: "服务端未配置 AMAP_KEY" }, 500);

  const q = new URL(req.url).searchParams.get("q") || "";
  if (!q.startsWith("/")) {
    return json({ error: "缺少 q 参数", hint: "q=/v3/geocode/geo?address=北京" }, 400);
  }
  if (!ALLOW_PREFIX.some((p) => q.startsWith(p))) {
    return json({ error: "接口不在白名单", path: q.split("?")[0] }, 403);
  }

  /* 防御性：即使上游把 key 带过来了也剥掉，统一用服务端的 */
  const clean = q
    .replace(/([?&])key=[^&]*/gi, "$1")
    .replace(/[?&]+$/, "");
  const target = AMAP_BASE + clean + (clean.includes("?") ? "&" : "?") + "key=" + AMAP_KEY;

  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(7000) });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        ...CORS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return json({ error: "上游请求失败", detail: String(e) }, 502);
  }
};

/* Supabase 新版在线编辑器（functions/new）的模板用 export default { fetch } 形式，
   这里保持一致。注意：我们没有调用模板里的 withSupabase.auth(...) 包装，
   这正是"不需要 JWT 就能调"的关键 —— 校验发生在函数代码层，不包就不拦。 */
export default { fetch: handler };
