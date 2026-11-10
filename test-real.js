/* ============================================================
 * test-real.js — 端到端验证（真高德接口 + 引擎 + 三方案）
 * 用法：
 *   node test-real.js            // 默认武汉
 *   node test-real.js beijing    // 指定城市：wuhan / beijing / shanghai / guangzhou / shenzhen / chengdu
 * 需要联网。浏览器里打开 index.html 时，因 file:// 跨域限制会全走本地估算，
 * 要看到真实数据必须用本地服务器：python -m http.server 8000
 * ============================================================ */
var fs = require("fs"), path = require("path");

/* 先加载本地 Key（存在才加载；没有就跑本地估算，脚本不会崩） */
if (fs.existsSync(path.join(__dirname, "js/config.local.js"))) {
  (0, eval)(fs.readFileSync(path.join(__dirname, "js/config.local.js"), "utf8"));
} else {
  console.log("提示：没找到 js/config.local.js，本次全部走本地估算（要真数据请先建这个文件）。\n");
}

["js/formats.js", "js/result-text.js", "js/amap-api.js", "js/cities.js", "js/engine.js"].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
});

var key = process.argv[2] || "wuhan";
if (!getCity(key)) {
  console.log("没有这个城市。可选：" + getCityList().map(function (c) { return c.key + "(" + c.name + ")"; }).join("  "));
  process.exit(1);
}
var city = applyCity(key);
var members = city.members.map(function (m, i) {
  return { id: i + 1, name: m.name, origin: m.origin, mode: m.mode, budget: m.budget, window: m.window };
});
var dest = city.destExample.split(" / ")[0];

console.log("城市：" + city.name + "（" + city.adcode + "）  候选集合点：" + MEETING_CANDIDATES.join(" / ") + "\n");

generateSchemes(members, dest).then(function (r) {
  r.schemes.forEach(function (s, i) {
    console.log("#" + (i + 1) + " " + s.name +
      " | 总耗时 " + s.metrics.totalTimeMin + "分" +
      " | 总费用 ¥" + s.metrics.totalCost +
      " | 最长单人 " + s.metrics.worstTimeMin + "分" +
      " | 最长等待 " + s.metrics.maxWaitMin + "分" +
      " | 得分 " + s.score);
    s.legs.forEach(function (l) {
      if (l.isBottleneck) console.log("    瓶颈成员: " + l.member + "（" + l.totalMin + "分）");
    });
  });
  console.log("\n接口统计：");
  amapStats();
}).catch(function (e) { console.error("出错:", e); process.exit(1); });
