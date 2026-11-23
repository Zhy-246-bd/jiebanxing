/* ============================================================
 * map-view.js — 结果页地图可视化【张宇桐 · 2026-11-12】
 *
 * 职责：把 localStorage["jbx_result"] 里的三方案画到高德 JS API 地图上。
 *   · 全员起点（蓝点 + 成员名）、集合点（黄点）、目的地（红星）
 *   · 每段行程按出行方式画真实路线：地铁/公交=蓝、打车=橙、骑行=绿
 *   · 方案一 / 二 / 三 顶部切换，默认展示推荐方案
 *   · 路线规划失败的地段自动退化为虚线直线，地图永远完整
 *
 * Key 配置（不进仓库，和 __AMAP_KEY__ 同一个文件 js/config.local.js）：
 *   g.__AMAP_JS_KEY__  = "Web端(JS API) 类型的 Key"      // 找雷馨怡拿
 *   g.__AMAP_JS_CODE__ = "配套的安全密钥 jscode"
 *   没配 JS Key 时这里只显示一段配置指引，页面其他功能不受影响。
 *
 * 样式全部由本文件注入 <style>，不碰 css/style.css（陈滢竹的文件）。
 * 地名→坐标用 AMap.Geocoder（本市优先，全国兜底），带缓存去重。
 *
 * 纯函数部分（extractPlaces）在 Node 下可单测：node test-map-view.js
 * ============================================================ */
(function (g) {
  "use strict";

  /* ---------------- 0. 配置 ----------------
   * 本网页项目的写法（js/config.local.js）：
   *   g.__AMAP_JS_KEY__  = "Web端(JS API) 类型的 Key"
   *   g.__AMAP_JS_CODE__ = "配套的安全密钥 jscode"
   * 同时兼容雷馨怡交接包里的命名（JS_API_KEY / JS_API_SECURITY_CODE），
   * 也兼容对象形式 g.__AMAP_CONFIG__ = { JS_API_KEY, JS_API_SECURITY_CODE }，
   * 这样以后两边合并、共用同一份配置时不用改代码。 */
  function pickKey(g, names) {
    for (var i = 0; i < names.length; i++) {
      var v = g[names[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    var cfg = g.__AMAP_CONFIG__;
    if (cfg && typeof cfg === "object") {
      for (var j = 0; j < names.length; j++) {
        var c = cfg[names[j]];
        if (typeof c === "string" && c.trim()) return c.trim();
      }
    }
    return "";
  }
  var JS_KEY  = pickKey(g, ["__AMAP_JS_KEY__", "JS_API_KEY", "AMAP_JS_KEY"]);
  var JS_CODE = pickKey(g, ["__AMAP_JS_CODE__", "JS_API_SECURITY_CODE", "AMAP_SECURITY_CODE"]);

  /* 坐标"真的存在"才算数：isFinite(null) 和 isFinite("") 都是 true，
     只写 isFinite 会把"没坐标"当成坐标 0（几内亚湾）。
     2026-11-19 闫雅欣：map-view 里所有坐标判空统一走这里。 */
  function hasCoord(lng, lat) {
    return lng !== null && lng !== undefined && lng !== "" &&
           lat !== null && lat !== undefined && lat !== "" &&
           isFinite(lng) && isFinite(lat);
  }

  /* ---------------- 配色：统一读 css/result.css :root 的 6 个 --jbx-* 变量 ----------------
   * 陈滢竹换主题只改 result.css 那 6 个值，图例 / 标记 / 路线会自动一起变，
   * 不用 !important 硬压，也不会出现「图例是旧色、线是新色」。
   * 注意：高德 Polyline 的 strokeColor 不认 var(--x)（底层 canvas/SVG 绘制），
   * 必须解析成真实色值再传；result.css 没加载时退回下面兜底色，保证不白屏。 */
  var COLOR_FALLBACK = {
    transit: "#3182ce", taxi: "#dd6b20", bike: "#38a169",
    start: "#3182ce", meet: "#f6c344", dest: "#e53e3e"
  };
  var CSS_VAR = {
    transit: "--jbx-transit", taxi: "--jbx-taxi", bike: "--jbx-bike",
    start: "--jbx-start", meet: "--jbx-meet", dest: "--jbx-dest"
  };
  function themeColor(key) {
    var v = "";
    try {
      if (typeof window !== "undefined" && window.getComputedStyle && document.documentElement) {
        v = (window.getComputedStyle(document.documentElement)
          .getPropertyValue(CSS_VAR[key]) || "").trim();
      }
    } catch (e) { /* 变量未定义或非浏览器环境 → 用兜底 */ }
    /* 只接受浏览器能画的色值，避免 result.css 里写错值把地图画花 */
    return /^(#|rgb|hsl)/i.test(v) ? v : COLOR_FALLBACK[key];
  }
  var TIMEOUT_MS = 15000;     // 单次路线规划 / 地名解析的超时
  var MIN_INTERVAL_MS = 600;  // 两次请求的最小间隔：个人 Key 约 3 QPS，连着打会被限频（10021）
  var MAX_CONCURRENT = 2;     // 并发上限

  /* ---------------- 请求队列：限频 + 并发上限 ----------------
   * js/amap-api.js 里雷馨怡已经踩过这个坑：个人 Key 只有 3 QPS，
   * 并发开大 + 请求又密 → 返回 10021，路线规划静默失败。
   * 所以这里也做「并发 2 + 全局最小间隔 600ms」，宁可慢一点，别丢结果。 */
  var _reqQueue = [], _reqActive = 0, _nextSlotAt = 0;
  function schedule(task) {
    return new Promise(function (resolve) {
      _reqQueue.push(function () { task().then(resolve, resolve); });
      _pump();
    });
  }
  function _pump() {
    if (_reqActive >= MAX_CONCURRENT || !_reqQueue.length) return;
    var now = Date.now();
    var at = Math.max(now, _nextSlotAt);
    _nextSlotAt = at + MIN_INTERVAL_MS;
    var fn = _reqQueue.shift();
    _reqActive++;
    setTimeout(function () {
      fn();
      _reqActive--;
      _pump();
    }, Math.max(0, at - now));
  }

  /* ---------------- 1. 纯逻辑：从 jbx_result 抽地点清单（Node 可测） ----------------
   * 返回 {
   *   origins: [{ place, members:[成员名] }],   // 去重后的起点（同名起点合并）
   *   dest:    "目的地名",
   *   meets:   ["集合点名", ...],               // 全部方案里出现过的集合点
   *   places:  ["所有需要解析坐标的地名", ...]    // origins+dest+meets 的并集
   * }
   * schemes[i].segments 的 from/to 一定 ∈ places —— 这是画线的坐标系。 */
  function extractPlaces(data) {
    if (!data || !data.result || !Array.isArray(data.result.schemes)) {
      return { origins: [], dest: "", meets: [], places: [] };
    }
    var dest = data.dest || "";
    var originMembers = {};   // place -> [成员名]
    (data.members || []).forEach(function (m) {
      if (!m || !m.origin) return;
      (originMembers[m.origin] = originMembers[m.origin] || []).push(m.name || "成员");
    });
    var origins = Object.keys(originMembers).map(function (p) {
      return { place: p, members: originMembers[p] };
    });

    var meetSet = {};
    data.result.schemes.forEach(function (s) {
      (s.legs || []).forEach(function (l) {
        (l.segments || []).forEach(function (seg) {
          [seg.from, seg.to].forEach(function (n) {
            if (!n || n === dest || originMembers[n]) return;
            meetSet[n] = 1;
          });
        });
      });
    });
    var meets = Object.keys(meetSet);

    var placeSet = {};
    origins.forEach(function (o) { placeSet[o.place] = 1; });
    if (dest) placeSet[dest] = 1;
    meets.forEach(function (m) { placeSet[m] = 1; });

    return { origins: origins, dest: dest, meets: meets, places: Object.keys(placeSet) };
  }

  /* 取某个方案涉及的全部线段（展开成一维数组） */
  function extractSegments(scheme) {
    var out = [];
    ((scheme && scheme.legs) || []).forEach(function (l) {
      (l.segments || []).forEach(function (seg) { out.push(seg); });
    });
    return out;
  }

  /* Node 环境：只暴露纯函数做单测，浏览器初始化逻辑全部跳过 */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractPlaces: extractPlaces, extractSegments: extractSegments };
  }
  if (typeof document === "undefined" || typeof localStorage === "undefined") return;

  /* ---------------- 2. 样式注入（不动 css/style.css） ---------------- */
  var STYLE_ID = "jbx-map-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "#mapBox{background:#fff;border-radius:12px;margin-top:12px;padding:12px;box-shadow:0 1px 4px rgba(0,0,0,.06)}",
      "#mapTabs{display:flex;gap:6px;margin-bottom:10px}",
      ".jbx-tab{flex:1;border:none;border-radius:8px;padding:7px 0;font-size:13px;cursor:pointer;",
      "  background:#ebf4ff;color:#2b6cb0;font-family:inherit}",
      ".jbx-tab.on{background:#2b6cb0;color:#fff;font-weight:600}",
      "#mapArea{height:340px;border-radius:10px;overflow:hidden;background:#eef2f6}",
      ".jbx-map-note{padding:26px 18px;font-size:13px;color:#718096;line-height:1.9;text-align:center}",
      ".jbx-map-note b{color:#2d3748}",
      ".jbx-map-note .k{display:inline-block;background:#f0f4f8;border-radius:4px;padding:0 6px;",
      "  color:#2b6cb0;font-family:monospace;font-size:12px}",
      "#mapHint{font-size:11px;color:#718096;margin-top:8px;min-height:14px;text-align:center}",
      ".jbx-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;font-size:11px;color:#718096}",
      ".jbx-legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:4px;vertical-align:middle}",
      ".jbx-legend .dot{width:9px;height:9px;border-radius:50%}",
      "/* 地图上的自定义标记 */",
      ".jbx-mk{position:relative}",
      ".jbx-mk-dot{display:block;width:14px;height:14px;border-radius:50%;border:2.5px solid #fff;",
      "  box-shadow:0 1px 4px rgba(0,0,0,.35)}",
      ".jbx-mk-start .jbx-mk-dot{background:var(--jbx-start,#3182ce)}",
      ".jbx-mk-meet  .jbx-mk-dot{background:var(--jbx-meet,#f6c344);border-color:#fff}",
      ".jbx-mk-dest  .jbx-mk-star{display:block;font-size:20px;line-height:1;color:var(--jbx-dest,#e53e3e);",
      "  text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;font-weight:700}",
      ".jbx-mk-label{position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);",
      "  white-space:nowrap;background:rgba(255,255,255,.95);border:1px solid #d8e1ea;border-radius:5px;",
      "  padding:1px 6px;font-size:11px;color:#2d3748;box-shadow:0 1px 3px rgba(0,0,0,.15)}"
    ].join("");
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- 3. 取数 ---------------- */
  function readData() {
    try { return JSON.parse(localStorage.getItem("jbx_result") || "null"); }
    catch (e) { return null; }
  }

  /* ---------------- 4. 降级提示（无 Key / 加载失败 / 无数据） ---------------- */
  function showNote(area, title, lines) {
    area.innerHTML = '<div class="jbx-map-note"><b>' + title + '</b><br>' +
      lines.map(function (l) { return '<span style="display:block">' + l + '</span>'; }).join("") +
      '</div>';
  }
  function showNoKey(area) {
    showNote(area, "🗺️ 地图待接入（其余功能不受影响）", [
      "在 <span class='k'>js/config.local.js</span> 里补两行（Key 找雷馨怡拿）：",
      "<span class='k'>g.__AMAP_JS_KEY__ = \"Web端(JS API)类型的Key\"</span>",
      "<span class='k'>g.__AMAP_JS_CODE__ = \"配套的安全密钥\"</span>",
      "保存后刷新本页即可显示三方案路线地图。"
    ]);
  }

  /* ---------------- 5. 动态加载高德 JS API 2.0 ---------------- */
  function loadAMap(cb) {
    if (g.AMap && g.AMap.Map) return cb(null);
    if (JS_CODE) g._AMapSecurityConfig = { securityJsCode: JS_CODE };
    var s = document.createElement("script");
    s.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(JS_KEY) +
      "&plugin=AMap.PlaceSearch,AMap.Geocoder,AMap.Driving,AMap.Transfer,AMap.Riding";
    s.onload = function () { cb(g.AMap && g.AMap.Map ? null : new Error("AMap 对象不可用")); };
    s.onerror = function () { cb(new Error("脚本加载失败（网络不通或被拦截）")); };
    document.head.appendChild(s);
  }

  /* 超时包装：任何规划/解析失败都 resolve(null)，绝不 reject，绝不卡死页面 */
  function withTimeout(factory, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      Promise.resolve().then(factory).then(
        function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
      );
    });
  }

  /* ---------------- 6. 地名 → 坐标 ----------------
   * 踩过的坑：只用 Geocoder（geocode 地址接口）解析「黄鹤楼」这类 POI 名会偶发失败
   * （地址接口对景点/地铁站这种 POI 名字支持不稳，实测同一批数据时好时坏）。
   * 所以改成四级兜底，每次都新建实例（AMap 的服务对象不保证可重入，复用会串状态）：
   *   ① POI 检索（限本城市）→ ② 地址解析（限本城市）→ ③ POI 检索（全国）→ ④ 地址解析（全国）
   * POI 检索对「武昌火车站」「洪山广场」「黄鹤楼」这类名字命中率最高，放第一位。 */
  function makeGeocoder(AMap, city) {
    var cache = {};

    function locOf(loc) {
      if (!loc) return null;
      if (typeof loc === "string") {
        var p = loc.split(",");
        var lng = Number(p[0]), lat = Number(p[1]);
        return (isFinite(lng) && isFinite(lat)) ? [lng, lat] : null;
      }
      // ⚠ isFinite(null) === true、isFinite('') === true：这里必须显式排除空值，
      //   否则"没有坐标"会变成 [0, 0]，蓝点画到几内亚湾去。
      if (!hasCoord(loc.lng, loc.lat)) return null;
      return [Number(loc.lng), Number(loc.lat)];
    }
    /* POI 检索：地铁站/景点/广场这类名字用它最准 */
    function byPoi(name, limitCity) {
      return schedule(function () {
        return withTimeout(function () {
          return new Promise(function (resolve) {
            var ps = limitCity
              ? new AMap.PlaceSearch({ city: city, citylimit: true, pageSize: 5 })
              : new AMap.PlaceSearch({ pageSize: 5 });
            ps.search(name, function (status, result) {
              var pois = (status === "complete" && result && result.poiList && result.poiList.pois) || [];
              if (!pois.length) return resolve(null);
              /* 多个同名结果时，优先名字里含关键词的 */
              var key = String(name).replace(/[（(].*?[)）]/g, "");
              var pick = null;
              for (var i = 0; i < pois.length; i++) {
                if (String(pois[i].name || "").indexOf(key) >= 0) { pick = pois[i]; break; }
              }
              pick = pick || pois[0];
              resolve(locOf(pick.location));
            });
          });
        }, TIMEOUT_MS);
      });
    }
    /* 地址解析：真地址（门牌号、小区名）用它 */
    function byGeo(name, limitCity) {
      return schedule(function () {
        return withTimeout(function () {
          return new Promise(function (resolve) {
            var geo = limitCity
              ? new AMap.Geocoder({ city: city })
              : new AMap.Geocoder();
            geo.getLocation(name, function (status, result) {
              resolve(status === "complete"
                ? locOf(result && result.geocodes && result.geocodes[0] && result.geocodes[0].location)
                : null);
            });
          });
        }, TIMEOUT_MS);
      });
    }
    return {
      one: function (name) {
        if (cache[name] !== undefined) return cache[name];
        cache[name] = byPoi(name, true)
          .then(function (p) { return p || byGeo(name, true); })
          .then(function (p) { return p || byPoi(name, false); })
          .then(function (p) { return p || byGeo(name, false); });
        return cache[name];
      }
    };
  }

  /* ---------------- 7. 路线规划（三种方式，几何防御式提取） ----------------
   * 高德 2.0 三种插件返回结构完全不同，实测抓到的结构：
   *   驾车 Driving：route.steps[i].path        （route 上没有 path）
   *   公交换乘 Transfer：plan.path             （plan 上直接有 path）
   *   骑行 Riding：route.rides[i].path         （既没有 path 也没有 steps）
   * 所以这里逐个兼容，抽不出来就返回 null → 上层画虚线直线兜底。 */
  function collectPath(obj) {
    if (!obj) return null;
    if (obj.path && obj.path.length) return obj.path;
    var steps = obj.steps || obj.segments || obj.rides || [];
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var p = s.path || (s.transit && s.transit.path) || null;
      if (p && p.length) { out = out.concat(p); }
      else if (s.start_position && s.end_position) { out.push(s.start_position, s.end_position); }
    }
    return out.length ? out : null;
  }

  function makePlanner(AMap, city) {
    var cache = {};

    /* 三种方式各包一层：统一返回 { path, status }
       status 不是 complete / path 取不到 → 上层记为失败并提示原因 */
    function drive(o, d) {
      return schedule(function () {
        return withTimeout(function () {
          return new Promise(function (resolve) {
            new AMap.Driving({ autoFitView: false }).search(o, d, function (status, result) {
              var r = result && result.routes && result.routes[0];
              resolve({ status: status, path: r ? collectPath(r) : null, kind: "驾车" });
            });
          });
        }, TIMEOUT_MS);
      });
    }
    function ride(o, d) {
      return schedule(function () {
        return withTimeout(function () {
          return new Promise(function (resolve) {
            new AMap.Riding({ autoFitView: false }).search(o, d, function (status, result) {
              var r = result && result.routes && result.routes[0];
              resolve({ status: status, path: r ? collectPath(r) : null, kind: "骑行" });
            });
          });
        }, TIMEOUT_MS);
      });
    }
    function transit(o, d) {
      return schedule(function () {
        return withTimeout(function () {
          return new Promise(function (resolve) {
            new AMap.Transfer({ city: city, autoFitView: false }).search(o, d, function (status, result) {
              var p = result && result.plans && result.plans[0];
              resolve({ status: status, path: p ? collectPath(p) : null, kind: "公交" });
            });
          });
        }, TIMEOUT_MS);
      });
    }
    function raw(mode, o, d) {
      return (mode === "taxi") ? drive(o, d) : (mode === "bike") ? ride(o, d) : transit(o, d);
    }
    return {
      /* 失败自动重试一次：高德服务偶发 no_data / 限频，重试一次大多能拿到 */
      query: function (mode, o, d) {
        var key = mode + "|" + o.join(",") + "|" + d.join(",");
        if (cache[key] !== undefined) return cache[key];
        var task = raw(mode, o, d).then(function (res) {
          if (res && res.path && res.path.length) return res;
          return new Promise(function (r) { setTimeout(r, 800); })
            .then(function () { return raw(mode, o, d); })
            .then(function (res2) { return (res2 && res2.path && res2.path.length) ? res2 : res; });
        });
        cache[key] = task;
        return task;
      }
    };
  }

  /* 简易并发池（请求本身已在 schedule() 里排队限频，这里只负责收集结果和进度） */
  function runPool(tasks, limit, onProgress) {
    return new Promise(function (resolve) {
      var out = new Array(tasks.length), i = 0, done = 0;
      if (!tasks.length) return resolve([]);
      var next = function () {
        if (i >= tasks.length) return;
        var idx = i++;
        tasks[idx]().then(function (v) {
          out[idx] = v; done++;
          if (onProgress) onProgress(done, tasks.length);
          if (done === tasks.length) resolve(out); else next();
        });
      };
      for (var k = 0; k < Math.min(limit, tasks.length); k++) next();
    });
  }

  /* ---------------- 8. 主流程 ---------------- */
  function boot() {
    injectStyle();
    var area = document.getElementById("mapArea");
    if (!area) return;

    var data = readData();
    if (!data || !data.result || !data.result.schemes || !data.result.schemes.length) return;
    /* 没数据时 result.html 的内联脚本已跳回 index.html，这里静默退出 */

    if (!JS_KEY) { showNoKey(area); return; }
    if (!JS_CODE) {
      console.warn("[map-view] 未配置 __AMAP_JS_CODE__：2021-12 之后申请的 JS Key 必须配安全密钥，否则地理编码/路径规划会被高德拒绝。");
    }

    var tabs = document.getElementById("mapTabs");
    var hint = document.getElementById("mapHint");
    if (hint) hint.textContent = "正在加载地图…";

    loadAMap(function (err) {
      if (err) {
        showNote(area, "🗺️ 地图加载失败", ["原因：" + err.message, "检查网络后刷新重试；Key 相关问题找雷馨怡。"]);
        if (hint) hint.textContent = "";
        return;
      }
      render(g.AMap, data, area, tabs, hint);
    });
  }

  function render(AMap, data, area, tabsEl, hintEl) {
    var info = extractPlaces(data);
    var schemes = data.result.schemes;
    var setHint = function (t) { if (hintEl) hintEl.textContent = t; };

    var map = new AMap.Map(area, { zoom: 12, resizeEnable: true });

    /* ---- 8.1 解析全部地点坐标 ----
     * 优先用方案里带的精确坐标（成员在地图上选的点 / 联想选的点，随 jbx_result 一起上云）；
     * 只有缺坐标的地名才去高德重新解析。
     * 否则用户在小区门口选的点会被地名解析回小区中心或别的门，地图上的蓝点就不是他选的位置。 */
    var exact = {};
    /* ⚠ 判断"坐标真的存在"不能只写 isFinite（isFinite(null) === true、isFinite('') === true），
       否则"没选点"会被当成坐标 0，蓝点画到几内亚湾，setFitView 还会把地图缩成世界视野。
       2026-11-19 闫雅欣：加 hasCoord 统一判空。 */
    (data.members || []).forEach(function (m) {
      if (m && m.origin && m.coord && hasCoord(m.coord.lng, m.coord.lat)) {
        exact[m.origin] = [Number(m.coord.lng), Number(m.coord.lat)];
      }
    });
    if (info.dest && data.destCoord && hasCoord(data.destCoord.lng, data.destCoord.lat)) {
      exact[info.dest] = [Number(data.destCoord.lng), Number(data.destCoord.lat)];
    }
    var needGeo = info.places.filter(function (p) { return !exact[p]; });

    setHint("正在定位 " + needGeo.length + " 个地点…");
    var geo = makeGeocoder(AMap, data.city || "全国");
    runPool(needGeo.map(function (p) {
      return function () { return geo.one(p).then(function (c) { return { name: p, coord: c }; }); };
    }), MAX_CONCURRENT, function (d, n) { setHint("正在定位地点 " + d + "/" + n + "…"); })
    .then(function (rs) {
      var coords = {}, missed = [];
      Object.keys(exact).forEach(function (k) { coords[k] = exact[k]; });
      (rs || []).forEach(function (r) {
        if (r && r.coord) coords[r.name] = r.coord; else if (r) missed.push(r.name);
      });
      /* 2026-11-23 张海燕：把解析好的坐标暴露给结果页「跳转高德导航」按钮，
         免得点导航时又重复发一遍地理编码请求。结构 { 地点名: [lng, lat] }。 */
      try { window.JBX_MAP_COORDS = coords; } catch (e) { /* 忽略 */ }

      /* 一个点都没解析出来：多半是 Key 无效（安全密钥没配/配错） */
      if (!Object.keys(coords).length) {
        try { map.destroy(); } catch (e) { /* 忽略 */ }
        showNote(area, "🗺️ 地名定位失败", [
          "所有地点都没解析出坐标，通常是 <span class='k'>__AMAP_JS_KEY__</span> 或 <span class='k'>__AMAP_JS_CODE__</span> 无效。",
          "请核对的 Key 类型必须是「Web端(JS API)」，密钥与 Key 配套（找雷馨怡拿）。"
        ]);
        setHint("");
        return;
      }

      /* ---- 8.2 常驻标记：起点（蓝点）+ 目的地（红星）---- */
      var common = [];
      info.origins.forEach(function (o) {
        var c = coords[o.place];
        if (!c) return;
        common.push(new AMap.Marker({
          position: c, anchor: "center", zIndex: 10,
          content: '<div class="jbx-mk jbx-mk-start"><span class="jbx-mk-dot"></span>' +
            '<span class="jbx-mk-label">' + o.members.join("、") + '</span></div>'
        }));
      });
      if (info.dest && coords[info.dest]) {
        common.push(new AMap.Marker({
          position: coords[info.dest], anchor: "center", zIndex: 30,
          content: '<div class="jbx-mk jbx-mk-dest"><span class="jbx-mk-star">★</span>' +
            '<span class="jbx-mk-label">目的地 · ' + info.dest + '</span></div>'
        }));
      }
      common.forEach(function (m) { m.setMap(map); });

      /* ---- 8.3 三个方案各自的图层：集合点标记 + 路线 ---- */
      var planner = makePlanner(AMap, data.city || "全国");
      var allSegs = [];
      schemes.forEach(function (s) { allSegs = allSegs.concat(extractSegments(s)); });

      setHint("正在规划 " + allSegs.length + " 段路线…");
      runPool(allSegs.map(function (seg) {
        return function () {
          var o = coords[seg.from], d = coords[seg.to];
          if (!o || !d) return Promise.resolve({ seg: seg, path: null, status: "坐标缺失" });
          return planner.query(seg.mode, o, d).then(function (res) {
            return { seg: seg, path: (res && res.path) || null, status: (res && res.status) || "?", kind: (res && res.kind) || "" };
          });
        };
      }), MAX_CONCURRENT, function (d, n) { setHint("正在规划路线 " + d + "/" + n + "…"); })
      .then(function (rs) {
        var bySeg = {};
        var failures = [];
        (rs || []).forEach(function (r) {
          if (!r) return;
          var key = r.seg.from + "|" + r.seg.to + "|" + r.seg.mode;
          bySeg[key] = r.path;
          if (!r.path) failures.push(r.seg.from + "→" + r.seg.to +
            "（" + ((r.kind ? r.kind + " " : "") + r.status) + "）");   // 坐标缺失时 kind 为空，别拼出 "undefined"
        });

        function mkLine(seg) {
          var o = coords[seg.from], d = coords[seg.to];
          if (!o || !d) return null;
          var path = bySeg[seg.from + "|" + seg.to + "|" + seg.mode];
          var opts = {
            strokeColor: themeColor(seg.mode) || "#718096",
            strokeWeight: 4, strokeOpacity: 0.85,
            lineJoin: "round", lineCap: "round", zIndex: 5
          };
          if (path && path.length) {
            return new AMap.Polyline(Object.assign({ path: path }, opts));
          }
          /* 规划失败/超时 → 两点虚线兜底，方案完整性不受影响 */
          return new AMap.Polyline(Object.assign({
            path: [o, d], strokeStyle: "dashed", strokeDasharray: [8, 8]
          }, opts));
        }
        function mkMeet(name) {
          var c = coords[name];
          if (!c) return null;
          return new AMap.Marker({
            position: c, anchor: "center", zIndex: 20,
            content: '<div class="jbx-mk jbx-mk-meet"><span class="jbx-mk-dot"></span>' +
              '<span class="jbx-mk-label">集合点 · ' + name + '</span></div>'
          });
        }

        /* 每个方案一个 overlay 组；切换 = 整组 setMap(map/null) */
        var layers = schemes.map(function (s) {
          var group = extractSegments(s).map(mkLine).filter(Boolean);
          var meetsHere = {};
          extractSegments(s).forEach(function (seg) {
            [seg.from, seg.to].forEach(function (n) {
              if (n && n !== info.dest && !info.origins.some(function (o) { return o.place === n; })) meetsHere[n] = 1;
            });
          });
          Object.keys(meetsHere).forEach(function (n) {
            var m = mkMeet(n); if (m) group.push(m);
          });
          return group;
        });

        /* ---- 8.4 方案切换标签 ---- */
        var current = -1;
        function show(idx) {
          if (idx === current || !layers[idx]) return;
          if (current >= 0) layers[current].forEach(function (o) { o.setMap(null); });
          layers[idx].forEach(function (o) { o.setMap(map); });
          current = idx;
          var visible = common.concat(layers[idx]);
          map.setFitView(visible, false, [46, 46, 46, 46]);
          if (tabsEl) {
            Array.prototype.forEach.call(tabsEl.children, function (b, i) {
              b.className = "jbx-tab" + (i === idx ? " on" : "");
            });
          }
        }
        if (tabsEl) {
          tabsEl.innerHTML = "";
          schemes.forEach(function (s, i) {
            var b = document.createElement("button");
            b.className = "jbx-tab";
            b.textContent = (s.name || ("方案" + (i + 1))).split(/[：:]/)[0];
            b.onclick = function () { show(i); };
            tabsEl.appendChild(b);
          });
        }
        show(0);

        /* ---- 8.5 收尾提示 ---- */
        var bits = [];
        if (failures.length) {
          bits.push(failures.length + " 段路线未取到实际路径（已用虚线直线表示）：" + failures.slice(0, 3).join("、") +
            (failures.length > 3 ? " 等" : ""));
          console.warn("[map-view] 路线规划失败明细：", failures);
        }
        if (missed.length) bits.push("未能定位：" + missed.join("、") + "（对应标记已隐藏）");
        setHint(bits.length ? "⚠️ " + bits.join("；") : "✓ 三方案路线已绘制完成，点击上方标签切换方案");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
