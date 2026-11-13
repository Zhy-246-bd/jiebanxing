/* ============================================================
 * data-hint.js — 数据可信度提示条（张海燕维护，新增 11-13）
 *
 * 为什么要有这个文件：
 *   amap-api.js 在 Key 错、断网、地名解析失败、超出请求预算时会【静默降级】
 *   成本地估算，页面照常出三张卡片、数字看起来也很正常。
 *   问题是你和老师都无法分辨这组数字是真的还是估的——答辩现场网络抖一下、
 *   或者 Key 撞上 3 QPS 限频，就可能一边展示假数据一边说"这是高德实时数据"。
 *   这个文件把「哪几段是估算」直接写在页面上，让数据自己交代来源。
 *
 * 判断依据：engine.js 每个 segment / leg 上都有 estimated 标记（true = 本地估算），
 *          打车段另有 costEstimated（true = 官方报价没取到，退回公式算的）。
 *
 * 三种状态：
 *   0 段估算          → 绿色细条：全部来自高德实时接口
 *   部分估算          → 黄色条：有几段是估算，仅供参考
 *   全部估算          → 红色条：离线估算数据，请检查 Key 与网络
 *
 * 本文件不依赖任何全局变量，也不改动别人的渲染逻辑，只在最上面插一条提示。
 * ============================================================ */
(function () {
  var host = document.getElementById("dataHint");
  if (!host) return;

  var raw = null;
  try { raw = localStorage.getItem("jbx_result"); } catch (e) { return; }
  if (!raw) return;

  var data = null;
  try { data = JSON.parse(raw); } catch (e) { return; }

  var schemes = (data && data.result && data.result.schemes) || [];
  if (!schemes.length) return;

  var total = 0, est = 0, fareEst = 0;
  schemes.forEach(function (s) {
    (s.legs || []).forEach(function (l) {
      (l.segments || []).forEach(function (seg) {
        total++;
        if (seg.estimated) est++;
        else if (seg.costEstimated) fareEst++;
      });
    });
  });
  if (!total) return;

  var level, text;
  if (est === 0 && fareEst === 0) {
    level = "ok";
    text = "数据来源：高德地图实时接口，本次 " + total + " 段行程全部为真实路况，无估算。";
  } else if (est === total) {
    level = "bad";
    text = "当前展示的是【离线估算数据】：未取到高德实时接口（Key 未配置、Key 类型不对或网络不通），耗时与费用都是本地公式算的，不代表真实路况。";
  } else {
    level = "warn";
    var parts = [];
    if (est) parts.push(est + " 段行程为本地估算（接口未返回，通常是限频或网络波动）");
    if (fareEst) parts.push(fareEst + " 段打车费为公式估算（官方报价未返回）");
    text = "部分数据为估算：" + parts.join("；") + "。其余 " +
      (total - est - fareEst) + " 段为高德实时数据，估算部分仅供参考。";
  }

  var A = "data-hint--";
  host.className = "data-hint " + A + level;
  host.innerHTML = '<span class="data-hint__icon">' + (level === "ok" ? "✓" : level === "warn" ? "!" : "×") +
    '</span><span class="data-hint__text">' + text + "</span>";

  /* 样式从本文件注入，不改 css/style.css（那是陈滢竹的文件） */
  if (document.getElementById("dataHintStyle")) return;
  var st = document.createElement("style");
  st.id = "dataHintStyle";
  st.textContent =
    ".data-hint{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:10px;" +
    "font-size:12px;line-height:1.6;margin-bottom:12px;border:1px solid transparent}" +
    ".data-hint__icon{flex:0 0 16px;width:16px;height:16px;border-radius:50%;font-size:11px;" +
    "line-height:16px;text-align:center;font-weight:700;color:#fff;margin-top:1px}" +
    ".data-hint--ok{background:#f0fff4;border-color:#c6f6d5;color:#22543d}" +
    ".data-hint--ok .data-hint__icon{background:#38a169}" +
    ".data-hint--warn{background:#fffbea;border-color:#fce588;color:#744210}" +
    ".data-hint--warn .data-hint__icon{background:#d69e2e}" +
    ".data-hint--bad{background:#fff5f5;border-color:#feb2b2;color:#822727}" +
    ".data-hint--bad .data-hint__icon{background:#e53e3e}";
  document.head.appendChild(st);
})();
