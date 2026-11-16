/* 估算 vs 真实 误差实验 v2（雷馨怡 · 2026-11-16）
   用全局 eval 把 cities.js + amap-api.js 装进全局作用域：
   这样 applyCity() 切城市真正生效（直接 require 会被模块局部变量遮蔽，实测切不动）。 */
const fs = require("fs");
globalThis.__AMAP_KEY__ = "3995b9ecbe62bebaf064a1a8e0cd4c84";
["js/cities.js", "js/amap-api.js"].forEach(f => {
  (0, eval)(fs.readFileSync("C:/Users/leixi/WorkBuddy/2026-11-09-16-47-30/_repo/" + f, "utf8"));
});

const STUDY = {
  wuhan: [["武汉站","楚河汉街"],["汉口火车站","江汉路"],["光谷广场","黄鹤楼"],["洪山广场","中山公园"],
          ["循礼门","武昌火车站"],["街道口","汉口江滩"],["武汉站","归元寺"],["光谷广场","汉口火车站"],
          ["户部巷","昙华林"],["中南财经政法大学","武汉站"]],
  beijing: [["北京南站","天安门广场"],["西二旗","国贸"],["望京","北京西站"],["东直门","颐和园"],
            ["中关村","三里屯"],["北京站","首都图书馆"],["五道口","前门"],["亮马桥","圆明园"],
            ["北京南站","西二旗"],["天坛","后海"]],
  shanghai: [["上海虹桥站","外滩"],["徐家汇","陆家嘴"],["人民广场","豫园"],["世纪大道","静安寺"],
             ["中山公园","南京东路"],["上海站","徐家汇"],["张江高科","人民广场"],["虹桥火车站","豫园"],
             ["陆家嘴","上海虹桥站"],["田子坊","世纪公园"]]
};
const MODES = ["transit", "taxi", "bike"];

function hav(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

(async () => {
  const rows = [];
  for (const key of Object.keys(STUDY)) {
    applyCity(key);                      // 正规切城市路径，和页面行为一致
    console.error("城市:", AMAP_CITY, AMAP_CITY_ADCODE, AMAP_CITY_CENTER);
    for (const [o, d] of STUDY[key]) {
      _runUsed = 0;                      // 每组重置预算，模拟页面里"点一次生成"
      const g1 = await _geoResolve(o), g2 = await _geoResolve(d);
      const straight = (g1.ok && g2.ok) ? hav(g1, g2) : null;
      for (const mode of MODES) {
        const real = await queryRoute(o, d, mode);
        const est = _estimate(o, d, mode, "study");
        rows.push({
          city: AMAP_CITY, o, d, mode,
          straightKm: straight === null ? null : Math.round(straight * 10) / 10,
          realKm: real.distanceKm, realMin: real.durationMin, estKm: est.distanceKm, estMin: est.durationMin,
          errPct: (real.estimated || !isFinite(real.durationMin)) ? null
                  : Math.round((est.durationMin - real.durationMin) / real.durationMin * 100),
          realEstimated: !!real.estimated, fallback: real.fallback || ""
        });
      }
      console.error(`  ${o} → ${d} 完成`);
    }
  }
  fs.writeFileSync("/tmp/study-rows.json", JSON.stringify(rows, null, 1));
  console.log("rows:", rows.length, "降级:", rows.filter(r => r.realEstimated).length,
              "城市核对:", [...new Set(rows.map(r => r.city))].join(","));
})();
