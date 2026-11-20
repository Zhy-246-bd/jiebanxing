/* ============================================================
 * test-engine-v2.js — 夏国静：v0.5 引擎新功能自测（Node 跑，秒出）
 * 用法：node test-engine-v2.js
 *
 * 为什么不复用 mock-api.js：mock 的路线是字符串哈希出来的，同一个地方
 * 距离不守恒，验证不了"配对是否最优"。这里自己造一块**合成城市**：
 * 坐标单位就是公里，queryRoute 按直线距离算耗时/费用，
 * 于是"哪两个人最近"是已知答案，可以拿暴力枚举去核对 DP 的结果。
 *
 * 覆盖：
 *   1. DP 配对 = 暴力枚举最优（6 人 3 对、5 人 1 人落单）
 *   2. 预算校验：超预算标记 + 超出金额
 *   3. 权重可调：纯时间权重 / 纯费用权重 各自选出对应最优的方案
 *   4. 无坐标退化：不抛错、自动退回按录入顺序配对
 *   5. 边界：0 人
 * ============================================================ */
var fs = require("fs"), path = require("path");

["js/formats.js", "js/engine.js"].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
});

/* ---------------- 合成城市（单位：公里） ---------------- */
var COORDS = {
  "A站": [0, 0],   "B站": [0, 1],        // 一对：相距 1km
  "C站": [10, 10], "D站": [10, 11],      // 一对：相距 1km
  "E站": [5, 5],   "F站": [5, 6],        // 一对：相距 1km
  "目的地": [5, 0],
  "S1": [5, 2], "S2": [1, 1], "S3": [9, 10], "S4": [5, 8]
};
MEETING_CANDIDATES = ["S1", "S2", "S3", "S4"];

function _distanceKm(a, b) {
  var dx = a.lng - b.lng, dy = a.lat - b.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

function _geoResolve(name) {
  var c = COORDS[name];
  return Promise.resolve(c ? { ok: true, lng: c[0], lat: c[1] } : { ok: false });
}

/* 口径照抄 mock-api.js 的公式，只是距离换成真实直线距离 */
function queryRoute(origin, dest, mode) {
  var a = COORDS[origin], b = COORDS[dest];
  if (!a || !b) return Promise.resolve({ durationMin: 30, distanceKm: 10, cost: 5 });
  var km = _distanceKm({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
  var min, cost;
  if (mode === "taxi") { min = km / 35 * 60 + 5; cost = Math.round(12 + 2.3 * km); }
  else if (mode === "transit") { min = km / 25 * 60 + 12; cost = 2 + Math.floor(km / 4); }
  else { min = km / 12 * 60; cost = 0; }
  return Promise.resolve({
    durationMin: Math.round(min * 10) / 10,
    distanceKm: Math.round(km * 10) / 10,
    cost: cost
  });
}

/* engine.js 是被 eval 到全局作用域的，它调 queryRoute / _geoResolve 时找的是
   global 上的同名函数；而本文件是 CommonJS 模块，函数声明只在模块内可见。
   所以必须显式挂到 global 上，否则会报 "queryRoute is not defined"。 */
global.queryRoute = queryRoute;
global._geoResolve = _geoResolve;
global._distanceKm = _distanceKm;

/* ---------------- 断言小工具 ---------------- */
var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }

function M(name, origin, mode, budget) {
  return { id: 1, name: name, origin: origin, mode: mode || "transit", budget: budget === undefined ? 0 : budget, window: ["08:00", "09:30"] };
}

/* ---------------- 暴力枚举：所有配对方式里最小的总距离 ---------------- */
function bruteForceBest(pts) {
  var n = pts.length, best = Infinity, bestInfo = null;

  function dist(i, j) { return _distanceKm({ lng: pts[i][0], lat: pts[i][1] },
                                          { lng: pts[j][0], lat: pts[j][1] }); }
  function walk(used, acc, pairs, singles, startSingle) {
    var i = 0;
    while (i < n && used[i]) i++;
    if (i === n) {
      if (acc < best - 1e-9) { best = acc; bestInfo = { pairs: pairs.slice(), singles: singles.slice() }; }
      return;
    }
    /* 允许一个人落单，但最多一个 */
    if (!startSingle) {
      used[i] = true; singles.push(i);
      walk(used, acc, pairs, singles, true);
      singles.pop(); used[i] = false;
    }
    for (var j = i + 1; j < n; j++) {
      if (used[j]) continue;
      used[i] = used[j] = true; pairs.push([i, j]);
      walk(used, acc + dist(i, j), pairs, singles, startSingle);
      pairs.pop(); used[i] = used[j] = false;
    }
  }
  walk(new Array(n).fill(false), 0, [], [], n % 2 === 0 ? true : false);
  return { km: Math.round(best * 10) / 10, info: bestInfo };
}

/* ---------------- 用例 1：6 人 3 对 ---------------- */
function case1() {
  console.log("\n【1】六人、天然形成三对（A-B / C-D / E-F 各相距 1km）");
  var ms = [M("甲", "A站"), M("乙", "B站"), M("丙", "C站"),
            M("丁", "D站"), M("戊", "E站"), M("己", "F站")];
  return generateSchemes(ms, "目的地").then(function (r) {
    var s3 = r.schemes.filter(function (s) { return s.type === "partial"; })[0];
    var got = s3.pairing.pairs;

    /* 名 → 起点，按起点判断配对是否就是"最近的两两配对" */
    var originOf = {};
    ms.forEach(function (m) { originOf[m.name] = m.origin; });
    var gotSet = got.map(function (p) {
      return [originOf[p[0]], originOf[p[1]]].sort().join("+");
    }).sort();
    eq(gotSet, ["A站+B站", "C站+D站", "E站+F站"], "配对结果 = 三对最近的组合");
    eq((s3.pairing.singles || []).length, 0, "偶数人：没有人落单");
    ok(s3.pairing.exact === true, "走的是坐标 DP（exact=true，不是顺序兜底）");

    var pts = ms.map(function (m) { return COORDS[m.origin]; });
    var bf = bruteForceBest(pts);
    ok(Math.abs(bf.km - s3.pairing.totalKm) < 1e-6,
      "与暴力枚举的最优总距离一致（" + s3.pairing.totalKm + "km）", { dp: s3.pairing.totalKm, brute: bf.km });
    console.log("    结对明细：" + got.map(function (p) {
      return p[0] + "↔" + p[1] + "（在" + (s3.legs.filter(function (l) { return l.member === p[0]; })[0].meetAt) + "碰头）";
    }).join("，"));
  });
}

/* ---------------- 用例 2：5 人，必须正好一人落单 ---------------- */
function case2() {
  console.log("\n【2】五人（去掉己）：应恰好 1 人落单，且落单的是 E 站那位");
  var ms = [M("甲", "A站"), M("乙", "B站"), M("丙", "C站"),
            M("丁", "D站"), M("戊", "E站")];
  return generateSchemes(ms, "目的地").then(function (r) {
    var s3 = r.schemes.filter(function (s) { return s.type === "partial"; })[0];
    eq((s3.pairing.singles || []).length, 1, "奇数人：恰好 1 人落单");
    eq(s3.pairing.singles, ["戊"], "落单的是「戊」（A-B、C-D 两对各 1km，留他总距离最小）");

    var pts = ms.map(function (m) { return COORDS[m.origin]; });
    var bf = bruteForceBest(pts);
    ok(Math.abs(bf.km - s3.pairing.totalKm) < 1e-6, "与暴力枚举最优一致（" + bf.km + "km）",
      { dp: s3.pairing.totalKm, brute: bf.km });

    /* 落单的人必须是直达（只有一段行程），结伴的人是两段 */
    var single = s3.legs.filter(function (l) { return l.member === "戊"; })[0];
    eq(single.segments.length, 1, "落单者行程只有一段（直达）");
    var paired = s3.legs.filter(function (l) { return l.member === "甲"; })[0];
    eq(paired.segments.length, 2, "结伴者行程两段（先到集合点、再一起走）");
  });
}

/* ---------------- 用例 3：预算校验 ---------------- */
function case3() {
  console.log("\n【3】预算校验：把「甲」的预算压到 1 元");
  var ms = [M("甲", "A站", "transit", 1),      // A站→目的地 5km，公交 3 元 > 1 元
            M("乙", "B站", "transit", 0),      // 0 = 不限
            M("丙", "C站", "taxi", 100)];
  return generateSchemes(ms, "目的地").then(function (r) {
    var direct = r.schemes.filter(function (s) { return s.type === "direct"; })[0];
    var leg = direct.legs.filter(function (l) { return l.member === "甲"; })[0];
    ok(leg.overBudget === true, "甲的腿被标了 overBudget");
    ok(Math.abs(leg.overBudgetBy - (leg.totalCost - 1)) < 1e-6,
      "超出金额 = 实际费用 − 预算（" + leg.overBudgetBy + " 元）", { cost: leg.totalCost });

    var unlimited = direct.legs.filter(function (l) { return l.member === "乙"; })[0];
    ok(unlimited.overBudget === false, "预算 0（不限）的人不会被误标");

    ok(direct.overBudget.length === 1, "方案级名单只收录 1 人", direct.overBudget);
    eq(direct.overBudget[0].member, "甲", "名单里是「甲」");

    var partial = r.schemes.filter(function (s) { return s.type === "partial"; })[0];
    ok(partial.overBudget.length >= 1, "三个方案用同一套判断（方案三也标了）",
      { partial: partial.overBudget.length });
  });
}

/* ---------------- 用例 4：权重可调 ---------------- */
function case4() {
  console.log("\n【4】打分权重：纯时间权重 / 纯费用权重，各自应选中最优的那个方案");
  var ms = [M("甲", "A站", "taxi", 0), M("乙", "B站", "taxi", 0),
            M("丙", "C站", "taxi", 0), M("丁", "D站", "taxi", 0),
            M("戊", "E站", "taxi", 0), M("己", "F站", "taxi", 0)];

  var runTime = generateSchemes(ms, "目的地", { weights: { totalTime: 1, totalCost: 0, worstTime: 0, maxWait: 0 } });
  return runTime.then(function (rTime) {
    var byTime = rTime.schemes.slice().sort(function (a, b) { return a.metrics.totalTimeMin - b.metrics.totalTimeMin; })[0];
    eq(rTime.schemes[0].type, byTime.type, "权重 100% 看总耗时 → 选中的就是总耗时最小那个（" + byTime.name + "）");
    eq(rTime.weightsName, "自定义", "权重名识别为「自定义」");

    return generateSchemes(ms, "目的地", { weights: { totalTime: 0, totalCost: 1, worstTime: 0, maxWait: 0 } });
  }).then(function (rCost) {
    var byCost = rCost.schemes.slice().sort(function (a, b) { return a.metrics.totalCost - b.metrics.totalCost; })[0];
    eq(rCost.schemes[0].type, byCost.type, "权重 100% 看总费用 → 选中的就是总费用最小那个（" + byCost.name + "）");

    var s = rCost.schemes[0];
    ok(s.scoreDetail && typeof s.scoreDetail.totalCost === "number", "scoreDetail 拆出了四个分项");
    ok(s.score === 0, "改成额外代价口径：该项最优的方案代价为 0（实际 " + s.score + "）");
    ok(rCost.schemes.length > 1 && rCost.schemes[0].score <= rCost.schemes[rCost.schemes.length - 1].score,
      "代价越低越优，第一名不高于最后一名");

    /* 排序方向：score 越低越优，升序排列，第一位就是代价最低的 */
    var sortedAsc = rCost.schemes.every(function (x, i, arr) {
      return i === 0 || arr[i - 1].score <= x.score;
    });
    ok(sortedAsc, "方案按额外代价升序排列（低者在前）");
    ok(s.score < 100, "不再是「第一名恒 100 分」的旧口径");

    return generateSchemes(ms, "目的地", { weights: WEIGHT_PRESETS.comfort });
  }).then(function (rComfort) {
    eq(rComfort.weightsName, "少等待", "直接传预设对象也能识别出名字");
  });
}

/* ---------------- 用例 5：无坐标退化 ---------------- */
function case5() {
  console.log("\n【5】没有坐标（Key 失效 / 假数据环境）：应退化为按录入顺序配对，且不抛错");
  var saved = global._geoResolve;
  global._geoResolve = undefined;          // 模拟 amap-api.js 不存在的环境
  var ms = [M("甲", "A站"), M("乙", "B站"), M("丙", "C站")];
  return generateSchemes(ms, "目的地").then(function (r) {
    global._geoResolve = saved;
    var s3 = r.schemes.filter(function (s) { return s.type === "partial"; })[0];
    ok(s3.pairing.exact === false, "exact=false，说明走了顺序兜底");
    eq(s3.pairing.reason, "no-coords", "退化原因写清楚了");
    eq(s3.pairing.pairs.length, 1, "3 人 → 1 组结伴 + 1 人落单");
    eq(r.schemes.length, 3, "三个方案照常产出，页面不会白屏");
  }).catch(function (e) {
    global._geoResolve = saved;
    ok(false, "无坐标环境抛错了：" + e.message);
  });
}

/* ---------------- 用例 6：0 人边界 ---------------- */
function case6() {
  console.log("\n【6】边界：0 人");
  return generateSchemes([], "目的地").then(function (r) {
    eq(r.schemes.length, 1, "0 人：只保留方案一（没有正文可算）");
    ok(r.schemes.every(function (s) { return s.metrics.totalTimeMin === 0; }), "指标全为 0，没有 NaN");
  });
}

/* ---------------- 用例 7：单人场景（测试清单 Q-02） ---------------- */
function case7() {
  console.log("\n【7】单人场景（Q-02）：只该出方案一，且不该白发 geocode 请求");
  var calls = { route: 0, geo: 0 };
  var baseRoute = global.queryRoute, baseGeo = global._geoResolve;
  global.queryRoute = function () { calls.route++; return baseRoute.apply(null, arguments); };
  global._geoResolve = function () { calls.geo++; return baseGeo.apply(null, arguments); };

  var ms = [M("张海燕", "A站", "transit", 20)];
  return generateSchemes(ms, "目的地").then(function (r) {
    global.queryRoute = baseRoute;
    global._geoResolve = baseGeo;

    eq(r.schemes.length, 1, "只有 1 张卡片（方案二、方案三不再出现）");
    eq(r.schemes[0].type, "direct", "留下的就是方案一：全部直达");
    eq(r.skipped.map(function (s) { return s.type; }), ["meet", "partial"], "skipped 里写清跳过了哪两套");
    ok(r.skipped.every(function (s) { return !!s.reason; }), "每套都给了不适用的原因",
      r.skipped.map(function (s) { return s.reason; }));
    ok(r.schemes[0].conclusion.indexOf("只有你 1 人") >= 0, "结论里说明了为什么只有一套方案",
      r.schemes[0].conclusion);

    eq(r.schemes[0].metrics.maxWaitMin, 0, "最长等待为 0（一个人不用等人）");
    eq(r.schemes[0].legs.length, 1, "只有一条腿");
    /* 额外代价口径下，只有一套方案时它自己就是基准 → 代价 0，不再出现 100.6 分那种怪数 */
    eq(r.schemes[0].score, 0, "额外代价为 0（自己就是基准）");
    ok(isFinite(r.schemes[0].score), "得分是有限数字，没有 NaN");

    eq(calls.route, 1, "只发了 1 次路线请求（原来单人也要 10 次左右）");
    eq(calls.geo, 0, "方案一不需要坐标，一次 geocode 都没发");
  }).catch(function (e) {
    global.queryRoute = baseRoute;
    global._geoResolve = baseGeo;
    ok(false, "单人场景抛错了：" + e.message);
  });
}

/* ---------------- 用例 8：双人场景（方案三与方案二等价） ---------------- */
function case8() {
  console.log("\n【8】双人场景：方案三与方案二等价，应只出两套");
  var ms = [M("甲", "A站"), M("乙", "B站")];
  return generateSchemes(ms, "目的地").then(function (r) {
    eq(r.schemes.map(function (s) { return s.type; }).sort(), ["direct", "meet"], "两套：直达 + 全员汇合");
    eq(r.skipped.map(function (s) { return s.type; }), ["partial"], "方案三被标为不适用");
    ok(r.schemes[0].conclusion.indexOf("等价") >= 0, "结论里解释了方案三为什么省掉",
      r.schemes[0].conclusion);
    var meet = r.schemes.filter(function (s) { return s.type === "meet"; })[0];
    eq(meet.legs.length, 2, "方案二两条腿，两人都到同一个集合点");
    ok(!!meet.meetingPoint, "方案二有集合点");
    ok(r.schemes.every(function (s) { return isFinite(s.score); }), "两套方案的额外代价都是有效数字",
      r.schemes.map(function (s) { return s.score; }));
  });
}

/* ---------------- 跑 ---------------- */
case1()
  .then(case2).then(case3).then(case4).then(case5).then(case6).then(case7).then(case8)
  .then(function () {
    console.log("\n================ 结果：" + pass + " 通过 / " + fail + " 失败 ================");
    if (fail) process.exit(1);
  })
  .catch(function (e) { console.error("用例执行出错:", e); process.exit(1); });
