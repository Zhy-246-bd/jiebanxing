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

  /* ---------------- 0. 配置 ---------------- */
  var JS_KEY  = (typeof g.__AMAP_JS_KEY__  === "string") ? g.__AMAP_JS_KEY__.trim()  : "";
  var JS_CODE = (typeof g.__AMAP_JS_CODE__ === "string") ? g.__AMAP_JS_CODE__.trim() : "";

  var MODE_COLOR = { transit: "#3182ce", taxi: "#dd6b20", bike: "#38a169" };
  var TIMEOUT_MS = 8000;      // 单次路线规划 / 地名解析的超时
  var CONCURRENCY = 2;        // 并发上限：对高德友好一点

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
      ".jbx-mk-start .jbx-mk-dot{background:#3182ce}",
      ".jbx-mk-meet  .jbx-mk-dot{background:#f6c344;border-color:#fff}",
      ".jbx-mk-dest  .jbx-mk-star{display:block;font-size:20px;line-height:1;color:#e53e3e;",
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
      "&plugin=AMap.Geocoder,AMap.Driving,AMap.Transfer,AMap.Riding";
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

  /* ---------------- 6. 地名 → 坐标（Geocoder，本市优先 / 全国兜底，带缓存） ---------------- */
  function makeGeocoder(AMap, city) {
    var geoCity = new AMap.Geocoder({ city: city });
    var geoAll = new AMap.Geocoder();   // 不限城市
    var cache = {};

    function pickLng(result) {
      var loc = result && result.geocodes && result.geocodes[0] && result.geocodes[0].location;
      if (!loc) return null;
      if (typeof loc === "string") {
        var p = loc.split(",");
        var lng = Number(p[0]), lat = Number(p[1]);
        return (isFinite(lng) && isFinite(lat)) ? [lng, lat] : null;
      }
      return (isFinite(loc.lng) && isFinite(loc.lat)) ? [loc.lng, loc.lat] : null;
    }
    function ask(geo, name) {
      return withTimeout(function () {
        return new Promise(function (resolve) {
          geo.getLocation(name, function (status, result) {
            resolve(status === "complete" ? pickLng(result) : null);
          });
        });
      }, TIMEOUT_MS);
    }
    return {
      one: function (name) {
        if (cache[name] !== undefined) return cache[name];
        cache[name] = ask(geoCity, name).then(function (p) {
          return p || ask(geoAll, name);    // 本市查不到 → 全国兜底
        });
        return cache[name];
      }
    };
  }

  /* ---------------- 7. 路线规划（三种方式，几何防御式提取） ----------------
   * 高德不同插件返回结构不同（routes[].steps[].path / plans[].segments[].path），
   * 这里统一抽成 LngLat 数组；抽不出来就退 null → 上层画虚线直线。 */
  function collectPath(obj) {
    if (!obj) return null;
    if (obj.path && obj.path.length) return obj.path;
    var steps = obj.steps || obj.segments || [];
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
    function drive(o, d) {
      return withTimeout(function () {
        return new Promise(function (resolve) {
          new AMap.Driving({ autoFitView: false }).search(o, d, function (status, result) {
            resolve(status === "complete" && result.routes && result.routes[0] ? collectPath(result.routes[0]) : null);
          });
        });
      }, TIMEOUT_MS);
    }
    function ride(o, d) {
      return withTimeout(function () {
        return new Promise(function (resolve) {
          new AMap.Riding({ autoFitView: false }).search(o, d, function (status, result) {
            resolve(status === "complete" && result.routes && result.routes[0] ? collectPath(result.routes[0]) : null);
          });
        });
      }, TIMEOUT_MS);
    }
    function transit(o, d) {
      return withTimeout(function () {
        return new Promise(function (resolve) {
          new AMap.Transfer({ city: city, autoFitView: false }).search(o, d, function (status, result) {
            resolve(status === "complete" && result.plans && result.plans[0] ? collectPath(result.plans[0]) : null);
          });
        });
      }, TIMEOUT_MS);
    }
    return {
      query: function (mode, o, d) {
        var key = mode + "|" + o.join(",") + "|" + d.join(",");
        if (cache[key] !== undefined) return cache[key];
        var task = (mode === "taxi") ? drive(o, d) : (mode === "bike") ? ride(o, d) : transit(o, d);
        cache[key] = task;
        return task;
      }
    };
  }

  /* 简易并发池：按 CONCURRENCY 依次执行任务，返回按原顺序的结果数组 */
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

    /* ---- 8.1 解析全部地点坐标 ---- */
    setHint("正在定位 " + info.places.length + " 个地点…");
    var geo = makeGeocoder(AMap, data.city || "全国");
    runPool(info.places.map(function (p) {
      return function () { return geo.one(p).then(function (c) { return { name: p, coord: c }; }); };
    }), CONCURRENCY, function (d, n) { setHint("正在定位地点 " + d + "/" + n + "…"); })
    .then(function (rs) {
      var coords = {}, missed = [];
      (rs || []).forEach(function (r) {
        if (r && r.coord) coords[r.name] = r.coord; else if (r) missed.push(r.name);
      });

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
          if (!o || !d) return Promise.resolve(null);
          return planner.query(seg.mode, o, d).then(function (path) { return { seg: seg, path: path }; });
        };
      }), CONCURRENCY, function (d, n) { setHint("正在规划路线 " + d + "/" + n + "…"); })
      .then(function (rs) {
        var bySeg = {};
        var straight = 0;
        (rs || []).forEach(function (r) { if (r) bySeg[r.seg.from + "|" + r.seg.to + "|" + r.seg.mode] = r.path; });

        function mkLine(seg) {
          var o = coords[seg.from], d = coords[seg.to];
          if (!o || !d) return null;
          var path = bySeg[seg.from + "|" + seg.to + "|" + seg.mode];
          var opts = {
            strokeColor: MODE_COLOR[seg.mode] || "#718096",
            strokeWeight: 4, strokeOpacity: 0.85,
            lineJoin: "round", lineCap: "round", zIndex: 5
          };
          if (path && path.length) {
            return new AMap.Polyline(Object.assign({ path: path }, opts));
          }
          /* 规划失败/超时 → 两点虚线兜底，方案完整性不受影响 */
          straight++;
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
        if (straight) bits.push(straight + " 段路线未取到实际路径，已用虚线直线表示");
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
