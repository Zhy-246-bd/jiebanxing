/* ============================================================
 * test-amap.js — 地名解析回归测试【雷馨怡 · 2026-11-16】
 *
 * 用途：谁改了 amap-api.js 的解析逻辑，跑一遍就知道有没有把解析打崩。
 * 跑法：node test-amap.js [城市key ...]     （不传参数 = 全部 6 城）
 *
 * 每城 10 个地名，覆盖四类难点：
 *   · 枢纽站名（武汉站 / 北京南站…）
 *   · 商圈短名（光谷、国贸、田子坊——高德地址接口最容易查不到的）
 *   · 同名异地（中山公园：武汉上海都有；人民公园：成都）——换城市跑两遍验证不串
 *   · 带门牌号（珞喻路129号 / 南京西路1266号）
 *
 * 输出：每城成功率、平均耗时、失败清单。整体成功率 < 85% 就算回归失败。
 * 注意：本脚本会发真实请求（约 60 次），别在配额快见底的日子跑。
 * ============================================================ */
const fs = require("fs");
const path = require("path");

globalThis.__AMAP_KEY__ = (function () {
  try {
    // 优先读 config.local.js（不进仓库），没有就用环境变量
    const cfg = fs.readFileSync(path.join(__dirname, "js/config.local.js"), "utf8");
    const m = cfg.match(/__AMAP_KEY__\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  } catch (e) { /* 没有 config.local.js */ }
  return process.env.AMAP_KEY || "";
})();

/* 装进全局作用域：直接 require 会被模块局部变量遮蔽，applyCity 切不动城市 */
["js/cities.js", "js/amap-api.js"].forEach(f => {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), "utf8"));
});

const NAMES = {
  wuhan: ["武汉站", "汉口火车站", "光谷", "中山公园", "楚河汉街", "黄鹤楼", "珞喻路129号", "昙华林", "循礼门", "街道口"],
  beijing: ["北京南站", "西二旗", "国贸", "中山公园", "望京", "颐和园", "中关村", "三里屯", "五道口", "景山前街4号"],
  shanghai: ["上海虹桥站", "徐家汇", "田子坊", "中山公园", "豫园", "陆家嘴", "南京西路1266号", "静安寺", "张江高科", "世纪大道"],
  guangzhou: ["广州南站", "体育西路", "客村", "北京路", "珠江新城", "天河体育中心", "公园前", "沙面", "上下九", "天河北路"],
  shenzhen: ["深圳北站", "世界之窗", "车公庙", "海上世界", "福田", "老街", "华强北", "深圳湾公园", "东门", "侨香路"],
  chengdu: ["成都东站", "春熙路", "宽窄巷子", "人民公园", "天府广场", "犀浦", "武侯祠", "太古里", "杜甫草堂", "金沙遗址"]
};

(async () => {
  if (!__AMAP_KEY__) {
    console.log("未找到 Key：把 js/config.local.js 建好（复制 config.example.js），或设环境变量 AMAP_KEY。");
    process.exit(1);
  }
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(NAMES);
  let total = 0, ok = 0, failed = [], sumMs = 0;

  for (const key of keys) {
    if (!NAMES[key]) { console.log("未知城市:", key, "可选:", Object.keys(NAMES).join(",")); continue; }
    applyCity(key);
    const names = NAMES[key];
    let cityOk = 0;
    const t0 = Date.now();
    for (const n of names) {
      const t1 = Date.now();
      const r = await _geoResolve(n);
      const ms = Date.now() - t1;
      sumMs += ms; total++;
      if (r.ok) { ok++; cityOk++; }
      else failed.push(key + " · " + n);
      process.stdout.write(`  ${AMAP_CITY} ${n} -> ${r.ok ? (r.lng.toFixed(4) + "," + r.lat.toFixed(4) + " [" + r.source + "] " + r.name.slice(0, 22)) : "✘ 失败"}  (${ms}ms)\n`);
    }
    console.log(`${AMAP_CITY}: ${cityOk}/${names.length}  城市小计 ${Date.now() - t0}ms\n`);
  }

  const rate = Math.round(ok / total * 100);
  console.log(`======== 汇总 ========`);
  console.log(`成功率: ${ok}/${total} = ${rate}%   平均耗时 ${Math.round(sumMs / total)}ms/个`);
  if (failed.length) console.log("失败清单:\n  " + failed.join("\n  "));
  process.exit(rate >= 85 ? 0 : 1);
})();
