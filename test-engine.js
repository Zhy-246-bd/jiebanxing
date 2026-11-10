/* ============================================================
 * test-engine.js — 引擎自测脚本（在 Node 里跑，不依赖浏览器）
 * 用法：在项目骨架目录下执行  node test-engine.js
 * 输出三方案的指标与得分，闫雅欣的单测可以在此基础上扩。
 * ============================================================ */
var fs = require("fs"), path = require("path");

/* 按页面里的加载顺序拼接执行（间接 eval：在全局作用域定义函数）
   注：不需要 cities.js —— formats.js 里的 MEETING_CANDIDATES 有兜底值 */
["js/formats.js", "js/mock-api.js", "js/engine.js"].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
});

var members = [
  { id: 1, name: "张海燕", origin: "大学城地铁站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
  { id: 2, name: "雷馨怡", origin: "中心广场", mode: "taxi", budget: 40, window: ["08:00", "09:30"] },
  { id: 3, name: "夏国静", origin: "市体育馆", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
];

/* 边界用例：1 人（落单）、8 人（上限）也各跑一遍 */
var one = [members[0]];
var eight = [];
for (var i = 0; i < 8; i++) eight.push({
  id: i + 1, name: "成员" + (i + 1), origin: "地点" + (i + 1),
  mode: ["transit", "taxi", "bike"][i % 3], budget: 0, window: ["08:00", "09:30"]
});

function show(tag, ms, dest) {
  return generateSchemes(ms, dest).then(function (r) {
    console.log("===== " + tag + "（" + ms.length + " 人，目的地：" + dest + "）=====");
    r.schemes.forEach(function (s, i) {
      console.log(" #" + (i + 1) + " " + s.name +
        " | 总耗时 " + s.metrics.totalTimeMin + "分" +
        " | 总费用 ¥" + s.metrics.totalCost +
        " | 最长单人 " + s.metrics.worstTimeMin + "分" +
        " | 最长等待 " + s.metrics.maxWaitMin + "分" +
        " | 得分 " + s.score + (i === 0 ? "  <-推荐" : ""));
      s.legs.forEach(function (l) {
        if (l.isBottleneck) console.log("    瓶颈成员: " + l.member);
      });
    });
    console.log("");
  });
}

show("常规场景", members, "万象城")
  .then(function () { return show("单人场景", one, "万象城"); })
  .then(function () { return show("8人上限场景", eight, "万象城"); })
  .then(function () { console.log("全部用例通过，无异常。"); })
  .catch(function (e) { console.error("出错:", e); process.exit(1); });
