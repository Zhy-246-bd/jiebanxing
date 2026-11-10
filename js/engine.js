/* ============================================================
 * engine.js — 核心引擎【夏国静负责】
 * 三方案枚举 + 四指标加权打分。当前为可运行的基础版（v0.1），
 * 夏国静的任务是把里面的 TODO 逐个补强，并在 Node 里单测。
 * 依赖：formats.js（约定）、mock-api.js（queryRoute）
 * ============================================================ */

/* ---------- 工具 ---------- */
function _round1(x) { return Math.round(x * 10) / 10; }

/* ---------- 方案一：全部直达 ---------- */
/* TODO 夏国静：预算为 0 表示不限；若成员预算上限 < 实际费用，
   需在结果里给该成员打上"超预算"标记（结果页高亮用） */
function schemeDirect(members, dest) {
  var legs = [];
  var q = members.map(function (m) {
    return queryRoute(m.origin, dest, m.mode).then(function (r) {
      legs.push({
        member: m.name,
        segments: [{ from: m.origin, to: dest, mode: m.mode,
                     durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost }],
        totalMin: r.durationMin, totalCost: r.cost, isBottleneck: false
      });
    });
  });
  return Promise.all(q).then(function () {
    return finishScheme({
      type: "direct",
      name: "方案一：全部直达",
      legs: legs
    });
  });
}

/* ---------- 方案二：全员汇合后再同行 ---------- */
/* TODO 夏国静：v0.1 只试 4 个固定候选点取总分最好的一个；
   后续改成"成员起点几何中心附近抓地铁站"。 */
function schemeMeet(members, dest) {
  var trials = MEETING_CANDIDATES.map(function (pt) {
    return buildMeet(members, dest, pt);
  });
  return Promise.all(trials).then(function (built) {
    return built.sort(function (a, b) { return a.metrics.totalTimeMin - b.metrics.totalTimeMin; })[0];
  });
}

function buildMeet(members, dest, point) {
  var legs = [];
  /* 最后一段全员同乘地铁（简化假设：集合点→目的地用公共交通，费用人均） */
  return queryRoute(point, dest, "transit").then(function (last) {
    var arrivals = [];
    var q = members.map(function (m) {
      return queryRoute(m.origin, point, m.mode).then(function (r) {
        arrivals.push(r.durationMin);
        legs.push({
          member: m.name,
          segments: [
            { from: m.origin, to: point, mode: m.mode,
              durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost },
            { from: point, to: dest, mode: "transit",
              durationMin: last.durationMin, distanceKm: last.distanceKm, cost: last.cost }
          ],
          totalMin: _round1(r.durationMin + last.durationMin),
          totalCost: r.cost + last.cost,
          isBottleneck: false
        });
      });
    });
    return Promise.all(q).then(function () {
      return finishScheme({
        type: "meet",
        name: "方案二：全员在「" + point + "」汇合",
        legs: legs,
        maxWaitMin: Math.max.apply(null, arrivals) - Math.min.apply(null, arrivals)
      });
    });
  });
}

/* ---------- 方案三：部分汇合（顺路的两两结对，落单的人直达） ---------- */
/* TODO 夏国静（本方案是算法亮点，值得多花时间）：
   v0.1 只是按录入顺序两两配对；应改成"起点相近的配对"（如对起点的
   geocode 坐标算距离后贪心配对），并枚举所有配对方式取最优。 */
function schemePartial(members, dest) {
  var pairs = [];
  for (var i = 0; i + 1 < members.length; i += 2) pairs.push([members[i], members[i + 1]]);
  var single = members.length % 2 === 1 ? [members[members.length - 1]] : [];

  var jobs = [];
  pairs.forEach(function (p) {
    jobs.push(buildPartialPair(p[0], p[1], dest));
  });
  if (single.length) jobs.push(buildPartialPair(single[0], null, dest));
  return Promise.all(jobs).then(function (built) {
    var legs = [];
    var worstWait = 0;
    built.forEach(function (b) {
      legs = legs.concat(b.legs);
      if (b.maxWaitMin > worstWait) worstWait = b.maxWaitMin;
    });
    return finishScheme({
      type: "partial",
      name: "方案三：部分汇合（顺路结伴）",
      legs: legs,
      maxWaitMin: worstWait
    });
  });
}

/* 一对成员（b 为 null 时表示单人直达） */
function buildPartialPair(a, b, dest) {
  if (!b) {
    return queryRoute(a.origin, dest, a.mode).then(function (r) {
      return {
        legs: [{
          member: a.name,
          segments: [{ from: a.origin, to: dest, mode: a.mode,
                       durationMin: r.durationMin, distanceKm: r.distanceKm, cost: r.cost }],
          totalMin: r.durationMin, totalCost: r.cost, isBottleneck: false
        }],
        maxWaitMin: 0
      };
    });
  }
  /* 两人选"两人总耗时最小"的候选集合点 */
  var trials = MEETING_CANDIDATES.map(function (pt) {
    return Promise.all([
      queryRoute(a.origin, pt, a.mode),
      queryRoute(b.origin, pt, b.mode),
      queryRoute(pt, dest, "transit")
    ]).then(function (rs) {
      return { point: pt, ra: rs[0], rb: rs[1], last: rs[2],
               pairMin: rs[0].durationMin + rs[1].durationMin };
    });
  });
  return Promise.all(trials).then(function (ts) {
    var best = ts.sort(function (x, y) { return x.pairMin - y.pairMin; })[0];
    var wait = Math.abs(best.ra.durationMin - best.rb.durationMin);
    return {
      legs: [
        { member: a.name,
          segments: [
            { from: a.origin, to: best.point, mode: a.mode,
              durationMin: best.ra.durationMin, distanceKm: best.ra.distanceKm, cost: best.ra.cost },
            { from: best.point, to: dest, mode: "transit",
              durationMin: best.last.durationMin, distanceKm: best.last.distanceKm, cost: best.last.cost }
          ],
          totalMin: _round1(best.ra.durationMin + best.last.durationMin),
          totalCost: best.ra.cost + best.last.cost, isBottleneck: false },
        { member: b.name,
          segments: [
            { from: b.origin, to: best.point, mode: b.mode,
              durationMin: best.rb.durationMin, distanceKm: best.rb.distanceKm, cost: best.rb.cost },
            { from: best.point, to: dest, mode: "transit",
              durationMin: best.last.durationMin, distanceKm: best.last.distanceKm, cost: best.last.cost }
          ],
          totalMin: _round1(best.rb.durationMin + best.last.durationMin),
          totalCost: best.rb.cost + best.last.cost, isBottleneck: false }
      ],
      maxWaitMin: _round1(wait)
    };
  });
}

/* ---------- 收尾：算指标、标瓶颈、打分 ---------- */
function finishScheme(scheme) {
  var totalTime = 0, totalCost = 0, worst = 0;
  scheme.legs.forEach(function (l) {
    totalTime += l.totalMin;
    totalCost += l.totalCost;
    if (l.totalMin > worst) worst = l.totalMin;
  });
  scheme.legs.forEach(function (l) { l.isBottleneck = (l.totalMin === worst); });
  scheme.metrics = {
    totalTimeMin: _round1(totalTime),
    totalCost: totalCost,
    worstTimeMin: _round1(worst),
    maxWaitMin: _round1(scheme.maxWaitMin || 0)
  };
  return scheme;
}

/* ---------- 总入口：生成三方案 + 归一化加权打分 ---------- */
/* TODO 夏国静：打分公式可在这里做答辩讲的"多目标加权评分模型"；
   进阶：把 WEIGHTS 暴露成滑杆让用户调。 */
function generateSchemes(members, dest) {
  return Promise.all([
    schemeDirect(members, dest),
    schemeMeet(members, dest),
    schemePartial(members, dest)
  ]).then(function (schemes) {
    /* 归一化：每项指标除以三方案中的最大值 */
    function norm(key) {
      var max = Math.max.apply(null, schemes.map(function (s) { return s.metrics[key] || 0.0001; }));
      return schemes.map(function (s) { return (s.metrics[key] || 0) / max; });
    }
    var nTime = norm("totalTimeMin"), nCost = norm("totalCost"),
        nWorst = norm("worstTimeMin"), nWait = norm("maxWaitMin");
    schemes.forEach(function (s, i) {
      s.score = _round1(
        WEIGHTS.totalTime * nTime[i] + WEIGHTS.totalCost * nCost[i] +
        WEIGHTS.worstTime * nWorst[i] + WEIGHTS.maxWait * nWait[i]
      );
    });
    schemes.sort(function (a, b) { return a.score - b.score; }); // 分越小越好
    /* 一句话结论：文案内容在 js/result-text.js（闫雅欣维护），此处只做选择 */
    var TXT = (typeof RESULT_TEXT === "undefined")
      ? { best: "综合最优，推荐优先考虑", close: "耗时接近最优，可作备选", far: "耗时或花费偏高，仅在特殊需求时选" }
      : RESULT_TEXT;
    schemes[0].conclusion = TXT.best;
    for (var i = 1; i < schemes.length; i++) {
      schemes[i].conclusion = schemes[i].metrics.totalTimeMin <= schemes[0].metrics.totalTimeMin * 1.1
        ? TXT.close : TXT.far;
    }
    return { schemes: schemes };
  });
}
