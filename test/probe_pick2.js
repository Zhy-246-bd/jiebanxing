/* ============================================================
 * probe_pick2.js — 复现"applyCity 清缓存冲掉选点坐标"的 bug
 * 跑法：node test/probe_pick2.js
 *   修复前：❌ 选点坐标被冲掉了
 *   修复后：✅ 选点坐标保住了（且与旧城市同名地名不串号）
 *
 * 纯内存验证，不发任何网络请求（不读 config.local.js）。
 * 装载方式与页面一致：把 cities.js / amap-api.js 装进全局作用域，
 * 否则 require 的模块局部变量会遮蔽全局，applyCity 切不动城市。
 * ============================================================ */
const fs = require("fs");
const path = require("path");

globalThis.__AMAP_KEY__ = "";   // 无 Key：seedCoord 命中缓存即可，不触发任何 geocode 请求

["js/cities.js", "js/amap-api.js"].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
});

const NAME = "楚河汉街";                       // 模拟用户从联想/地图选点输入的地名
const POI = { lng: 114.3666, lat: 30.5566 };  // 选点拿到的精确 POI 坐标

function seedReadback() {
  // seedCoord 写的是 _geoCache[_ck(name)]，值形如 {t, v:{ok,lng,lat,source:"选点"}, ttl}
  const hit = _geoCache[_ck(NAME)];
  return hit && hit.v;
}

applyCity("wuhan");
const seeded = seedCoord(NAME, POI.lng, POI.lat);
const before = seedReadback();
const seedOK = seeded && before && before.ok && before.source === "选点" &&
  Math.abs(before.lng - POI.lng) < 1e-6 && Math.abs(before.lat - POI.lat) < 1e-6;

console.log("① seedCoord 写入精确坐标        : " + (seedOK ? "OK" : "FAIL"));

// 关键一步：模拟 doGenerate() 里的 applyCity(state.cityKey) —— 注意是同一个城市
applyCity("wuhan");
const after = seedReadback();
const kept = after && after.ok && after.source === "选点" &&
  Math.abs(after.lng - POI.lng) < 1e-6 && Math.abs(after.lat - POI.lat) < 1e-6;

console.log("② applyCity(同城市)后坐标仍在   : " + (kept ? "OK" : "FAIL（缓存被清空，坐标丢失）"));

// 顺带验证：切到别的城市再切回来，同名地名不会串号（缓存 key 带城市前缀）
applyCity("shanghai");
const shCache = _geoCache[_ck(NAME)];
const noCross = !shCache || !shCache.v || shCache.v.source !== "选点";
console.log("③ 切上海后武汉坐标不被误命中   : " + (noCross ? "OK" : "FAIL（跨城市串号）"));

applyCity("wuhan");
const back = seedReadback();
const roundTrip = back && back.ok && Math.abs(back.lng - POI.lng) < 1e-6;
console.log("④ 切回武汉坐标可恢复           : " + (roundTrip ? "OK" : "FAIL"));

// ⑤ 同名异地：武汉/上海都有"中山公园"，各自 seed 不同坐标，来回切换互不串号
const SAME = "中山公园";
const WH = { lng: 114.3101, lat: 30.5850 };
const SH = { lng: 121.4600, lat: 31.2230 };
applyCity("wuhan");  seedCoord(SAME, WH.lng, WH.lat);
applyCity("shanghai"); seedCoord(SAME, SH.lng, SH.lat);
applyCity("wuhan");
const whBack = _geoCache[_ck(SAME)].v;
applyCity("shanghai");
const shBack = _geoCache[_ck(SAME)].v;
const sameNoCross = Math.abs(whBack.lng - WH.lng) < 1e-6 && Math.abs(shBack.lng - SH.lng) < 1e-6;
console.log("⑤ 同名\"中山公园\"两城各读各的  : " + (sameNoCross ? "OK" : "FAIL（串号）"));

const pass = seedOK && kept && noCross && roundTrip && sameNoCross;
console.log("\n" + (pass ? "✅ 选点坐标保住了" : "❌ 选点坐标被冲掉了"));
process.exit(pass ? 0 : 1);
