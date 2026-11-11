/* ============================================================
 * test-any-city.js — 任意城市自测【张海燕 · 2026-11-11】
 *
 * 用法：
 *   node test-any-city.js 长沙
 *   node test-any-city.js 长沙 桂林 昆山     // 一次测多个
 *
 * 它会走和页面完全一样的链路：
 *   城市名 → 查 adcode/中心点 → 搜地铁站 → 生成示例成员 → 跑三方案
 * 用来确认"用户随便输一个城市，能不能真的出结果"，重点看最后一行
 * 【降级 0 / 限频重试 0】——有降级说明那个城市的地名解析不出来。
 * 需要联网 + js/config.local.js 里有 Key。
 * ============================================================ */
var fs = require("fs"), path = require("path");

if (fs.existsSync(path.join(__dirname, "js/config.local.js"))) {
  (0, eval)(fs.readFileSync(path.join(__dirname, "js/config.local.js"), "utf8"));
} else {
  console.log("提示：没找到 js/config.local.js，无法联网查城市。");
  process.exit(1);
}

["js/formats.js", "js/result-text.js", "js/amap-api.js", "js/cities.js", "js/city-online.js", "js/engine.js"]
  .forEach(function (f) { (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8")); });

var LIST = process.argv.slice(2);
if (!LIST.length) LIST = ["长沙"];

function run(i) {
  if (i >= LIST.length) { console.log("\n全部完成"); return Promise.resolve(); }
  var name = LIST[i];
  console.log("\n══════ " + name + " ══════");

  return prepareOnlineCity(name).then(function (online) {
    var city = addCustomCity(online);
    applyCity(city.key);
    console.log("adcode(公交)=" + city.adcode + "  poiAdcode=" + (city.poiAdcode || city.adcode));
    console.log("候选集合点：" + city.stations.join(" / "));
    console.log("示例成员：" + city.members.map(function (m) {
      return m.name + "@" + m.origin + "(" + m.mode + ")";
    }).join(" | "));

    var dest = city.destExample || city.stations[0];
    console.log("目的地示例：" + dest);

    var mem = city.members.map(function (m, k) {
      return { id: k + 1, name: m.name, origin: m.origin, mode: m.mode, budget: m.budget, window: m.window };
    });

    return generateSchemes(mem, dest).then(function (r) {
      r.schemes.forEach(function (s, k) {
        console.log("  #" + (k + 1) + " " + s.name +
          "  总耗时 " + s.metrics.totalTimeMin + "分" +
          "  总费用 ¥" + s.metrics.totalCost +
          "  得分 " + s.score);
      });
      var st = amapStats();
      var bad = st["降级估算次数"];
      console.log("  " + (bad ? "⚠" : "✓") + " 降级 " + bad + " / 限频重试 " + st["限频重试"] + " / 请求 " + st["累计真实请求"]);
      if (st["最近降级原因"].length) console.log("  降级原因：" + st["最近降级原因"].join(" ; "));
      return run(i + 1);
    });
  }).catch(function (e) {
    console.log("  ✗ " + e.message);
    return run(i + 1);
  });
}

run(0);
