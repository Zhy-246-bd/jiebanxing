/* ============================================================
 * cloud-config.js — 云服务公开配置（可以进仓库）
 *
 * 这三个值来自开通云服务时返回的 publicConfig：
 *   endpoint        —— 本应用的数据平面地址（每个应用不同，不能猜、不能从 location 推）
 *   oauthRelayBaseUrl —— 登录中转（本方案不用登录，保留以便将来加账号）
 *   publishableKey  —— 标识"是哪个应用"，本身不带权限；服务端还会校验来源域名
 *
 * 注意：这里没有任何密钥。真正的资源 id 和数据库凭据都在服务端，不下发到前端。
 * 换应用 / 重新发布时，只改这个文件。
 * ============================================================ */
(function (g) {
  g.JBX_CLOUD = {
    endpoint: "https://wbapp-3kiqbllnfhxry5st8ddq57.app.workbuddy.host",
    oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
    publishableKey: "wbpk_3KIQbllNFHXRY5St8dDQ57_wB13zNWx9ql35S20s6vJoiXkgRbkHNx0",
    appId: "wbapp_3KIQbllNFHXRY5St8dDQ57",
    /* SDK 从 CDN 加载（纯 HTML 项目，没有构建步骤） */
    sdkUrl: "https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
