/* ============================================================
 * engine.js — 核心引擎【夏国静负责】
 *
 * v0.5（2026-11-12）四处 TODO 全部落地：
 *   ① 预算校验      → finishScheme() 给每条腿打 overBudget 标记（budget=0 表示不限）
 *   ② 集合点策略    → _buildGeo() + _rankCands()：先用球面距离粗筛出
 *                     "成员起点几何中心附近、且对全员公平"的候选点，再查真实路线
 *   ③ 部分汇合配对  → _bestPairing()：起点距离矩阵 + 状态压缩 DP，
 *                     枚举全部配对方式取总距离最小（n≤8 时 512 个状态，毫秒级）
 *   ④ 打分模型      → WEIGHT_PRESETS / getWeights / setWeights，
 *                     四指标权重可运行时调整，也读 localStorage 的 jbx_weights
 *
 * v0.6（2026-11-20）修测试清单 Q-02（单人场景）：
 *   ⑤ 方案适用性 → applicableTypes()：方案二/三是"多人"才成立的比较，
 *      1 人时"全员汇合"没人可汇合、"部分汇合"与直达逐字相同，硬算出来的只是
 *      一套比直达更慢的假方案（测试清单 Q-02 里那个 100.6 分的怪物）。
 *      现在 1 人只生成方案一，2 人省掉方案三（结伴就等于全员汇合），
 *      不生成的原因写进 result.skipped，并在推荐卡片的结论里说一句。
 *      ★ 打分仍交给 scoreSchemes（七点五，组长口径），此处只决定"生成哪几套"。
 *
 * 对外契约一字没改（三条铁律第 1、2 条）：
 *   generateSchemes(members, dest[, opts]) → Promise<{ schemes, weights, weightsName }>
 *   方案结果 JSON 的原有字段全部保留，只**新增**了可选字段（见文件末尾清单）；
 *   结果页、文案文件不改任何一行也能照常跑。
 *
 * 依赖：formats.js（数据约定）、amap-api.js（queryRoute / _geoResolve / _distanceKm）
 *   ★ _geoResolve 不存在时（Node 假数据自测、Key 失效）自动退化为
 *     "4 个固定候选点 + 按录入顺序配对"，也就是 v0.1 的行为，不会崩。
 *   ★ 候选集合点每次现读全局 MEETING_CANDIDATES，绝不缓存它的引用——
 *     cities.js 的 applyCity() 是"给全局变量赋新数组"来切城市的（见 v7 改动说明）。
 * ============================================================ */

/* ================= 一、几何工具（纯计算，不发请求） ================= */

function _round1(x) { return Math.round((+x || 0) * 10) / 10; }

/* 两点球面距离（公里）。
   amap-api.js 里已经有 _distanceKm，口金一致就复用，保证和"离市中心 60km 判错"
   用的是同一套度量；它不存在时（假数据环境）用本文件的 haversine 兜底。 */
function _sphereKm(a, b) {
  if (typeof _distanceKm === "function") return _distanceKm(a, b);
  var R = 6371;
  var rad = function (x) { return x * Math.PI / 180; };
  var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* 某点到一组点的平均距离：衡量"这个候选点对所有人是否公平"。
   只看几何中心不够——中心点可能离某个住城外的人很远，平均距离更稳。 */
function _avgDist(pt, pts) {
  if (!pt) return Infinity;
  var sum = 0, n = 0;
  for (var i = 0; i < pts.length; i++) {
    if (!pts[i]) continue;
    sum += _sphereKm(pt, pts[i]);
    n++;
  }
  return n ? sum / n : Infinity;
}

function _centroid(pts) {
  var x = 0, y = 0, n = 0;
  for (var i = 0; i < pts.length; i++) {
    if (!pts[i]) continue;
    x += pts[i].lng; y += pts[i].lat; n++;
  }
  return n ? { lng: x / n, lat: y / n } : null;
}

function _midpoint(a, b) { return { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 }; }

/* 地名归一化：判断"是不是同一个地方"时用，忽略括号备注、空格、大小写 */
function _normName(s) {
  return String(s == null ? "" : s)
    .replace(/[（(].*?[)）]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/* ================= 二、坐标获取（借用接口层的缓存，不额外花配额） ================= */
/* amap-api.js 的 _geoResolve 已经带缓存、并发去重、三级降级，
   这里直接复用它的结果：同一个地名它只查一次，和 queryRoute 命中同一份缓存。 */

function _coordOf(name) {
  if (typeof _geoResolve !== "function") return Promise.resolve(null);
  var task;
  try { task = _geoResolve(name); } catch (e) { return Promise.resolve(null); }
  return Promise.resolve(task).then(function (r) {
    // ⚠ isFinite(null) === true：脏缓存里的 null 会被当成 0，算出来是几内亚湾到中国的距离
    var good = r && r.ok && r.lng != null && r.lat != null && r.lng !== "" && r.lat !== "" &&
               isFinite(r.lng) && isFinite(r.lat);
    return good ? { lng: r.lng, lat: r.lat } : null;
  }).catch(function () { return null; });
}

function _coordsOf(names) {
  return Promise.all(names.map(_coordOf));
}

/* 候选集合点池 = 当前城市的固定站名（cities.js 现读）∪ 各成员起点。
   为什么把成员起点也算进来：经常"就在某人那一站集合"就是最优解——那个人
   0 分钟到位，其他人只绕一点点，总耗时往往比全都跑去市中心更短。 */
function _candidatePool(members, dest) {
  var list = (typeof MEETING_CANDIDATES !== "undefined" && MEETING_CANDIDATES)
    ? MEETING_CANDIDATES.slice() : [];        // ★ 每次现读全局，不缓存引用
  members.forEach(function (m) { if (m.origin) list.push(m.origin); });

  var out = [], seen = {}, destKey = _normName(dest);
  list.forEach(function (name) {
    var k = _normName(name);
    if (!k || seen[k]) return;
    if (k === destKey) return;      // 集合点不能就是目的地（否则方案二变成"到目的地集合"）
    seen[k] = 1;
    out.push(name);
  });
  return out;
}

/* 一次性把坐标解析好，三个方案共用，避免重复 geocode */
function _buildGeo(members, dest) {
  var pool = _candidatePool(members, dest);
  return Promise.all([
    _coordsOf(members.map(function (m) { return m.origin; })),
    _coordsOf(pool)
  ]).then(function (rs) {
    var pts = rs[0], cpts = rs[1], coordMap = {};
    pool.forEach(function (name, i) {
      if (cpts[i]) coordMap[_normName(name)] = cpts[i];
    });
    return { pts: pts, pool: pool, coordMap: coordMap, centroid: _centroid(pts) };
  });
}

/* 候选点排序 + 截断 —— 这是"省请求"的关键：先粗筛，再为少数几个点花真实请求。
   · 方案二：锚点 = 成员起点几何中心，兼顾"离中心近"与"到全员平均近"
   · 方案三：锚点 = 这一对两人的起点，只看这一对是否顺路
   返回 [{name, pt}]，无坐标环境下 pt 为 null */
function _rankCands(geo, maxN, mode, focusIdx) {
  var focusPts = (focusIdx || []).map(function (i) { return geo.pts[i]; });
  var anchor = null;
  if (mode === "pair") {
    var valid = focusPts.filter(Boolean);
    anchor = valid.length === 2 ? _midpoint(valid[0], valid[1]) : (valid[0] || null);
  } else {
    anchor = geo.centroid;
  }

  var scored = [];
  geo.pool.forEach(function (name) {
    var c = geo.coordMap[_normName(name)];
    if (!c) return;
    var score;
    if (mode === "pair") {
      score = _avgDist(c, focusPts);
    } else {
      var dCenter = anchor ? _sphereKm(anchor, c) : 0;
      score = 0.5 * dCenter + 0.5 * _avgDist(c, geo.pts);
    }
    scored.push({ name: name, pt: c, score: score });
  });
  scored.sort(function (a, b) { return a.score - b.score; });

  if (!scored.length) {
    /* 一个坐标都没有（假数据 / Key 失效）→ 退回固定候选点，保持 v0.1 行为 */
    return geo.pool.slice(0, maxN).map(function (n) { return { name: n, pt: null }; });
  }
  return scored.slice(0, maxN);
}

/* ================= 三、方案一：全部直达 ================= */
/* 预算数据在这里挂上去：leg.budget 由成员带过来，由 finishScheme 统一判断，
   这样三个方案的超支口径完全一致 */
function schemeDirect(members, dest) {
  var jobs = members.map(function (m) {
    return queryRoute(m.origin, dest, m.mode).then(function (r) {
      return {
        member: m.name,
        budget: +m.budget || 0,                      // 新增字段：0 表示不限
        mode: m.mode,
        segments: [{ from: m.origin, to: dest, mode: m.mode,
                     durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost,
                     estimated: !!r.estimated }],
        totalMin: _round1(r.durationMin),
        totalCost: r.cost,
        estimated: !!r.estimated,
        isBottleneck: false
      };
    });
  });
  return Promise.all(jobs).then(function (legs) {
    return finishScheme({
      type: "direct",
      name: "方案一：全部直达",
      legs: legs
    });
  });
}

/* ================= 四、方案二：全员汇合 ================= */

var MAX_MEET_CANDIDATES = 4;   // 粗筛后真正去查路线的集合点个数（每多 1 个 ≈ 多 n+1 次请求）

/* 排序口径：总耗时 → 总费用 → 最长等待
   （原来只比总耗时，两个候选点打平时结果不稳定，刷新一次可能换一个） */
function _byTimeCostWait(a, b) {
  if (a.metrics.totalTimeMin !== b.metrics.totalTimeMin)
    return a.metrics.totalTimeMin - b.metrics.totalTimeMin;
  if (a.metrics.totalCost !== b.metrics.totalCost)
    return a.metrics.totalCost - b.metrics.totalCost;
  return a.metrics.maxWaitMin - b.metrics.maxWaitMin;
}

function schemeMeet(members, dest, geo) {
  if (!members.length) {
    return Promise.resolve(finishScheme({ type: "meet", name: "方案二：全员汇合", legs: [], maxWaitMin: 0 }));
  }
  var ready = geo ? Promise.resolve(geo) : _buildGeo(members, dest);
  return ready.then(function (g) {
    var cands = _rankCands(g, MAX_MEET_CANDIDATES, "meet");
    var trials = cands.map(function (c) { return buildMeet(members, dest, c.name); });
    return Promise.all(trials).then(function (built) {
      built.sort(_byTimeCostWait);
      var best = built[0];
      /* 答辩用：说明"没有穷举全城站点，而是用球面距离先筛掉明显绕远的点" */
      best.candidatesTried = built.length;
      best.candidateNames = cands.map(function (c) { return c.name; });
      return best;
    });
  });
}

function buildMeet(members, dest, point) {
  /* 最后一段全员同乘（简化假设：集合点→目的地走公共交通，费用人均） */
  return queryRoute(point, dest, "transit").then(function (last) {
    var jobs = members.map(function (m) {
      return queryRoute(m.origin, point, m.mode).then(function (r) {
        return {
          member: m.name,
          budget: +m.budget || 0,
          mode: m.mode,
          meetAt: point,
          arriveIn: r.durationMin,            // 内部用：算"谁等谁"
          segments: [
            { from: m.origin, to: point, mode: m.mode,
              durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost,
              estimated: !!r.estimated },
            { from: point, to: dest, mode: "transit",
              durationMin: last.durationMin, distanceKm: last.distanceKm, cost: last.cost,
              estimated: !!last.estimated }
          ],
          totalMin: _round1(r.durationMin + last.durationMin),
          totalCost: _round1(r.cost + last.cost),
          estimated: !!(r.estimated || last.estimated),
          isBottleneck: false
        };
      });
    });
    return Promise.all(jobs).then(function (legs) {
      /* 最长等待 = 最早到的人等最晚到的人（只看"到集合点"那一段）
         ★ 空数组时 Math.max 返回 -Infinity，必须兜底 */
      var arrivals = legs.map(function (l) { return l.arriveIn; });
      var maxWait = arrivals.length
        ? _round1(Math.max.apply(null, arrivals) - Math.min.apply(null, arrivals)) : 0;
      var scheme = finishScheme({
        type: "meet",
        name: "方案二：全员在「" + point + "」汇合",
        legs: legs,
        maxWaitMin: maxWait
      });
      scheme.meetingPoint = point;
      return scheme;
    });
  });
}

/* ================= 五、方案三：部分汇合（最优配对） ================= */
/* 把"谁和谁结伴"看成图上的最小权匹配问题：
   · 边权 = 两人起点之间的球面距离（起点越近，凑到一起越不绕路）
   · 偶数人 → 求完美匹配，人人有伴
   · 奇数人 → 允许且仅允许 1 人落单（落单者直达），由 DP 自己挑谁落单最划算
   · n ≤ 8 时状态数 2^8 × 2 = 512，枚举全部配对方式，得到**全局最优**而不是贪心近似
   · 没有坐标（假数据/降级）→ 退回"按录入顺序两两配对"，即 v0.1 行为 */

var MAX_PAIR_CANDIDATES = 2;   // 每一对只查 2 个集合点：4 对 × 2 点 × 3 请求 = 24 次
var PAIRING_DP_LIMIT = 12;     // 超过这个人数改用顺序配对（项目上限 8 人，留余量）

function _costMatrix(pts) {
  var n = pts.length, c = [];
  for (var i = 0; i < n; i++) {
    c[i] = [];
    for (var j = 0; j < n; j++) {
      c[i][j] = (i === j) ? 0 : ((pts[i] && pts[j]) ? _sphereKm(pts[i], pts[j]) : 0);
    }
  }
  return c;
}

function _sequentialPairing(n) {
  var pairs = [], singles = [];
  for (var i = 0; i + 1 < n; i += 2) pairs.push([i, i + 1]);
  if (n % 2 === 1) singles.push(n - 1);
  return { pairs: pairs, singles: singles, exact: false, reason: "no-coords" };
}

function _bestPairing(members, pts) {
  var n = members.length;
  if (n < 2) {
    return { pairs: [], singles: members.map(function (_, i) { return i; }), exact: true };
  }
  var known = pts.filter(Boolean).length;
  if (known < n || n > PAIRING_DP_LIMIT) return _sequentialPairing(n);

  var cost = _costMatrix(pts);
  var FULL = (1 << n) - 1;
  var memo = {}, choice = {};

  /* solve(mask, allowSingle)：覆盖 mask 里这些人，还允不允许再放一个人落单。
     key 用 mask*2+allowSingle 压成一个整数，查表 O(1)。 */
  function solve(mask, allowSingle) {
    if (!mask) return 0;
    var k = mask * 2 + allowSingle;
    if (memo[k] !== undefined) return memo[k];

    var i = 0;
    while (!(mask & (1 << i))) i++;         // 取编号最小的成员，同一组配对不会被重复枚举
    var rest = mask & ~(1 << i);
    var best = Infinity, take = null;

    if (allowSingle) {
      var c0 = solve(rest, 0);              // 让 i 落单（直达）
      if (c0 < best) { best = c0; take = { single: i }; }
    }
    for (var j = i + 1; j < n; j++) {
      if (!(rest & (1 << j))) continue;
      var c1 = cost[i][j] + solve(rest & ~(1 << j), allowSingle);
      if (c1 < best) { best = c1; take = { pair: j }; }
    }
    memo[k] = best;
    choice[k] = take;
    return best;
  }

  var allow = n % 2 === 1 ? 1 : 0;
  solve(FULL, allow);

  var pairs = [], singles = [];
  var mask = FULL, s = allow;
  while (mask) {
    var kk = mask * 2 + s, act = choice[kk];
    var i2 = 0;
    while (!(mask & (1 << i2))) i2++;
    if (act.single !== undefined) {
      singles.push(act.single);
      mask &= ~(1 << act.single);
      s = 0;
    } else {
      pairs.push([i2, act.pair]);
      mask &= ~((1 << i2) | (1 << act.pair));
    }
  }
  return { pairs: pairs, singles: singles, exact: true, totalKm: _round1(memo[FULL * 2 + allow]) };
}

function schemePartial(members, dest, geo) {
  if (!members.length) {
    return Promise.resolve(finishScheme({ type: "partial", name: "方案三：部分汇合", legs: [], maxWaitMin: 0 }));
  }
  var ready = geo ? Promise.resolve(geo) : _buildGeo(members, dest);
  return ready.then(function (g) {
    var pairing = _bestPairing(members, g.pts);
    var jobs = [];

    pairing.pairs.forEach(function (idx) {
      var a = members[idx[0]], b = members[idx[1]];
      var cands = _rankCands(g, MAX_PAIR_CANDIDATES, "pair", idx);
      jobs.push(buildPartialPair(a, b, dest, cands).then(function (r) {
        if (r.legs.length === 2) {          // 标上"和谁结伴"，结果页用得上
          r.legs[0].partner = b.name;
          r.legs[1].partner = a.name;
        }
        return r;
      }));
    });
    pairing.singles.forEach(function (i) {
      jobs.push(buildPartialPair(members[i], null, dest, null));
    });

    return Promise.all(jobs).then(function (built) {
      var legs = [], worstWait = 0;
      built.forEach(function (b) {
        legs = legs.concat(b.legs);
        if (b.maxWaitMin > worstWait) worstWait = b.maxWaitMin;
      });
      var desc = [];
      if (pairing.pairs.length) desc.push(pairing.pairs.length + " 组结伴");
      if (pairing.singles.length) desc.push(pairing.singles.length + " 人直达");
      var scheme = finishScheme({
        type: "partial",
        name: "方案三：部分汇合（" + (desc.join(" + ") || "无") + "）",
        legs: legs,
        maxWaitMin: _round1(worstWait)
      });
      scheme.pairing = {
        pairs: pairing.pairs.map(function (p) { return [members[p[0]].name, members[p[1]].name]; }),
        singles: pairing.singles.map(function (i) { return members[i].name; }),
        exact: !!pairing.exact,
        reason: pairing.reason || "",
        totalKm: pairing.totalKm
      };
      return scheme;
    });
  });
}

/* 一对成员（b 为 null 表示单人直达）
   cands 为粗筛后的候选集合点 [{name, pt}]；null 表示走直达 */
function buildPartialPair(a, b, dest, cands) {
  if (!b) {
    return queryRoute(a.origin, dest, a.mode).then(function (r) {
      return {
        legs: [{
          member: a.name,
          budget: +a.budget || 0,
          mode: a.mode,
          segments: [{ from: a.origin, to: dest, mode: a.mode,
                       durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost,
                       estimated: !!r.estimated }],
          totalMin: _round1(r.durationMin), totalCost: r.cost,
          estimated: !!r.estimated, isBottleneck: false
        }],
        maxWaitMin: 0
      };
    });
  }

  var use = (cands && cands.length) ? cands : [];
  var trials = use.filter(function (c) { return !!c.name; }).map(function (c) {
    return Promise.all([
      queryRoute(a.origin, c.name, a.mode),
      queryRoute(b.origin, c.name, b.mode),
      queryRoute(c.name, dest, "transit")
    ]).then(function (rs) {
      return { point: c.name, ra: rs[0], rb: rs[1], last: rs[2],
               pairMin: rs[0].durationMin + rs[1].durationMin };
    });
  });

  /* 极端兜底：一个候选点都没有 → 两人各自直达（不至于抛错让整页白屏） */
  if (!trials.length) {
    return Promise.all([
      queryRoute(a.origin, dest, a.mode), queryRoute(b.origin, dest, b.mode)
    ]).then(function (rs) {
      return {
        legs: [
          { member: a.name, budget: +a.budget || 0, mode: a.mode,
            segments: [{ from: a.origin, to: dest, mode: a.mode,
                         durationMin: rs[0].durationMin, distanceKm: rs[0].distanceKm,
                         cost: rs[0].cost, estimated: !!rs[0].estimated }],
            totalMin: _round1(rs[0].durationMin), totalCost: rs[0].cost,
            estimated: !!rs[0].estimated, isBottleneck: false },
          { member: b.name, budget: +b.budget || 0, mode: b.mode,
            segments: [{ from: b.origin, to: dest, mode: b.mode,
                         durationMin: rs[1].durationMin, distanceKm: rs[1].distanceKm,
                         cost: rs[1].cost, estimated: !!rs[1].estimated }],
            totalMin: _round1(rs[1].durationMin), totalCost: rs[1].cost,
            estimated: !!rs[1].estimated, isBottleneck: false }
        ],
        maxWaitMin: 0
      };
    });
  }

  return Promise.all(trials).then(function (ts) {
    /* 选"两人到集合点耗时之和"最小的点；打平时取等待更短的（体感更好） */
    ts.sort(function (x, y) {
      if (x.pairMin !== y.pairMin) return x.pairMin - y.pairMin;
      return Math.abs(x.ra.durationMin - x.rb.durationMin) - Math.abs(y.ra.durationMin - y.rb.durationMin);
    });
    var best = ts[0];
    var wait = _round1(Math.abs(best.ra.durationMin - best.rb.durationMin));
    return {
      legs: [
        { member: a.name, budget: +a.budget || 0, mode: a.mode, meetAt: best.point,
          segments: [
            { from: a.origin, to: best.point, mode: a.mode,
              durationMin: best.ra.durationMin, distanceKm: best.ra.distanceKm, cost: best.ra.cost,
              estimated: !!best.ra.estimated },
            { from: best.point, to: dest, mode: "transit",
              durationMin: best.last.durationMin, distanceKm: best.last.distanceKm, cost: best.last.cost,
              estimated: !!best.last.estimated }
          ],
          totalMin: _round1(best.ra.durationMin + best.last.durationMin),
          totalCost: _round1(best.ra.cost + best.last.cost),
          estimated: !!(best.ra.estimated || best.last.estimated),
          isBottleneck: false },
        { member: b.name, budget: +b.budget || 0, mode: b.mode, meetAt: best.point,
          segments: [
            { from: b.origin, to: best.point, mode: b.mode,
              durationMin: best.rb.durationMin, distanceKm: best.rb.distanceKm, cost: best.rb.cost,
              estimated: !!best.rb.estimated },
            { from: best.point, to: dest, mode: "transit",
              durationMin: best.last.durationMin, distanceKm: best.last.distanceKm, cost: best.last.cost,
              estimated: !!best.last.estimated }
          ],
          totalMin: _round1(best.rb.durationMin + best.last.durationMin),
          totalCost: _round1(best.rb.cost + best.last.cost),
          estimated: !!(best.rb.estimated || best.last.estimated),
          isBottleneck: false }
      ],
      maxWaitMin: wait
    };
  });
}

/* ================= 六、收尾：指标 / 瓶颈 / 预算校验 ================= */

function finishScheme(scheme) {
  var totalTime = 0, totalCost = 0, worst = 0, estimated = 0;
  var over = [];

  scheme.legs.forEach(function (l) {
    totalTime += l.totalMin;
    totalCost += l.totalCost;
    if (l.totalMin > worst) worst = l.totalMin;
    if (l.estimated) estimated++;

    /* ① 预算校验：budget = 0 表示不限；超了就打标记，供结果页高亮。
       加 1e-9 容差：费用经过 /10 取整，浮点比较会出现 20.000000000000004 > 20 这种假超支 */
    var b = +l.budget || 0;
    if (b > 0 && l.totalCost > b + 1e-9) {
      l.overBudget = true;
      l.overBudgetBy = _round1(l.totalCost - b);
      over.push({ member: l.member, budget: b, cost: _round1(l.totalCost), over: l.overBudgetBy });
    } else {
      l.overBudget = false;
      l.overBudgetBy = 0;
    }
  });

  /* 瓶颈成员 = 单人耗时最长的人（并列都标，沿用 v0.1 行为） */
  scheme.legs.forEach(function (l) { l.isBottleneck = (l.totalMin === worst) && worst > 0; });

  /* 【2026-11-23 按组长口径补两个面向用户的时间指标】
   *   spanMin  全程时长：第一个人出门 → 全员抵达目的地。
   *            集合场景下 = (集合时间 − 最早出发时间) + 集合点→目的地同乘段，
   *            化简后恰好等于「最慢那个人的全程时间」（最后一段全员同乘，是同一个加数）。
   *            前端口径说明就按「集合时间 − 最早出发」讲，这是最直观的算法。
   *   avgTimeMin 人均耗时：totalTimeMin ÷ 人数，代表"集体一共花了多长的时间成本"折算到每人。
   *   totalTimeMin 仍保留（评分模型按它算额外代价的比例），只是不再直接展示成"总耗时"。 */
  var nLegs = scheme.legs.length || 1;

  scheme.metrics = {
    totalTimeMin: _round1(totalTime),
    avgTimeMin: _round1(totalTime / nLegs),
    spanMin: _round1(worst),
    totalCost: _round1(totalCost),
    worstTimeMin: _round1(worst),
    maxWaitMin: _round1(scheme.maxWaitMin || 0)
  };
  scheme.overBudget = over;         // 新增：超预算名单（空数组 = 全员在预算内）
  scheme.estimatedLegs = estimated; // 新增：几条腿是降级估算出来的（>0 说明数据不全是真实的）
  return scheme;
}

/* ========== 六点五、方案适用性（v0.6，Q-02 单人场景） ========== */
/* 三套方案得有三个人才凑得齐：
 *   1 人 → 只有方案一有意义。方案二"全员汇合"没人可汇合，实际只是"先跑到某个站
 *          再坐公交去目的地"，比直达更慢更贵，却照样参与打分排序（Q-02 里那套
 *          100.6 分就是这么来的）；方案三没有同伴可结对，会逐字复制方案一。
 *   2 人 → 方案二的"全员汇合"就是"两人结伴"，方案三是它的翻版，省掉。
 *   3 人以上 → 三套才真正互不相同，全都生成。
 * 返回本次要生成的方案类型，按 一、二、三 顺序。
 */
function applicableTypes(n) {
  if (n <= 1) return ["direct"];
  if (n === 2) return ["direct", "meet"];
  return ["direct", "meet", "partial"];
}

var SCHEME_META = {
  direct: { type: "direct", name: "方案一：全部直达" },
  meet: { type: "meet", name: "方案二：全员汇合" },
  partial: { type: "partial", name: "方案三：部分汇合" }
};

function _skipReason(type, n) {
  if (type === "meet")
    return "只有 1 人，没有同伴可以汇合，全员汇合不适用";
  if (type === "partial")
    return (n === 2)
      ? "2 人结伴就等于全员汇合，与方案二完全等价，部分汇合不适用"
      : "只有 1 人，没有同伴可以结伴，部分汇合与直达完全相同";
  return "不适用";
}

/* 结论文案优先用 result-text.js（闫雅欣的文件）里的同名键，没有就用这里的默认值，
   她想改说法只改自己的文件，不用碰引擎 */
function _txt(key, def) {
  if (typeof RESULT_TEXT !== "undefined" && RESULT_TEXT &&
      typeof RESULT_TEXT[key] === "string" && RESULT_TEXT[key]) return RESULT_TEXT[key];
  return def;
}

function _skippedNote(skipped, n) {
  if (n < 1) return "还没有成员，只生成直达方案";
  if (n === 1) return _txt("solo", "只有你 1 人：直达就是最优，无需汇合与结伴（方案二、方案三已省略）");
  return _txt("pairwise", "2 人结伴等于全员汇合，方案三与方案二等价，已省略");
}

/* ================= 七、打分模型（权重可调） ================= */

/* 四套预设：答辩时"让用户按场景选偏好"，权重一眼能讲清 */
var WEIGHT_PRESETS = {
  balanced: { name: "均衡",     totalTime: 0.4,  totalCost: 0.2,  worstTime: 0.3,  maxWait: 0.1 },
  fast:     { name: "时间优先", totalTime: 0.6,  totalCost: 0.05, worstTime: 0.3,  maxWait: 0.05 },
  cheap:    { name: "省钱优先", totalTime: 0.2,  totalCost: 0.6,  worstTime: 0.1,  maxWait: 0.1 },
  comfort:  { name: "少等待",   totalTime: 0.25, totalCost: 0.1,  worstTime: 0.25, maxWait: 0.4 }
};

var WEIGHTS_STORE_KEY = "jbx_weights";
var _WEIGHT_KEYS = ["totalTime", "totalCost", "worstTime", "maxWait"];

/* 权重清洗：负数/非数字归零，再归一化到和为 1。
   调用方可以传 40/20/30/10 这种"比例"（发起人填的），也可以传 0.4/0.2/0.3/0.1，都能吃。 */
function _sanitizeWeights(w) {
  var out = {}, sum = 0;
  _WEIGHT_KEYS.forEach(function (k) {
    var v = Number(w && w[k]);
    if (!isFinite(v) || v < 0) v = 0;
    out[k] = v;
    sum += v;
  });
  if (sum <= 0) {
    _WEIGHT_KEYS.forEach(function (k) { out[k] = WEIGHT_PRESETS.balanced[k]; });
    sum = 1;
  }
  _WEIGHT_KEYS.forEach(function (k) { out[k] = out[k] / sum; });
  return out;
}

function _weightsName(w) {
  for (var k in WEIGHT_PRESETS) {
    if (!WEIGHT_PRESETS.hasOwnProperty(k)) continue;
    var p = _sanitizeWeights(WEIGHT_PRESETS[k]), same = true;
    _WEIGHT_KEYS.forEach(function (kk) {
      if (Math.abs(p[kk] - w[kk]) > 0.001) same = false;
    });
    if (same) return WEIGHT_PRESETS[k].name;
  }
  return "自定义";
}

/* 当前生效权重：localStorage 里有就用它，否则用 formats.js 的 WEIGHTS（兼容老配置） */
function getWeights() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(WEIGHTS_STORE_KEY)); } catch (e) { saved = null; }
  if (saved) return _sanitizeWeights(saved);
  var base = (typeof WEIGHTS !== "undefined" && WEIGHTS) ? WEIGHTS : WEIGHT_PRESETS.balanced;
  return _sanitizeWeights(base);
}

/* 供 UI 调用：滑杆拖完存一下就行，不用改 generateSchemes 的调用处 */
function setWeights(w) {
  var clean = _sanitizeWeights(w);
  try { localStorage.setItem(WEIGHTS_STORE_KEY, JSON.stringify(clean)); } catch (e) { /* 无 localStorage 忽略 */ }
  return clean;
}

function applyWeightPreset(key) {
  var p = WEIGHT_PRESETS[key] || WEIGHT_PRESETS.balanced;
  return setWeights(p);
}

function resetWeights() {
  try { localStorage.removeItem(WEIGHTS_STORE_KEY); } catch (e) { /* 忽略 */ }
  return getWeights();
}

/* ================= 七点五、打分：相对最优的"额外代价" ================= */
/* 口径（2026-11-19 按组长要求改）：
 *   原来是把三个方案的成本线性拉开映射到 60~100，第一名恒为 100 分——
 *   但"最优"只是三者里相对最好，不代表方案本身满分，100 分站不住脚。
 *   现在改成**绝对口径的额外代价**：
 *     ① 四个指标各自取三方案里的最优值当基准；
 *     ② 每个方案逐项算"比基准多付出多少"（相对比例，0 = 该项最优）；
 *     ③ 用发起人给的权重加权 → score = 额外代价，0 起，越低越好，1 分 = 综合多付出 1%。
 *   好处：三套方案差不多好时，分数都贴近 0（"怎么走都行"）；
 *         差距大时才会拉开，而且数字能直接读成百分比，不再有"硬凑的 100 分"。
 *   换权重不需要重新查路线：metrics 已经算好了，这里只做纯数学重排。 */
var _METRIC_KEYS = ["totalTime", "totalCost", "worstTime", "maxWait"];
var _METRIC_FIELDS = { totalTime: "totalTimeMin", totalCost: "totalCost", worstTime: "worstTimeMin", maxWait: "maxWaitMin" };

function scoreSchemes(schemes, weights) {
  var w = _sanitizeWeights(weights || getWeights());
  var list = (schemes || []).slice();
  var base = {};

  if (list.length) {
    _METRIC_KEYS.forEach(function (k) {
      var f = _METRIC_FIELDS[k];
      var vals = list.map(function (s) { return (s.metrics && +s.metrics[f]) || 0; });
      base[k] = Math.min.apply(null, vals);
    });

    list.forEach(function (s) {
      var d = {}, cost = 0;
      _METRIC_KEYS.forEach(function (k) {
        var f = _METRIC_FIELDS[k];
        var v = (s.metrics && +s.metrics[f]) || 0;
        var maxV = Math.max.apply(null, list.map(function (x) { return (x.metrics && +x.metrics[f]) || 0; }));
        /* 基准为 0（例如直达的最长等待）时不能除 0，改用"与最大值的差距"缩放 */
        var rel = base[k] > 0 ? (v - base[k]) / base[k]
                              : (maxV > 0 ? (v - base[k]) / maxV : 0);
        if (!isFinite(rel) || rel < 0) rel = 0;
        d[k] = Math.round(rel * 100) / 100;      // 保留两位，页面直接显示百分比
        cost += w[k] * rel;
      });
      s.scoreDetail = d;
      s.rawScore = Math.round(cost * 10000) / 10000;      // 0~1+，内部成本
      s.score = Math.round(cost * 1000) / 10;             // 对外：额外代价，1 位小数
    });

    list.sort(function (a, b) { return a.score - b.score; });   // 代价越低越优
  }

  return { schemes: list, weights: w, weightsName: _weightsName(w), baseline: base };
}

/* ================= 八、总入口：生成三方案 + 加权打分 ================= */
/* opts 全部可选，不传就是老行为：
 *   weights  {totalTime,totalCost,worstTime,maxWait}  本次使用的权重
 *   onStage  function(stageText)  进度回调（一次生成 7~10 秒，UI 可以拿它做进度提示）
 * 例：
 *   generateSchemes(members, dest)
 *   generateSchemes(members, dest, { weights: WEIGHT_PRESETS.cheap, onStage: showStage })
 */
function generateSchemes(members, dest, opts) {
  opts = opts || {};
  members = members || [];
  var weights = _sanitizeWeights(opts.weights || getWeights());
  var stage = function (s) {
    if (typeof opts.onStage === "function") {
      try { opts.onStage(s); } catch (e) { /* UI 出错不影响计算 */ }
    }
  };

  /* ★ v0.6：先定"这次该生成哪几套"，不适用的一律不生成，只留原因（Q-02） */
  var plan = applicableTypes(members.length);
  var skipped = [];
  ["meet", "partial"].forEach(function (t) {
    if (plan.indexOf(t) < 0) {
      skipped.push({ type: t, name: SCHEME_META[t].name, reason: _skipReason(t, members.length) });
    }
  });

  /* 方案一不需要坐标，只有方案二/三要。单人场景因此一次 geocode 都不发，
     请求数从原来 10 次左右降到 1 次（只剩那条直达路线） */
  var needGeo = plan.indexOf("meet") >= 0 || plan.indexOf("partial") >= 0;

  stage(members.length <= 1 ? "只有 1 人：直接计算直达路线…" : "正在解析出发地坐标…");

  var geoReady = needGeo ? _buildGeo(members, dest) : Promise.resolve(null);

  var runner = {
    direct: function (g) { return schemeDirect(members, dest); },
    meet: function (g) { return schemeMeet(members, dest, g); },
    partial: function (g) { return schemePartial(members, dest, g); }
  };
  var stageText = {
    direct: "方案一：计算全部直达…",
    meet: "方案二：筛选集合点，计算全员汇合…",
    partial: "方案三：按距离配对，计算部分汇合…"
  };

  return geoReady.then(function (geo) {
    /* 串行生成：进度提示能按 一→二→三 的顺序刷，也不至于三套同时抢接口配额 */
    var chain = Promise.resolve(), out = [];
    plan.forEach(function (t) {
      chain = chain.then(function () {
        stage(stageText[t]);
        return runner[t](geo).then(function (s) { out.push(s); });
      });
    });
    return chain.then(function () { return out; });
  }).then(function (schemes) {
    stage("按权重打分并排序…");

    /* 打分交给 scoreSchemes：换权重只需重跑这一步，不用重新查路线 */
    var scored = scoreSchemes(schemes, weights);
    var list = scored.schemes;

    /* 一句话结论：文案在 js/result-text.js（闫雅欣维护），此处只做选择 */
    var TXT = (typeof RESULT_TEXT === "undefined")
      ? { best: "综合最优，推荐优先考虑", close: "耗时接近最优，可作备选", far: "耗时或花费偏高，仅在特殊需求时选" }
      : RESULT_TEXT;
    list.forEach(function (s, i) {
      var base = (i === 0)
        ? TXT.best
        : (s.metrics.totalTimeMin <= list[0].metrics.totalTimeMin * 1.1 ? TXT.close : TXT.far);

      /* ★ v0.6：只在推荐的那张卡片上补一句"为什么只有这几套方案"，
         用户看到方案变少时不至于以为是程序出错（Q-02） */
      if (i === 0 && skipped.length) base += "　" + _skippedNote(skipped, members.length);
      s.conclusion = base;
    });

    return {
      schemes: list,
      weights: scored.weights,               // 本次实际使用的权重（已归一化到和为 1）
      weightsName: scored.weightsName,       // 命中的预设名，否则"自定义"
      baseline: scored.baseline,             // 每项指标在各方案里的最优值
      skipped: skipped,                      // 新增：本次没生成的方案 + 原因（空数组 = 三套都生成了）
      memberCount: members.length            // 新增：参与计算的人数
    };
  });
}

/* ================= 九、v0.5 新增字段一览（组内交接用） =================
 * 全部是**新增**字段，原有字段一个没动；老代码不读它也不会出错。
 *
 * leg 上：
 *   budget        Number  成员预算上限（0 = 不限）
 *   overBudget    Bool    是否超预算 —— 结果页可据此标红
 *   overBudgetBy  Number  超出金额（元）
 *   mode          String  该成员的出行偏好
 *   partner       String  方案三：和谁结伴
 *   meetAt        String  方案二/三：在哪碰头
 *   arriveIn      Number  方案二：到集合点的耗时（内部算等待用）
 *   estimated     Bool    这条是不是本地估算（降级）
 *
 * scheme 上：
 *   overBudget      Array   [{member, budget, cost, over}]
 *   estimatedLegs   Number  有几条腿是估算的
 *   candidatesTried Number  方案二粗筛后实际查询的候选点个数
 *   candidateNames  Array   方案二参与比较的候选点名
 *   meetingPoint    String  方案二最终选的集合点
 *   pairing         Object  方案三配对结果 {pairs, singles, exact, totalKm}
 *   scoreDetail     Object  四个分项的加权贡献
 *
 * generateSchemes 返回值上：
 *   weights / weightsName / baseline
 *   skipped       Array   本次没生成的方案 [{type, name, reason}]（空数组 = 三套都生成了）
 *   memberCount   Number  参与计算的人数
 *
 * ★ v0.6（Q-02）：1 人 → schemes 只有方案一；2 人 → 方案一 + 方案二；
 *   3 人以上才是三套。页面遍历 schemes 就行，不需要判断长度（只剩一张卡片时
 *   它就是"★ 推荐"）。不生成的原因在 result.skipped，结论行里也写了一句。
 *   想改这句话的说法，在 result-text.js 里加键即可（不用改引擎）：
 *     RESULT_TEXT.solo      单人时那句
 *     RESULT_TEXT.pairwise  双人时那句
 *
 * ★ 张宇桐要在结果页高亮超预算，渲染 leg 时加一行即可（不用改引擎）：
 *   (l.overBudget ? '<span class="over-budget">超预算 ¥' + l.overBudgetBy + '</span>' : '')
 * ★ 陈滢竹要做权重滑杆，拖完调 setWeights({...}) 即可，下次生成自动生效。
 * ======================================================================= */
