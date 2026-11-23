/* ============================================================
 * compare-table.js — 三方案横向对比表【闫雅欣独占文件】
 *
 * 职责：把 localStorage 里的 data.result.schemes 渲染成一张对比表，
 *       并给每列的最优值（最小值）加底色高亮。
 *       样式全部由本文件自己注入，不依赖也不修改 css/style.css。
 *
 * 接入方式（张宇桐只需要加两行，不改 result.html 的其他地方）：
 *   1) <div id="schemeList"></div> 下面加：<div id="compareTable"></div>
 *   2) </body> 之前（内联 <script> 之后）加：<script src="js/compare-table.js"></script>
 *
 * 数据来源：localStorage["jbx_result"] → data.result.schemes
 * 字段：name / metrics.{totalTimeMin,totalCost,worstTimeMin,maxWaitMin} / score / conclusion / legs[].isBottleneck
 * 注意：五项数值全部是「越小越好」（高亮统一取最小）。
 *       score 是 11-19 改口径后的「额外代价」：0 = 三方案里该项综合最省事，越低越优。
 *       旧的 60~100 分制（第一名恒为 100）已废弃，不要再按高分最优去判断。
 * ============================================================ */
(function () {
  "use strict";

  var STYLE_ID = "jbx-compare-style";
  var TABLE_CLASS = "jbx-ct";

  /* ---------- 1. 取数：任何异常都返回 null，绝不抛错 ---------- */
  function readSchemes() {
    var raw;
    try {
      raw = localStorage.getItem("jbx_result");
    } catch (e) {
      return null; // 隐私模式 / 禁用存储
    }
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.result || !Array.isArray(data.result.schemes)) return null;
      if (!data.result.schemes.length) return null;
      return data.result.schemes;
    } catch (e) {
      return null;
    }
  }

  /* ---------- 2. 数值格式化 ---------- */
  function fmt(v, suffix) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v);
    if (!isFinite(n)) return "—";
    n = Math.round(n * 10) / 10;              // 与 engine.js 的 _round1 一致
    var s = String(n);
    if (s.indexOf(".") === -1) s += ".0";     // 77 → 77.0，和 32.9 对齐好看
    return suffix ? s + suffix : s;
  }

  /* ---------- 3. 瓶颈成员：谁让「最长单人」变成这个数 ---------- */
  /* engine.js 用 l.totalMin === worst 判断，耗时并列时会有多人同时是瓶颈，
     所以这里要全取出来拼成「张三、李四」，不能只取第一个。同名成员去重。 */
  /* 【2026-11-23 补】首列短名：方案全名（如“全员在「武汉理工大学南湖校区游泳馆」汇合”）
     会把吸附首列挤得很宽，手机上留给右侧数据列的空间太小。
     表内只显示短名，完整名放 title（长按可看）；方案卡片上仍有全名。 */
  function shortName(full) {
    var s = String(full || "");
    var m = s.match(/^方案[一二三四五\d]+[：:](.*)$/);
    var body = m ? m[1] : s;                 // 去掉“方案一：”前缀（序号徽章已表达）
    body = body.replace(/^全员在「(.+)」汇合$/, "全员汇合·$1");
    body = body.replace(/^部分汇合（(.+)）$/, "部分汇合·$1");
    if (body.length > 16) body = body.slice(0, 16) + "…";   // 两行×约8字，超出才截
    return body || (full || "");
  }

  function bottleneckNames(scheme) {
    var legs = (scheme && scheme.legs) || [];
    var names = [], seen = {};
    for (var i = 0; i < legs.length; i++) {
      if (!legs[i] || !legs[i].isBottleneck) continue;
      var n = legs[i].member || "某成员";
      if (seen[n]) continue;
      seen[n] = true;
      names.push(n);
    }
    return names.length ? names.join("、") : "—";
  }

  /* ---------- 4. 每列最小值（用于高亮） ---------- */
  /* 额外代价专用：保留一位小数（0 → 0.0），超过 100 也照实显示 */
  function fmtScore(v) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v);
    if (!isFinite(n)) return "—";
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function minOf(schemes, pick) {
    var m = Infinity;
    for (var i = 0; i < schemes.length; i++) {
      var v = Number(pick(schemes[i]));
      if (isFinite(v) && v < m) m = v;
    }
    return m;
  }

  /* 一位小数的数据用 0.05 容差判断「并列最优」，避免浮点误差漏高亮 */
  function maxOf(schemes, pick) {
    var m = -Infinity;
    for (var i = 0; i < schemes.length; i++) {
      var v = Number(pick(schemes[i]));
      if (isFinite(v) && v > m) m = v;
    }
    return m;
  }

  function isMax(v, m) {
    var n = Number(v);
    if (!isFinite(n) || !isFinite(m)) return false;
    return n >= m - 0.5;   // 保留给需要「越大越好」的列，目前没有列在用
  }

  /* 【2026-11-19 补】四项指标与额外代价都是「越小越好」。
   * 原文件只写了 isMax 却在渲染时调用 isMin，一渲染就 ReferenceError，
   * 整个对比表挂不出来——这里补上，容差 0.05 让并列最优都能高亮。 */
  function isMin(v, m) {
    var n = Number(v);
    if (!isFinite(n) || !isFinite(m)) return false;
    return n <= m + 0.05;
  }

  /* ---------- 5. 样式：自带，不碰 style.css ---------- */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".jbx-ct-block{margin:22px 0 6px;}",
      ".jbx-ct-title{font-size:15px;font-weight:600;color:var(--text,#2d3748);margin:0 0 10px;}",
      ".jbx-ct-title small{display:block;font-size:12px;font-weight:400;color:var(--text-sub,#718096);margin-top:3px;}",

      /* 手机窄屏的关键：外层横向滚动，表格给最小宽度，页面不会被撑歪 */
      ".jbx-ct-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;",
      "  border:1px solid #e2e8f0;border-radius:var(--radius,12px);background:#fff;",
      "  box-shadow:0 1px 3px rgba(0,0,0,.06);}",

      "table." + TABLE_CLASS + "{width:100%;min-width:680px;border-collapse:separate;",
      "  border-spacing:0;font-size:13px;color:var(--text,#2d3748);font-family:inherit;margin:0;}",

      "table." + TABLE_CLASS + " th{background:var(--primary,#2b6cb0);color:#fff;font-weight:600;",
      "  font-size:12.5px;padding:10px 10px;text-align:center;white-space:nowrap;",
      "  border-bottom:1px solid rgba(255,255,255,.18);}",
      "table." + TABLE_CLASS + " th:first-child{text-align:left;position:sticky;left:0;z-index:3;width:150px;min-width:150px;box-shadow:1px 0 0 rgba(255,255,255,.35);}",

      "table." + TABLE_CLASS + " td{padding:10px;text-align:center;white-space:nowrap;",
      "  border-top:1px solid #edf2f7;background:#fff;}",
      "table." + TABLE_CLASS + " tbody tr:first-child td{border-top:0;}",
      "table." + TABLE_CLASS + " tbody tr:nth-child(even) td{background:#fafcff;}",

      /* 首列吸附：手机上往右滑时方案名始终可见 */
      "table." + TABLE_CLASS + " td:first-child{text-align:left;position:sticky;left:0;z-index:2;width:150px;min-width:150px;",
      "  font-weight:600;box-shadow:1px 0 0 #edf2f7;}",
      "table." + TABLE_CLASS + " tbody tr:nth-child(even) td:first-child{background:#fafcff;}",

      /* 最优值高亮：浅绿底 + 深绿字 */
      ".jbx-ct-min{background:rgba(47,133,90,.14) !important;color:var(--ok,#2f855a) !important;font-weight:700;}",
      ".jbx-ct-unit{font-size:11px;font-weight:400;opacity:.72;margin-left:1px;}",

      ".jbx-ct-rank{display:inline-block;min-width:17px;height:17px;line-height:17px;text-align:center;",
      "  border-radius:999px;background:#edf2f7;color:var(--text-sub,#718096);font-size:11px;",
      "  font-weight:700;margin-right:6px;vertical-align:1px;}",
      ".jbx-ct-rank.is-best{background:var(--ok,#2f855a);color:#fff;}",
      /* 首列短名：最多两行换行展示（不用省略号硬截），全名仍在 title；
         行数上限防异常长名把首列拓高（2026-11-23） */
      ".jbx-ct-name{display:inline-block;max-width:100px;max-height:40px;overflow:hidden;",
      "  white-space:normal;word-break:break-all;line-height:20px;vertical-align:middle;}",
      ".jbx-ct-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;",
      "  background:rgba(47,133,90,.14);color:var(--ok,#2f855a);font-size:11px;font-weight:700;vertical-align:1px;}",
      ".jbx-ct-note{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--text-sub,#718096);}",
      ".jbx-ct-empty{margin:18px 0;padding:16px;border:1px dashed #cbd5e0;border-radius:var(--radius,12px);",
      "  font-size:13px;color:var(--text-sub,#718096);text-align:center;}",
      ".jbx-ct-empty a{color:var(--primary,#2b6cb0);}"
    ].join("\n");
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 6. 渲染 ---------- */
  /* 全程时长 / 人均耗时：新数据直接读，旧缓存（v1122k 及以前生成的结果）现场推算，绝不显示 — */
  function spanOf(s) {
    var m = s.metrics || {};
    if (m.spanMin !== undefined && m.spanMin !== null) return m.spanMin;
    return m.worstTimeMin;                       // 全程时长 ≡ 最慢那人的全程时间
  }
  function avgOf(s) {
    var m = s.metrics || {};
    if (m.avgTimeMin !== undefined && m.avgTimeMin !== null) return m.avgTimeMin;
    var n = (s.legs && s.legs.length) || 0;
    return n ? (Number(m.totalTimeMin) || 0) / n : m.totalTimeMin;
  }

  function buildBlock(schemes) {
    var mSpan  = minOf(schemes, function (s) { return spanOf(s); });
    var mAvg   = minOf(schemes, function (s) { return avgOf(s); });
    var mCost  = minOf(schemes, function (s) { return s.metrics && s.metrics.totalCost; });
    var mWait  = minOf(schemes, function (s) { return s.metrics && s.metrics.maxWaitMin; });
    var mScore = minOf(schemes, function (s) { return s.score; });   // 额外代价越低越优

    var html = [];
    html.push('<div class="jbx-ct-block">');
    /* Q-02 之后人数少时可能只有 1~2 套方案，标题与副注不能写死"三" */
    var nSchemes = schemes.length;
    html.push('<h3 class="jbx-ct-title">' + (nSchemes >= 3 ? '三方案指标对比' : '方案指标对比（共 ' + nSchemes + ' 套）'));
    html.push('<small>绿底 = 该列最优，各列都是越小越好；额外代价 0 = 本次所有方案里综合最省事；手机上表格可左右滑动查看全部列（首列方案名会固定，长按可看全称）</small></h3>');
    html.push('<div class="jbx-ct-wrap">');
    html.push('<table class="' + TABLE_CLASS + '">');
    html.push("<thead><tr>");
    html.push("<th>方案</th><th>全程时长</th><th>人均耗时</th><th>总费用</th>");
    html.push("<th>最长等待</th><th>额外代价</th><th>瓶颈成员</th><th>结论</th>");
    html.push("</tr></thead><tbody>");

    for (var i = 0; i < schemes.length; i++) {
      var s = schemes[i] || {};
      var mt = (s.metrics || {});
      var isBest = (i === 0);

      html.push("<tr>");
      html.push("<td>" +
        '<span class="jbx-ct-rank' + (isBest ? " is-best" : "") + '">' + (i + 1) + "</span>" +
        '<span class="jbx-ct-name" title="' + String(s.name || "").replace(/"/g, "&quot;") + '">' +
        shortName(s.name || "方案" + (i + 1)) + "</span>" +
        (isBest ? '<span class="jbx-ct-badge">推荐</span>' : "") +
        "</td>");

      html.push('<td class="' + (isMin(spanOf(s), mSpan) ? "jbx-ct-min" : "") + '" title="最早出门那个人 → 全员抵达目的地">' +
        fmt(spanOf(s), '<span class="jbx-ct-unit">分</span>') + "</td>");
      html.push('<td class="' + (isMin(avgOf(s), mAvg) ? "jbx-ct-min" : "") + '" title="全员耗时相加 ÷ 人数">' +
        fmt(avgOf(s), '<span class="jbx-ct-unit">分</span>') + "</td>");
      html.push('<td class="' + (isMin(mt.totalCost, mCost) ? "jbx-ct-min" : "") + '">¥' +
        fmt(mt.totalCost) + "</td>");
      html.push('<td class="' + (isMin(mt.maxWaitMin, mWait) ? "jbx-ct-min" : "") + '">' +
        fmt(mt.maxWaitMin, '<span class="jbx-ct-unit">分</span>') + "</td>");
      html.push('<td class="' + (isMin(s.score, mScore) ? "jbx-ct-min" : "") + '">' +
        fmtScore(s.score) + "</td>");

      html.push("<td>" + bottleneckNames(s) + "</td>");
      html.push('<td style="white-space:normal;text-align:left;min-width:150px;">' +
        (s.conclusion || "—") + "</td>");
      html.push("</tr>");
    }

    html.push("</tbody></table></div>");
    html.push('<p class="jbx-ct-note">指标含义：<b>全程时长</b> = 集合时间 − 最早出发那个人的出门时间，再加集合点到目的地的同乘段（即最早出门的人到全员抵达目的地为止，也就是最慢那个人的全程时间）；' +
      '<b>人均耗时</b> = 全员各自耗时相加 ÷ 人数，代表集体付出的时间成本；<b>总费用</b> = 全员费用相加；' +
      '<b>最长等待</b> = 在集合点等最晚到的人所花的时间；<b>额外代价</b> = 四项各比“本次全部方案里最好那个”多付出的比例，按发起人设的权重加权，'
      + '0 表示综合最省事，越低越优（不是百分制得分）。</p>');
    html.push("</div>");
    return html.join("");
  }

  function buildEmpty() {
    return '<p class="jbx-ct-empty">还没有生成方案。请先到 <a href="index.html">录入页</a> 填一轮信息，' +
      "再回来看对比。</p>";
  }

  function mount() {
    injectStyle();

    /* 优先用张宇桐加的容器；他万一忘了加，就在 schemeList 后面自己补一个 */
    var box = document.getElementById("compareTable");
    if (!box) {
      var list = document.getElementById("schemeList");
      if (!list || !list.parentNode) return; // 不在结果页，什么都不做
      box = document.createElement("div");
      box.id = "compareTable";
      list.parentNode.insertBefore(box, list.nextSibling);
      if (window.console && console.info) {
        console.info("[compare-table] 没找到 #compareTable，已在 #schemeList 后自动创建。");
      }
    }

    var schemes = readSchemes();
    box.innerHTML = schemes ? buildBlock(schemes) : buildEmpty();
  }

  try {
    mount();
  } catch (e) {
    /* 兜底：表格挂了也不能连累结果页 */
    if (window.console && console.error) console.error("[compare-table] 渲染失败：", e);
  }
})();
