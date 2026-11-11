/* ============================================================
 * amap-api.js — 高德真接口适配层【雷馨怡 · 2026-11-10】
 *
 * 全组唯一锚点（不许改）：
 *   queryRoute(origin, dest, mode) -> Promise<{
 *     durationMin: 35.2,   // 分钟
 *     distanceKm: 12.4,    // 公里
 *     cost: 18             // 该方式一个人的费用（元），骑行 = 0
 *   }>
 *   mode 只会是 "transit"（地铁/公交）、"taxi"（打车）、"bike"（骑行）
 *   origin/dest 是地名文字，也接受 "经度,纬度"
 *
 * 四条联调任务的落地位置：
 *   ① 适配层      → 本文件即适配层，模式映射见 MODE_MAP
 *   ② 地名→坐标   → _geoResolve()：geocode → inputtips → 全国 geocode，带缓存
 *   ③ 打车费      → 走 v3 驾车 extensions=all 的 route.taxi_cost（高德按各城市真实运价报价，
 *                    全国通用）；取不到时才退回费用参考表公式（起步 12 元 + 2.3 元/公里）
 *   ④ 浏览器兼容  → 纯 fetch + 全局函数写法，不需要 uni 垫片，也不需要 type="module"
 *
 * 降级策略：Key 错、断网、地名解析失败、请求超出预算 → 一律回退本地估算
 *          （公式与 mock-api.js 完全一致），页面不白屏、不卡死。
 *
 * 自测：双击 index.html → 填 3 人 → 生成方案；控制台执行 amapStats() 看请求数。
 *
 * ── 第 3 轮（v0.3 城市切换，2026-11-10）改了四处 ──
 *   ① 缓存 key 全部带城市前缀 _ck()：切城市后即使缓存没清也不会串号
 *   ② 城市三件套只做"缺省兜底"，运行期由 js/cities.js 现读现赋，不在本文件里写死
 *   ③ 限频：并发 3→2、加全局最小间隔 MIN_INTERVAL_MS、重试 2→3 次并退避
 *   ④ 打车费改直取高德 taxi_cost（2026-11-11）：TAXI_BASE / TAXI_PER_KM 只作兜底，
 *      正常情况下改这两个值不影响结果——别再按"调参数"的思路改打车价。
 * ============================================================ */

/* ---------------- 配置区（只改这里） ---------------- */
/* Key 不进仓库（2026-11-10 起改为外部文件）：
   从 js/config.local.js 读 window.__AMAP_KEY__，该文件已写进 .gitignore。
   新拉代码的人第一次用：把 js/config.example.js 复制成 js/config.local.js，填上自己的 Key。
   读不到 Key 不会报错，全部走本地估算——页面照常能跑，只是数据是估的（控制台 amapStats() 能看到）。 */
var AMAP_KEY = (function () {
  var g = (typeof globalThis !== "undefined") ? globalThis
        : (typeof window !== "undefined" ? window : {});
  var k = g.__AMAP_KEY__;
  return (typeof k === "string") ? k.trim() : "";
})();

/* ── 城市三件套：变量名是契约，js/cities.js 靠"给同名全局变量赋值"来切城市 ──
   · 名字不许改（改了 applyCity 静默失效，最难查）
   · 不许搬进对象/闭包（切城市时拿不到新值）
   · 下面的默认值只在 cities.js 不存在时生效（Node 单文件自测、离线打开）
   每处用到时都是现读全局，不在函数里存局部常量。 */
var AMAP_CITY = (typeof AMAP_CITY === "string" && AMAP_CITY) ? AMAP_CITY : "武汉";
var AMAP_CITY_ADCODE = (typeof AMAP_CITY_ADCODE === "string" && AMAP_CITY_ADCODE) ? AMAP_CITY_ADCODE : "420100";
var AMAP_CITY_CENTER = (typeof AMAP_CITY_CENTER === "string" && AMAP_CITY_CENTER) ? AMAP_CITY_CENTER : "114.3055,30.5928";

/* cities.js 若已先加载（顺序无关），用它当前选中的城市覆盖上面的默认值 */
(function () {
  if (typeof currentCity !== "function") return;
  var c = currentCity();
  if (!c) return;
  AMAP_CITY = c.name; AMAP_CITY_ADCODE = c.adcode; AMAP_CITY_CENTER = c.center;
})();

var MAX_GEO_DISTANCE_KM = 60;                        // 解析结果离市中心超过这个距离，判为错误解析
var MAX_REQ_PER_RUN = 120;                            // 单次"生成方案"的真实请求上限，超出转本地估算
var CACHE_TTL_MS = 30 * 60 * 1000;                   // 结果缓存 30 分钟
var MAX_CONCURRENT = 2;                              // 并发上限：个人 Key 约 3 QPS，并发 3 必然触发限频
var MIN_INTERVAL_MS = 350;                           // 全局最小请求间隔（节流比并发数更稳）
var RETRY_DELAY_MS = 1000;                           // 限频/网络失败的首个重试间隔，之后线性退避
var RETRY_MAX = 3;                                   // 失败重试次数上限
var SAME_POINT_KM = 0.05;                            // 起终点重合（<50 米）不发请求，直接返回 0
var TIMEOUT_MS = 8000;                               // 单请求超时
var TAXI_BASE = 12, TAXI_PER_KM = 2.3;               // 打车费【仅兜底】用：正常走高德 taxi_cost，取不到才算公式

var MODE_MAP = { taxi: "driving", bike: "bicycling", transit: "transit" };

/* ---------------- 缓存与统计 ---------------- */
var _routeCache = {};
var _geoCache = {};
var _stats = { requests: 0, cacheHits: 0, inflightMerged: 0, estimates: 0, retries: 0, lastRunRequests: 0, runs: 0, lastFallbackReasons: [] };
var _runUsed = 0;

/* 缓存 key 统一加城市前缀：武汉的"中山公园"和上海的不是一个地方。
   这样即使切城市时忘了清缓存、或者两个标签页各选一个城市，也不会串号。
   ★ 每次调用现读 AMAP_CITY，不要在外层先算好存起来。 */
function _ck(name) {
  return AMAP_CITY + "|" + name;
}

function _cacheGet(map, key) {
  var hit = map[key];
  if (!hit) return null;
  if (Date.now() - hit.t > (hit.ttl || CACHE_TTL_MS)) { delete map[key]; return null; }
  return hit.v;
}
function _cacheSet(map, key, val, ttl) {
  map[key] = { t: Date.now(), v: val, ttl: ttl || CACHE_TTL_MS };
}

/* ---------------- 请求队列：并发上限 + 全局节流 + 超时 + 限频重试 ---------------- */
/* 限频的真正原因是"短时间打太密"，光控并发不够（并发 2 也能一秒打 5 发）。
   所以再加一层全局节流：任意两次请求的发出时间至少隔 MIN_INTERVAL_MS。 */
var _running = 0, _queue = [], _nextSlotAt = 0;
var _RETRYABLE = /10004|10044|10021|10029|Failed to fetch|network|aborted|timeout/i;

/* 同步预约一个发送时间片，返回要等多少毫秒（多个请求同时进来也不会撞在一起） */
function _reserveSlot() {
  var now = Date.now();
  var at = Math.max(now, _nextSlotAt);
  _nextSlotAt = at + MIN_INTERVAL_MS;
  return at - now;
}

function _requestOnce(url) {
  return new Promise(function (resolve, reject) {
    var run = function () {
      _running++;
      var done = function (ok, val) {
        _running--;
        if (_queue.length) _queue.shift()();
        ok ? resolve(val) : reject(val);
      };
      if (typeof fetch !== "function") { done(false, new Error("当前环境没有 fetch")); return; }

      var fire = function () {
        var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
        _stats.requests++;
        _runUsed++;
        fetch(url, { signal: ctl ? ctl.signal : undefined })
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (timer) clearTimeout(timer);
            if (body && String(body.status) === "1") done(true, body);
            else done(false, new Error(((body && body.infocode) || "") + " " + ((body && body.info) || "接口返回异常")));
          })
          .catch(function (e) { if (timer) clearTimeout(timer); done(false, e); });
      };

      var wait = _reserveSlot();
      if (wait > 0) setTimeout(fire, wait); else fire();
    };
    _running < MAX_CONCURRENT ? run() : _queue.push(run);
  });
}

/* retry：失败重试次数（限频、网络异常才重试；地名查不到不重试，省配额）
   退避 1s → 2s → 3s，给服务器留出恢复时间，比固定间隔更少触发二次限频 */
function _fetchJson(url, retry) {
  var max = typeof retry === "number" ? retry : RETRY_MAX;
  var attempt = function (n) {
    return _requestOnce(url).catch(function (e) {
      var msg = (e && e.message) || "";
      if (n < max && _RETRYABLE.test(msg)) {
        _stats.retries++;
        var wait = RETRY_DELAY_MS * (n + 1);
        return new Promise(function (r) { setTimeout(r, wait); }).then(function () { return attempt(n + 1); });
      }
      throw e;
    });
  };
  return attempt(0);
}

/* ---------------- 小工具 ---------------- */
function _round1(x) { return Math.round(x * 10) / 10; }

function _toLngLat(s) {
  var p = String(s).split(",");
  if (p.length !== 2) return null;
  var lng = Number(p[0]), lat = Number(p[1]);
  if (!isFinite(lng) || !isFinite(lat)) return null;
  return { lng: lng, lat: lat };
}

function _distanceKm(a, b) {
  var R = 6371, rad = function (x) { return x * Math.PI / 180; };
  var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* 名称相似度：去掉"地铁站/广场/停车位"这类通用后缀后比字符交集，
   避免"滨江路站"被解析成"玉桥东一路-道路停车位" */
var _STRIP = /(地铁站|地铁|车站|站|广场|中心|停车位|停车场|大厦|门店)$/g;
function _similarNum(a, b) {
  var strip = function (x) { return String(x).replace(/[（()）\s]/g, "").replace(_STRIP, ""); };
  var A = strip(a), B = strip(b), set = {}, n = 0;
  for (var i = 0; i < A.length; i++) set[A[i]] = 1;
  for (var j = 0; j < B.length; j++) if (set[B[j]]) { n++; delete set[B[j]]; }
  return n;
}

/* ---------------- ② 地名 → 坐标 ---------------- */
/* 地名变体：主地名查不到时，去掉"地铁站/车站/站"再查一次
   （"中心广场地铁站"查不到，但"中心广场"能查到） */
function _geoVariants(name) {
  var out = [name];
  var trimmed = String(name).replace(/[（(].*?[)）]/g, "").replace(/(地铁站|车站|站)$/g, "").trim();
  if (trimmed && trimmed !== name) out.push(trimmed);
  return out;
}

/* 单个地名的三级解析：geocode(本市) → inputtips(本市) → geocode(全国，需距离校验) */
function _lookupOne(name) {
  var center = _toLngLat(AMAP_CITY_CENTER);
  var accept = function (loc, addr, adcode, source) {
    var p = _toLngLat(loc);
    if (!p) return null;
    if (center && _distanceKm(center, p) > MAX_GEO_DISTANCE_KM) return null; // 解析到外省，判错
    return { ok: true, lng: p.lng, lat: p.lat, adcode: adcode || AMAP_CITY_ADCODE, name: addr || name, source: source };
  };

  var tryGeocode = function (withCity) {
    var url = "https://restapi.amap.com/v3/geocode/geo?address=" + encodeURIComponent(name) +
      (withCity ? "&city=" + encodeURIComponent(AMAP_CITY) : "") + "&key=" + AMAP_KEY;
    return _fetchJson(url, 1).then(function (body) {
      var g = (body.geocodes || [])[0];
      return g ? accept(g.location, g.formatted_address, g.adcode, withCity ? "geocode" : "geocode(全国)") : null;
    }).catch(function () { return null; });
  };

  var tryTips = function () {
    var url = "https://restapi.amap.com/v3/assistant/inputtips?keywords=" + encodeURIComponent(name) +
      "&city=" + encodeURIComponent(AMAP_CITY) + "&citylimit=true&key=" + AMAP_KEY;
    return _fetchJson(url, 1).then(function (body) {
      var tips = (body.tips || []).filter(function (t) { return t.location && String(t.location).indexOf(",") > 0; });
      for (var i = 0; i < tips.length; i++) {
        if (_similarNum(name, tips[i].name) < 2) continue; // 名称对不上，不用
        var ok = accept(tips[i].location, tips[i].name, tips[i].adcode, "inputtips");
        if (ok) return ok;
      }
      return null;
    }).catch(function () { return null; });
  };

  return tryGeocode(true)
    .then(function (r) { return r || tryTips(); })
    .then(function (r) { return r || tryGeocode(false); });
}

var _geoInflight = {};

function _geoResolve(name) {
  var ck = _ck(name);                                   // 地名缓存按城市分桶，跨城市不共用
  var cached = _cacheGet(_geoCache, ck);
  if (cached) return Promise.resolve(cached);
  if (_geoInflight[ck]) return _geoInflight[ck];        // 三个方案并发时，同一个地名只查一次

  var direct = _toLngLat(name);
  if (direct) {
    var fixed = { ok: true, lng: direct.lng, lat: direct.lat, adcode: AMAP_CITY_ADCODE, name: name, source: "坐标" };
    _cacheSet(_geoCache, ck, fixed);
    return Promise.resolve(fixed);
  }

  var variants = _geoVariants(name);
  var chain = Promise.resolve(null);
  variants.forEach(function (v) {
    chain = chain.then(function (r) { return r || _lookupOne(v); });
  });

  var task = chain.then(function (r) {
    var res = r || { ok: false, name: name };
    // 成功缓存 30 分钟；失败只缓存 60 秒，避免一次网络抖动让整个地名长时间失效
    _cacheSet(_geoCache, ck, res, r ? CACHE_TTL_MS : 60 * 1000);
    return res;
  });
  _geoInflight[ck] = task;
  var clear = function () { delete _geoInflight[ck]; };
  task.then(clear, clear);
  return task;
}

/* ---------------- 本地估算（降级兜底，公式与 mock-api.js 一致） ---------------- */
function _hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function _estimate(origin, dest, mode, reason) {
  _stats.estimates++;
  if (reason && _stats.lastFallbackReasons.length < 20) {
    _stats.lastFallbackReasons.push(mode + ":" + origin + "→" + dest + "(" + reason + ")");
  }
  var seed = _hashStr(origin + "→" + dest);
  var km = 2 + (seed % 180) / 10;
  var min, cost;
  if (mode === "taxi") { min = km / 35 * 60 + 5; cost = Math.round(TAXI_BASE + TAXI_PER_KM * km); }
  else if (mode === "transit") { min = km / 25 * 60 + 12; cost = 2 + Math.floor(km / 4); }
  else { min = km / 12 * 60; cost = 0; }
  return {
    durationMin: _round1(min), distanceKm: _round1(km), cost: cost,
    estimated: true, fallback: reason || "unknown"
  };
}

/* ---------------- 三种方式的真实查询 ---------------- */
function _requestRoute(mode, o, d) {
  var origin = o.lng + "," + o.lat, dest = d.lng + "," + d.lat;
  var url, pick;

  if (mode === "taxi") {
    /* 打车走 v3 而不是 v5：只有 v3 的 extensions=all 会返回 route.taxi_cost（预计打车费），
       而且这个价格是高德按【所在城市的真实出租车运价】算的——全国所有城市通用，
       换城市、加新城市都不用改任何参数（v5 的 cost 里实测只有 duration/tolls/
       toll_distance/traffic_lights，没有打车费，所以不能走 v5）。

       2026-11-11 实测（同一 Key，各城市取一条真实路线）：
         武汉 10.4km → 23 元   北京 17.4km → 48 元   上海 21.7km → 69 元
         广州  5.1km → 16 元   深圳 10.0km → 30 元   成都  9.9km → 23 元
       对照原来的公式（12 + 2.3×km），武汉会算成 36 元，高估 56%——所以公式只留作兜底。 */
    url = "https://restapi.amap.com/v3/direction/driving?origin=" + origin + "&destination=" + dest +
      "&extensions=all&strategy=0&key=" + AMAP_KEY;
    pick = function (body) {
      var p = body.route && body.route.paths && body.route.paths[0];
      if (!p) throw new Error("驾车无可达路线");
      var km = parseFloat(p.distance) / 1000;
      var fee = body.route.taxi_cost;   // 注意：在 route 层，不在 paths[0] 里
      var official = (fee !== undefined && fee !== null && fee !== "" && parseFloat(fee) > 0);
      return {
        durationMin: _round1(parseFloat(p.duration) / 60), distanceKm: _round1(km),
        // 官方报价优先；个别路线没返回时才退回公式，并用 costEstimated 标出来
        cost: official ? Math.round(parseFloat(fee)) : Math.round(TAXI_BASE + TAXI_PER_KM * km),
        costEstimated: !official,
        costSource: official ? "amap.taxi_cost" : "formula"
      };
    };
  } else if (mode === "transit") {
    // 公交：v5，city1/city2 必须是城市代码（adcode），不接受中文。
    // 用城市三件套里的市级 adcode（现读全局），不要用地名解析返回的区级 adcode：
    // 区级虽然也能查通，但和 cities.js 的契约对不上，换城市时容易看不出来。
    url = "https://restapi.amap.com/v5/direction/transit/integrated?origin=" + origin + "&destination=" + dest +
      "&city1=" + AMAP_CITY_ADCODE + "&city2=" + AMAP_CITY_ADCODE + "&show_fields=cost&key=" + AMAP_KEY;
    pick = function (body) {
      var t = body.route && body.route.transits && body.route.transits[0];
      if (!t) throw new Error("公交无可达方案");
      var sec = (t.cost && t.cost.duration) || t.duration;
      var km = parseFloat(t.distance) / 1000;
      var fee = t.cost && t.cost.transit_fee;
      return {
        durationMin: _round1(parseFloat(sec) / 60), distanceKm: _round1(km),
        cost: fee ? Math.round(parseFloat(fee) * 10) / 10 : 2 + Math.floor(km / 4)
      };
    };
  } else {
    // 骑行：v5，耗时与距离都在 paths[0] 顶层，费用为 0
    url = "https://restapi.amap.com/v5/direction/bicycling?origin=" + origin + "&destination=" + dest +
      "&key=" + AMAP_KEY;
    pick = function (body) {
      var p = body.route && body.route.paths && body.route.paths[0];
      if (!p) throw new Error("骑行无可达路线");
      return {
        durationMin: _round1(parseFloat(p.duration) / 60),
        distanceKm: _round1(parseFloat(p.distance) / 1000), cost: 0
      };
    };
  }

  return _fetchJson(url, RETRY_MAX).then(pick);
}

/* ---------------- ① 对外唯一入口 ---------------- */
/* 三个方案是并发跑起来的，同一对起终点会被重复请求；
   _inflight 把"正在进行中的同一个请求"合并成一个，省掉大量重复配额 */
var _inflight = {};

function queryRoute(origin, dest, mode) {
  if (!MODE_MAP[mode]) return Promise.resolve(_estimate(origin, dest, mode, "mode"));
  // 没配 Key（刚 clone 下来、或忘了建 config.local.js）：直接估算，一条请求都不发
  if (!AMAP_KEY) return Promise.resolve(_estimate(origin, dest, mode, "no-key"));

  // 路线 key 同样带城市前缀：同名地名在不同城市是不同的起终点
  var key = _ck("route|" + mode + "|" + origin + "|" + dest);
  var hit = _cacheGet(_routeCache, key);
  if (hit) { _stats.cacheHits++; return Promise.resolve(hit); }
  if (_inflight[key]) { _stats.inflightMerged++; return _inflight[key]; }

  var task = Promise.all([_geoResolve(origin), _geoResolve(dest)]).then(function (g) {
    if (!g[0].ok || !g[1].ok) return _estimate(origin, dest, mode, "geocode");
    // 同点（如"市体育馆"和"市体育馆地铁站"解析到同一处）：直接 0，不浪费配额
    if (_distanceKm(g[0], g[1]) < SAME_POINT_KM) {
      var zero = { durationMin: 0, distanceKm: 0, cost: 0, note: "same-point" };
      _cacheSet(_routeCache, key, zero);
      return zero;
    }
    if (_runUsed >= MAX_REQ_PER_RUN) return _estimate(origin, dest, mode, "budget");
    return _requestRoute(mode, g[0], g[1])
      .then(function (r) { _cacheSet(_routeCache, key, r); return r; })
      .catch(function () { return _estimate(origin, dest, mode, "error"); });
  });

  _inflight[key] = task;
  var clear = function () { delete _inflight[key]; };
  task.then(clear, clear);
  return task;
}

/* ---------------- 验收辅助 ---------------- */
function amapStats() {
  var s = {
    "当前城市": AMAP_CITY + "（" + AMAP_CITY_ADCODE + "）",
    "上一次生成用了几次请求": _stats.lastRunRequests,
    "本次已用请求": _runUsed,
    "单次生成请求上限": MAX_REQ_PER_RUN,
    "累计真实请求": _stats.requests,
    "限频重试": _stats.retries,
    "缓存命中": _stats.cacheHits,
    "并发合并": _stats.inflightMerged,
    "降级估算次数": _stats.estimates,
    "生成次数": _stats.runs,
    "限流参数": "并发 " + MAX_CONCURRENT + " / 最小间隔 " + MIN_INTERVAL_MS + "ms / 重试 " + RETRY_MAX + " 次",
    "最近降级原因": _stats.lastFallbackReasons.slice(0, 5)
  };
  console.table ? console.table(s) : console.log(s);
  return s;
}

/* 每次点"生成三套方案"重置本轮预算（捕获阶段，先于 app.js 的处理器执行） */
function _resetRunBudget() {
  if (_runUsed > 0) _stats.lastRunRequests = _runUsed;
  _runUsed = 0;
  _stats.runs++;
  _stats.lastFallbackReasons = [];
}
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t) return;
    if (t.id === "generate" || (t.closest && t.closest("#generate"))) _resetRunBudget();
  }, true);
}

/* Node 环境下导出，便于命令行自测（浏览器里这段自动跳过） */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { queryRoute: queryRoute, amapStats: amapStats, _geoResolve: _geoResolve };
}
