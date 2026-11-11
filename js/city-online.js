/* ============================================================
 * city-online.js — 任意城市在线解析【张海燕 · 2026-11-11】
 *
 * 解决"只能选 6 个预置城市"的限制：用户在录入页输入任意城市名，
 * 本文件自动查出这个城市跑起来需要的全部配置，交给 cities.js 的 applyCity()。
 *
 * 一次解析最多 4 个请求（都在高德 Web 服务 API 同城范围内，量很小）：
 *   ① district 行政区域查询 → 拿 adcode（公交查询必需）和 center（校验中心点）
 *   ② POI 搜索「地铁站」→ 候选集合点（方案二/三要从这里挑汇合点）
 *   ③ POI 搜索「火车站」→ 地铁站不够 4 个时补齐（有些城市没地铁）
 *   ④ POI 搜索「景点」  → 目的地输入框的示例文字
 *
 * 查完组装成和 cities.js 里 CITIES 完全一样的对象结构：
 *   { key, name, adcode, center, stations, destExample, members, custom: true }
 *
 * ── 两个必须记住的坑（都踩过） ──
 *   1) 公交接口吃【市级】adcode，所以区县要归到地级市（见 _toCityAdcode）；
 *      但 POI 搜索要用【原码】才搜得到本地的站（昆山用 320500 会搜到苏州城区的站），
 *      所以 city 对象上多存一个 poiAdcode。
 *   2) 个人 Key 约 3 QPS，连续打会被限频（10021）。这里做了 350ms 节流，
 *      而且 POI 失败【不许静默吞掉】——否则用户看到的是"这个城市没地铁"，
 *      实际是"查得太快"，提示完全误导。
 * ============================================================ */

var CITY_ONLINE_TIMEOUT = 8000;
var CITY_ONLINE_GAP_MS = 350;     // 请求最小间隔，和 amap-api.js 的口径保持一致

var _coNextSlotAt = 0;

function _coKey() {
  return (typeof AMAP_KEY === "string" && AMAP_KEY) ? AMAP_KEY : "";
}

/* 预约一个发送时间片，避免连发触发限频 */
function _coReserve() {
  var now = Date.now();
  var at = Math.max(now, _coNextSlotAt);
  _coNextSlotAt = at + CITY_ONLINE_GAP_MS;
  return at - now;
}

/* 带节流 + 超时的 JSON 请求：失败一律 reject 出可读中文 */
function _coFetch(url) {
  return new Promise(function (resolve, reject) {
    if (typeof fetch !== "function") { reject(new Error("当前环境不支持网络请求")); return; }

    var done = false;
    var timer = null;

    var fail = function (msg) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(new Error(msg));
    };
    var ok = function (body) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(body);
    };

    var wait = _coReserve();
    var fire = function () {
      timer = setTimeout(function () { fail("请求超时（网络较慢）"); }, CITY_ONLINE_TIMEOUT);
      fetch(url).then(function (r) { return r.json(); }).then(function (body) {
        if (done) return;
        if (String(body.status) !== "1") {
          var code = String(body.infocode);
          if (code === "10004" || code === "10021") { fail("查询太频繁，请等几秒再试"); return; }
          fail(body.info || "高德接口返回失败");
          return;
        }
        ok(body);
      }).catch(function (e) {
        fail((e && /Failed to fetch|network/i.test(e.message)) ? "网络连不上，请检查网络" : (e.message || "请求失败"));
      });
    };

    if (wait > 0) setTimeout(fire, wait); else fire();
  });
}

/* ---------------- ① adcode 归正（公交查询用市级） ---------------- */
/*   直辖市（11/12/31/50 开头）→ 一律前 2 位 + 0000
 *     ★ 这里有个坑：district 接口 keywords=北京 返回的是 110100「市辖区」，
 *       不是 110000。110100 不是合法市码，拿去查公交会空、拿去查 POI 会让
 *       citylimit 失效（候选点会跨省乱窜：厦门/广州/杭州的站都跑出来）。
 *       所以直辖市的判断必须放在 level==="city" 之前。
 *   其他地级市 → 前 4 位 + 00（如 430104 岳麓区 → 430100 长沙）
 *   省直辖县级市（如 仙桃 429004）→ 原样保留 */
function _toCityAdcode(adcode, level) {
  var a = String(adcode || "").replace(/\D/g, "");
  if (a.length !== 6) return a;

  var p2 = a.slice(0, 2), p4 = a.slice(0, 4);
  if (p2 === "11" || p2 === "12" || p2 === "31" || p2 === "50") return p2 + "0000";
  if (level === "city") return a;
  if (a.slice(4) === "00") return a;           // 已经是市级码
  if (a.slice(2) === "0000") return a;         // 省级码（非直辖市，会在上层被拒）
  return p4 + "00";
}

/* ---------------- ② 按城市名查行政信息 ---------------- */
function _districtQuery(kw) {
  var url = "https://restapi.amap.com/v3/config/district?keywords=" + encodeURIComponent(kw) +
    "&subdistrict=0&extensions=base&key=" + _coKey();
  return _coFetch(url).then(function (body) {
    return body.districts || [];
  }).catch(function (e) {
    if (/太频繁/.test(e.message)) throw e;     // 限频要如实告诉用户，不能当成"没找到"
    return [];
  });
}

/* 用户输入可能带区县（"长沙市岳麓区"），district 接口认不出整串。
   逐级退化：原串 → 截到第一个"市" → 去掉末尾区县 */
function _keywordCandidates(kw) {
  var out = [kw];
  var m = kw.match(/^(.{2,10}?市)/);
  if (m && m[1] !== kw) out.push(m[1]);
  var m2 = kw.match(/^(.{2,10}?)(?:区|县|新区|开发区)$/);
  if (m2 && out.indexOf(m2[1]) < 0) out.push(m2[1]);
  return out;
}

function resolveCityByName(name) {
  var kw = String(name || "").trim();
  if (!kw) return Promise.reject(new Error("请先填写城市名"));

  if (!_coKey()) return Promise.reject(new Error("没有配置高德 Key，暂时无法在线添加城市"));

  var cands = _keywordCandidates(kw);

  var tryAt = function (i) {
    if (i >= cands.length) {
      return Promise.reject(new Error("没找到「" + kw + "」，建议输入地级市名，如：长沙、西安、桂林"));
    }
    return _districtQuery(cands[i]).then(function (list) {
      if (!list.length) return tryAt(i + 1);

      /* 同名时优先取"市"级（输入"朝阳"可能先返回朝阳区） */
      var pick = null, j;
      for (j = 0; j < list.length; j++) { if (list[j].level === "city") { pick = list[j]; break; } }
      if (!pick) { for (j = 0; j < list.length; j++) { if (list[j].level === "district") { pick = list[j]; break; } } }
      if (!pick) pick = list[0];

      var p2 = String(pick.adcode).slice(0, 2);
      var isMunicipality = (p2 === "11" || p2 === "12" || p2 === "31" || p2 === "50");
      if (pick.level === "province" && !isMunicipality) {
        throw new Error("「" + pick.name + "」是省级行政区，请填写具体城市，如：武汉、宜昌");
      }

      var cityAdcode = _toCityAdcode(pick.adcode, pick.level);
      if (!/^\d{6}$/.test(cityAdcode)) throw new Error("「" + kw + "」的行政区代码解析失败，换个城市名试试");

      var center = String(pick.center || "");
      if (!center || center === "0,0") throw new Error("查不到「" + kw + "」的中心坐标，换个城市名试试");

      return {
        key: "c" + cityAdcode,
        name: pick.name.replace(/市$/, ""),   // "长沙市" → "长沙"，与预置城市命名一致
        adcode: cityAdcode,                    // 公交查询用这个（市级）
        // POI 搜索用原码，县级市才搜得到本地的站（昆山 320583 而不是苏州 320500）；
        // 但直辖市必须用 110000 这种，否则 citylimit 失效、结果跨省会乱
        poiAdcode: isMunicipality ? cityAdcode : String(pick.adcode),
        center: center,
        stations: [],
        destExample: "",
        members: [],
        custom: true
      };
    });
  };

  return tryAt(0);
}

/* ---------------- ③ POI 搜索 ---------------- */
/* 站名清洗：把 "兆丰路(地铁站)" 规范成 "兆丰路地铁站"。
   ★ 千万别把"地铁站"三个字去掉（我试过，会出事）：纯"兆丰路"在城市里会匹配到
     同名的道路，实测解析到太仓方向、偏离 51 公里，而"兆丰路(地铁站)"只有 19 公里，
     就是花桥那个站。带不带括号都行，"地铁站"这三个字必须在。 */
function _cleanPoiName(n) {
  var s = String(n || "").trim();
  if (/地铁站$/.test(s)) return s;
  var m = s.match(/^(.+?)\s*[（(]\s*(地铁站|车站|火车站|火车站\s*)\s*[)）]$/);
  if (m) return m[1] + (m[2] || "地铁站").replace(/\s/g, "");
  return s.replace(/[（(][^（()）]*[)）]\s*$/, "").trim() || s;
}

function _poiSearch(adcode, keywords, types, limit) {
  var url = "https://restapi.amap.com/v3/place/text?keywords=" + encodeURIComponent(keywords) +
    (types ? "&types=" + types : "") +
    "&city=" + adcode + "&citylimit=true" +
    "&offset=" + (limit || 10) + "&page=1&extensions=base&key=" + _coKey();

  // 保留坐标：后面要按"离市中心多远"过滤掉郊县站（比如桂林会把阳朔站搜出来）
  return _coFetch(url).then(function (body) {
    return (body.pois || []).map(function (p) {
      var loc = String(p.location || "").split(",");
      return {
        name: _cleanPoiName(p.name),
        lng: parseFloat(loc[0]),
        lat: parseFloat(loc[1])
      };
    }).filter(function (x) { return x.name; });
  });
  // 故意不 catch：限频/网络错误要上抛，否则会被误读成"这个城市没有地铁站"
}

/* 剔除离市中心太远的站：郊县站（阳朔站这种）拿来做"全员汇合点"不合理，
   而且超出 amap-api.js 的 60km 城市校验后会直接降级 */
var STATION_MAX_KM = 50;

function _nearCenter(items, center) {
  if (typeof _distanceKm !== "function") return items;
  var p = String(center || "").split(",");
  var c = { lng: parseFloat(p[0]), lat: parseFloat(p[1]) };
  if (!isFinite(c.lng) || !isFinite(c.lat)) return items;
  return items.filter(function (it) {
    if (!isFinite(it.lng) || !isFinite(it.lat)) return true;   // 没坐标的不敢丢
    return _distanceKm(c, it) <= STATION_MAX_KM;
  });
}

function _pickNearby(items, center, maxKm) {
  if (!items || !items.length) return "";
  if (typeof _distanceKm === "function") {
    var p = String(center || "").split(",");
    var ctr = { lng: parseFloat(p[0]), lat: parseFloat(p[1]) };
    if (isFinite(ctr.lng) && isFinite(ctr.lat)) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!isFinite(it.lng) || !isFinite(it.lat)) continue;
        if (_distanceKm(ctr, it) <= maxKm) return it.name;
      }
    }
  }
  return items[0].name;   // 近的没有就退回第一个（总比空着好）
}

function _uniqNames(items, max) {  var seen = {}, out = [];
  for (var i = 0; i < items.length && out.length < max; i++) {
    var n = String((items[i] && items[i].name) || "").trim();
    if (!n || seen[n]) continue;
    seen[n] = 1;
    out.push(n);
  }
  return out;
}

/* 候选集合点：优先地铁站，不够补火车站。
   必须是本市真实站名——方案二/三会拿它当地名去查路线，编的名字会被解析到外省。 */
function collectStations(city) {
  var poiCode = city.poiAdcode || city.adcode;
  var near = function (list) { return _nearCenter(list, city.center); };

  return _poiSearch(poiCode, "地铁站", "150500", 10).then(function (metro) {
    var m = near(metro);
    if (m.length >= 4) return _uniqNames(m, 4);
    // 地铁站不够：补火车站。补齐失败（限频/无数据）时至少有地铁站可用，不整单失败
    return _poiSearch(poiCode, "火车站", "150200", 10).then(function (rail) {
      return _uniqNames(m.concat(near(rail)), 4);
    }).catch(function () {
      return _uniqNames(m, 4);
    });
  });
}

/* ---------------- ④ 一步到位：城市名 → 可直接 applyCity 的城市对象 ---------------- */
function prepareOnlineCity(name) {
  return resolveCityByName(name).then(function (city) {
    return collectStations(city).then(function (stations) {
      if (stations.length < 2) {
        throw new Error("「" + city.name + "」查不到足够的地铁/火车站，换个城市名试试（建议地级市）");
      }
      city.stations = stations;

      // 目的地示例：本市景点里挑一个离市中心近的（太偏僻的景点会让示例的耗时/费用很难看）
      return _poiSearch(city.poiAdcode || city.adcode, "景点", "", 8).then(function (spots) {
        city.destExample = _pickNearby(spots, city.center, 15);
        return city;
      }).catch(function () {
        city.destExample = "";
        return city;
      }).then(function (c) {
        /* 示例成员直接用真实站名拼出来：切过去点"生成方案"就能演示，
           不用用户先自己想三个出发地 */
        var st = c.stations;
        c.members = [
          { name: "成员A", origin: st[0], mode: "transit", budget: 20, window: ["08:00", "09:30"] },
          { name: "成员B", origin: st[1], mode: "taxi", budget: 40, window: ["08:00", "09:30"] },
          { name: "成员C", origin: st[2] || st[0], mode: "transit", budget: 15, window: ["08:30", "10:00"] }
        ];
        return c;
      });
    });
  });
}

/* Node 自测导出 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    resolveCityByName: resolveCityByName,
    collectStations: collectStations,
    prepareOnlineCity: prepareOnlineCity,
    _toCityAdcode: _toCityAdcode,
    _keywordCandidates: _keywordCandidates
  };
}
