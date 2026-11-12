/* ============================================================
 * test-map-view.js — 地图模块逻辑自测（张宇桐，在 Node 里跑，不需要浏览器和 Key）
 * 用法：node test-map-view.js
 * 验证 map-view.js 的纯逻辑部分与夏国静 engine.js 的真实输出能对上：
 *   ① extractPlaces：起点（含同名合并）、目的地、集合点抽取正确
 *   ② 所有 segment 的 from/to 一定落在 places 清单内（画线的坐标系完整）
 *   ③ 方案二/三确实含集合点；方案一不含
 *   ④ 边界：1 人、8 人也各跑一遍
 * 浏览器里的真实渲染（需 JS Key）另行人工验收：index.html → 生成方案 → 看地图。
 * ============================================================ */
var fs = require("fs"), path = require("path");

/* 与 test-engine.js 相同的加载方式（间接 eval：在全局作用域定义函数） */
["js/formats.js", "js/mock-api.js", "js/engine.js"].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
});
var mapView = require(path.join(__dirname, "js/map-view.js"));

var failed = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
}

var members = [
  { id: 1, name: "张海燕", origin: "大学城地铁站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
  { id: 2, name: "雷馨怡", origin: "中心广场", mode: "taxi", budget: 40, window: ["08:00", "09:30"] },
  { id: 3, name: "夏国静", origin: "市体育馆", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
];
var sameOrigin = [                       // 同名起点：两人填了同一个地方，标记应合并
  { id: 1, name: "甲", origin: "武汉站", mode: "transit", budget: 0, window: ["08:00", "09:30"] },
  { id: 2, name: "乙", origin: "武汉站", mode: "taxi", budget: 0, window: ["08:00", "09:30"] },
  { id: 3, name: "丙", origin: "光谷广场", mode: "bike", budget: 0, window: ["08:00", "09:30"] }
];
var eight = [];
for (var i = 0; i < 8; i++) eight.push({
  id: i + 1, name: "成员" + (i + 1), origin: "地点" + (i + 1),
  mode: ["transit", "taxi", "bike"][i % 3], budget: 0, window: ["08:00", "09:30"]
});

function run(tag, ms, dest) {
  return generateSchemes(ms, dest).then(function (result) {
    console.log("===== " + tag + "（" + ms.length + " 人，目的地：" + dest + "）=====");

    var data = { dest: dest, city: "武汉", members: ms, result: result };
    var info = mapView.extractPlaces(data);

    /* ① 起点抽取 */
    ok(info.origins.length === new Set(ms.map(function (m) { return m.origin; })).size,
      "起点去重后共 " + info.origins.length + " 个（录入 " + ms.length + " 人）");
    var first = info.origins[0];
    ok(first && first.members && first.members.length,
      "起点带成员名（" + first.place + " ← " + first.members.join("、") + "）");

    /* ② 所有 segment 的 from/to 都在 places 里 */
    var placeSet = {};
    info.places.forEach(function (p) { placeSet[p] = 1; });
    var allCovered = true, segCount = 0;
    result.schemes.forEach(function (s) {
      mapView.extractSegments(s).forEach(function (seg) {
        segCount++;
        if (!placeSet[seg.from] || !placeSet[seg.to]) { allCovered = false; console.log("    未覆盖:", seg.from, "→", seg.to); }
      });
    });
    ok(allCovered, "全部 " + segCount + " 段行程的 from/to 都在地点清单内（坐标系完整）");

    /* ③ 集合点：type=meet/partial 的方案含集合点；type=direct 不含
       （注意 schemes 按得分排序，不能按数组下标找方案） */
    var originSet = {};
    ms.forEach(function (m) { originSet[m.origin] = 1; });
    var direct = result.schemes.filter(function (s) { return s.type === "direct"; });
    var withMeet = result.schemes.filter(function (s) { return s.type === "meet" || s.type === "partial"; });
    var s1HasMeet = direct.some(function (s) {
      return mapView.extractSegments(s).some(function (seg) { return seg.to !== dest && !originSet[seg.to]; });
    });
    ok(!s1HasMeet, "直达型方案（" + direct.length + " 个）不含集合点");
    var meetNames = {};
    withMeet.forEach(function (s) {
      mapView.extractSegments(s).forEach(function (seg) {
        [seg.from, seg.to].forEach(function (n) { if (n !== dest && !originSet[n]) meetNames[n] = 1; });
      });
    });
    /* 单人时"部分汇合"会退化成直达（引擎行为），此时可能没有任何带集合点的方案 */
    ok(Object.keys(meetNames).length >= 1 || ms.length === 1,
      "汇合型方案含集合点：" + (Object.keys(meetNames).join("、") || "（单人退化，无集合点，符合引擎行为）"));

    /* ④ 目的地在清单里 */
    ok(placeSet[dest] === 1, "目的地「" + dest + "」在地点清单内");
    console.log("");
  });
}

/* 同名起点合并专项 */
run("同名起点合并", sameOrigin, "万象城").then(function () {
  var info = mapView.extractPlaces({
    dest: "万象城", city: "武汉", members: sameOrigin,
    result: { schemes: [{ legs: [{ segments: [{ from: "武汉站", to: "万象城", mode: "transit" }] }] }] }
  });
  ok(info.origins.length === 2, "两人同填「武汉站」→ 起点标记合并为 1 个（共 " + info.origins.length + " 个起点）");
  var wh = info.origins.filter(function (o) { return o.place === "武汉站"; })[0];
  ok(wh && wh.members.join("、") === "甲、乙", "合并后的起点标签带上两个名字：" + wh.members.join("、"));
  console.log("");
  return run("常规场景", members, "万象城");
})
  .then(function () { return run("单人场景", [members[0]], "万象城"); })
  .then(function () { return run("8人上限场景", eight, "万象城"); })
  .then(function () {
    /* 空数据防御 */
    var empty = mapView.extractPlaces(null);
    ok(empty.places.length === 0, "空数据（null）不抛异常");
    console.log(failed ? "❌ 有 " + failed + " 项未通过" : "✓ 全部用例通过");
    process.exit(failed ? 1 : 0);
  })
  .catch(function (e) { console.error("出错:", e); process.exit(1); });
