/* ============================================================
 * map-picker.js — 出发地「地图选点」弹层【雷馨怡 · 2026-11-16】
 *
 * 对外只有一个入口（其余全是内部实现）：
 *   JBXMapPicker.open({
 *     city:   "武汉",                  // 当前城市名，仅用于错误提示与兜底文案
 *     center: [114.3055, 30.5928],     // 城市中心，地图初始位置
 *     lnglat: [114.31, 30.59],         // 可选：已有选点，打开时图钉落在那里
 *     onPick: function (r) {}          // r = { name, lng, lat, adcode }
 *   });
 *   JBXMapPicker.close();
 *
 * 三条设计约束（都是踩过的坑）：
 *   ① 样式全部本文件注入 <style>，不碰 css/style1.css（陈滢竹的文件）
 *   ② JS API 懒加载：点按钮才下载 200KB+，不要在 index1.html 的 head 里写死 <script>
 *   ③ 图钉是绝对定位的 DOM，压在容器正中，不跟随 mapmove 挪 marker
 *      （跟随会抖、会掉帧，而且 moveend 时还要补一次 setPosition 才对齐）
 *
 * 逆地理走 REST（amap-api.js 的 regeo()），不用 AMap.Geocoder：
 *   REST 失败时手里还有 lng/lat 可降级，不会出现"选了点但没地址"。
 * ============================================================ */
(function (g) {
  "use strict";

  if (typeof document === "undefined") return;   // Node 里 require 进来时直接跳过

  var STYLE_ID = "jbx-mp-style";
  var MASK_CLASS = "jbx-mp-mask";
  var SDK_TIMEOUT = 12000;      // 地图 SDK 超过这个时间没就绪 → 报加载失败
  var RESOLVE_DEBOUNCE = 350;   // 拖动结束后等 350ms 再解析：个人 Key 只有 3 QPS
  var ZOOM = 16;

  var PIN_SVG =
    '<svg width="32" height="42" viewBox="0 0 34 44" aria-hidden="true">' +
    '<path d="M17 42.5S2.5 26 2.5 16A14.5 14.5 0 1 1 31.5 16C31.5 26 17 42.5 17 42.5z" ' +
    'fill="#e53e3e" stroke="#fff" stroke-width="2.2"/>' +
    '<circle cx="17" cy="15.6" r="5.4" fill="#fff"/></svg>';

  /* ---------------- 配置读取 ----------------
     每次 open 时现读全局：config.local.js 可能晚于本文件加载，缓存住就会拿到空值。 */
  function pickGlobal(names) {
    var host = (typeof window !== "undefined") ? window : g;
    for (var i = 0; i < names.length; i++) {
      var v = host[names[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }
  function jsKey() { return pickGlobal(["__AMAP_JS_KEY__", "JS_API_KEY", "AMAP_JS_KEY"]); }
  function jsCode() { return pickGlobal(["__AMAP_JS_CODE__", "JS_API_SECURITY_CODE", "AMAP_SECURITY_CODE"]); }

  /* ---------------- 样式（只注入一次） ---------------- */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".jbx-mp-mask{position:fixed;inset:0;z-index:9998;background:rgba(17,24,39,.45);",
      "  display:flex;align-items:flex-end;justify-content:center;",
      "  -webkit-tap-highlight-color:transparent;animation:jbx-mp-fade .18s ease-out}",
      "@keyframes jbx-mp-fade{from{opacity:0}to{opacity:1}}",
      "@keyframes jbx-mp-up{from{transform:translateY(14%)}to{transform:translateY(0)}}",
      ".jbx-mp-sheet{width:100%;max-width:640px;background:#fff;border-radius:16px 16px 0 0;",
      "  box-shadow:0 -8px 28px rgba(0,0,0,.18);display:flex;flex-direction:column;",
      "  height:64vh;min-height:330px;max-height:600px;overflow:hidden;",
      "  animation:jbx-mp-up .22s ease-out;padding-bottom:env(safe-area-inset-bottom,0)}",
      ".jbx-mp-head{padding:12px 16px;font-size:13px;color:#4a5568;text-align:center;",
      "  border-bottom:1px solid #edf1f6;background:#fafcfe;font-weight:500}",
      ".jbx-mp-head b{color:#e53e3e}",
      ".jbx-mp-stage{position:relative;flex:1;min-height:200px;background:#eef2f6;overflow:hidden}",
      ".jbx-mp-map{position:absolute;inset:0}",
      "/* 图钉：压在地图容器正中。pointer-events:none 是不挡住拖拽的关键 */",
      ".jbx-mp-pin{position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);",
      "  pointer-events:none;z-index:3;filter:drop-shadow(0 3px 4px rgba(0,0,0,.3))}",
      ".jbx-mp-pin::after{content:'';position:absolute;left:50%;bottom:-3px;width:9px;height:3px;",
      "  border-radius:50%;background:rgba(0,0,0,.25);transform:translateX(-50%)}",
      "/* 加载态：绝对不能白屏 */",
      ".jbx-mp-loading{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;",
      "  align-items:center;justify-content:center;gap:10px;background:#f4f7fa;",
      "  font-size:13px;color:#718096}",
      ".jbx-mp-spin{width:22px;height:22px;border:2.5px solid #cbd8e6;border-top-color:#2b6cb0;",
      "  border-radius:50%;animation:jbx-mp-rot .8s linear infinite}",
      "@keyframes jbx-mp-rot{to{transform:rotate(360deg)}}",
      ".jbx-mp-err{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;",
      "  align-items:center;justify-content:center;gap:8px;padding:24px;background:#f4f7fa;",
      "  text-align:center;font-size:13px;color:#718096;line-height:1.9}",
      ".jbx-mp-err b{color:#2d3748;font-size:14px}",
      ".jbx-mp-err .jbx-mp-manual{margin-top:6px;border:1px solid #cbd8e6;background:#fff;",
      "  color:#2b6cb0;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}",
      ".jbx-mp-foot{padding:10px 14px 14px;border-top:1px solid #edf1f6;background:#fff}",
      ".jbx-mp-addr{display:flex;gap:8px;align-items:flex-start;min-height:40px;margin-bottom:10px}",
      ".jbx-mp-addr-label{flex:none;font-size:11px;color:#2b6cb0;background:#ebf4ff;",
      "  border-radius:4px;padding:2px 6px;margin-top:2px}",
      ".jbx-mp-addr-txt{flex:1;font-size:13px;color:#2d3748;line-height:1.6;",
      "  max-height:44px;overflow:auto;word-break:break-all}",
      ".jbx-mp-addr-txt.pending{color:#a0aec0}",
      ".jbx-mp-addr-txt.warn{color:#b7791f}",
      ".jbx-mp-btns{display:flex;gap:10px}",
      ".jbx-mp-btn{flex:1;border:none;border-radius:10px;padding:11px 0;font-size:14px;",
      "  font-family:inherit;cursor:pointer;transition:opacity .15s}",
      ".jbx-mp-cancel{background:#edf2f7;color:#4a5568}",
      ".jbx-mp-ok{background:#2b6cb0;color:#fff;font-weight:600}",
      ".jbx-mp-ok:disabled{opacity:.55;cursor:not-allowed}",
      "@media (max-width:480px){.jbx-mp-sheet{height:70vh}}"
    ].join("");
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- 地图 SDK 懒加载（全局只加载一次） ---------------- */
  var _sdkPromise = null;

  function loadJSAPI() {
    if (_sdkPromise) return _sdkPromise;             // 关上弹层也不清：下次打开更快
    _sdkPromise = new Promise(function (resolve, reject) {
      var key = jsKey();
      if (!key) { reject(new Error("no-key")); return; }
      if (g.AMap && g.AMap.Map) { resolve(g.AMap); return; }

      // 安全密钥必须在 SDK 之前挂到全局：2021-12 之后申请的 Key 不带它会被高德拒绝
      var code = jsCode();
      if (code) g._AMapSecurityConfig = { securityJsCode: code };

      var s = document.createElement("script");
      s.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(key);
      s.async = true;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true; _sdkPromise = null;
        reject(new Error("timeout"));
      }, SDK_TIMEOUT);

      s.onload = function () {
        if (settled) return;
        clearTimeout(timer);
        if (g.AMap && g.AMap.Map) { settled = true; resolve(g.AMap); }
        else { settled = true; _sdkPromise = null; reject(new Error("no-amap")); }
      };
      s.onerror = function () {
        if (settled) return;
        clearTimeout(timer);
        settled = true; _sdkPromise = null;
        // 脚本没加载成时，高德返回的往往是一段 JSON 错误而不是 JS。
        // 该接口 CORS 是开放的，直接取回来读错误码，把"白名单没配"和"网络不通"分开说，
        // 否则组里没人分得清这两种完全不同的问题。
        if (typeof fetch !== "function") { reject(new Error("script-error")); return; }
        fetch(s.src).then(function (res) { return res.json(); }).then(function (j) {
          var code = String((j && j.infocode) || "");
          if (code === "10006") reject(new Error("domain"));            // INVALID_USER_DOMAIN
          else if (code === "10009") reject(new Error("scode"));        // 安全密钥缺失/不匹配
          else if (code === "10001") reject(new Error("bad-key"));      // Key 无效
          else reject(new Error("script-error"));
        }).catch(function () { reject(new Error("script-error")); });
      };
      document.head.appendChild(s);
    });
    return _sdkPromise;
  }

  /* ---------------- 小工具 ---------------- */
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function coordText(lng, lat) { return lng.toFixed(5) + "," + lat.toFixed(5); }

  /* ---------------- 选点弹层 ---------------- */
  var _cur = null;      // 当前打开的实例，保证同一时刻只有一个

  function Picker(opts) {
    this.opts = opts || {};
    this.map = null;
    this.root = null;
    this.stageEl = null;
    this.mapEl = null;
    this.loadingEl = null;
    this.errEl = null;
    this.addrEl = null;
    this.okBtn = null;
    this.fix = null;          // { name, lng, lat, adcode }
    this.seq = 0;             // 丢弃过期的解析结果
    this.destroyed = false;
    this._prevOverflow = "";
    this._onKey = null;
    this._onResize = null;
  }

  Picker.prototype.build = function () {
    var self = this;
    var root = document.createElement("div");
    root.className = MASK_CLASS;
    root.innerHTML = [
      '<div class="jbx-mp-sheet" role="dialog" aria-modal="true" aria-label="地图选点">',
      '  <div class="jbx-mp-head">拖动地图，让<b>图钉</b>对准你的出发位置</div>',
      '  <div class="jbx-mp-stage">',
      '    <div class="jbx-mp-map"></div>',
      '    <div class="jbx-mp-pin">' + PIN_SVG + '</div>',
      '    <div class="jbx-mp-loading"><span class="jbx-mp-spin"></span><span>地图加载中…</span></div>',
      '    <div class="jbx-mp-err" hidden></div>',
      '  </div>',
      '  <div class="jbx-mp-foot">',
      '    <div class="jbx-mp-addr">',
      '      <span class="jbx-mp-addr-label">位置</span>',
      '      <span class="jbx-mp-addr-txt pending">定位中…</span>',
      '    </div>',
      '    <div class="jbx-mp-btns">',
      '      <button type="button" class="jbx-mp-btn jbx-mp-cancel">取消</button>',
      '      <button type="button" class="jbx-mp-btn jbx-mp-ok" disabled>就用这里</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join("");

    this.root = root;
    this.stageEl = root.querySelector(".jbx-mp-stage");
    this.mapEl = root.querySelector(".jbx-mp-map");
    this.loadingEl = root.querySelector(".jbx-mp-loading");
    this.errEl = root.querySelector(".jbx-mp-err");
    this.addrEl = root.querySelector(".jbx-mp-addr-txt");
    this.okBtn = root.querySelector(".jbx-mp-ok");

    // 点遮罩（而不是面板内部）关闭
    root.addEventListener("click", function (e) {
      if (e.target === root) self.close("cancel");
    });
    root.querySelector(".jbx-mp-cancel").addEventListener("click", function () { self.close("cancel"); });
    this.okBtn.addEventListener("click", function () { self.confirm(); });

    // ESC 关闭（桌面）
    this._onKey = function (e) { if (e.key === "Escape") self.close("cancel"); };
    document.addEventListener("keydown", this._onKey);

    document.body.appendChild(root);
    this._prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";        // 弹层期间别让底页跟着滚
  };

  Picker.prototype.start = function () {
    var self = this;
    var opt = this.opts;
    var start = [];

    // 初始位置：优先用已有选点，其次城市中心
    var ll = opt.lnglat;
    if (ll && isFinite(ll[0]) && isFinite(ll[1])) start = [Number(ll[0]), Number(ll[1])];
    else if (opt.center && isFinite(opt.center[0]) && isFinite(opt.center[1])) start = [Number(opt.center[0]), Number(opt.center[1])];

    if (!start.length) {
      // 连中心点都没有：拿不到位置，直接提示，不要开半张地图
      this.showError("缺少城市中心坐标", "打开参数里没有 center，无法定位到当前城市");
      return;
    }

    loadJSAPI().then(function (AMap) {
      if (self.destroyed) return;
      self.map = new AMap.Map(self.mapEl, {
        zoom: ZOOM,
        center: start,
        resizeEnable: true,
        viewMode: "2D",
        showLabel: true
      });

      var first = false;
      var ready = function () {
        if (first || self.destroyed) return;
        first = true;
        self.hideLoading();
        self.resolve();                 // 一打开就先解析一次中心点
      };

      // complete 事件在部分机型不触发（尤其微信内置），补一个兜底定时器
      if (self.map.on) self.map.on("complete", ready);
      setTimeout(ready, 1200);

      // 只在 moveend 解析：拖动途中解析会被限频（10021）
      self.map.on("moveend", debounce(function () { self.resolve(); }, RESOLVE_DEBOUNCE));

      self._onResize = function () { if (self.map) self.map.resize(); };
      g.addEventListener("resize", self._onResize);
    }).catch(function (err) {
      if (self.destroyed) return;
      var msg = (err && err.message) || "";
      if (msg === "no-key") {
        self.showError("地图未配置 JS API Key",
          "需要 Web端(JS API) 类型的 Key + 安全密钥。临时可以先手动输入出发地。");
      } else if (msg === "domain") {
        // INVALID_USER_DOMAIN：最常见也最难排查的一种，单独说清楚
        self.showError("当前域名不在 Key 的白名单里",
          "去高德控制台 → 这个 JS API Key → 域名白名单，加上当前访问的域名（本地调试加 localhost）。" +
          "其他功能不受影响，可先手动输入出发地。");
      } else if (msg === "scode") {
        self.showError("安全密钥（jscode）缺失或不匹配",
          "2021-12 之后申请的 Key 必须在 config.local.js 里同时填 __AMAP_JS_KEY__ 和 __AMAP_JS_CODE__。");
      } else if (msg === "bad-key") {
        self.showError("JS API Key 无效",
          "检查 __AMAP_JS_KEY__ 是否抄错，或该 Key 已被删除。");
      } else if (msg === "timeout") {
        self.showError("地图加载超时", "网络太慢或 JS API 被拦截，可以手动输入出发地，不影响其他功能。");
      } else {
        self.showError("地图加载失败", "请检查网络后重试，或直接手动输入出发地。");
      }
    });
  };

  /* ---------------- 状态：加载中 / 出错 / 地址 ---------------- */
  Picker.prototype.hideLoading = function () {
    if (this.loadingEl) this.loadingEl.style.display = "none";
  };

  Picker.prototype.showError = function (title, hint) {
    if (!this.errEl) return;
    var self = this;
    this.hideLoading();
    this.errEl.hidden = false;
    this.errEl.innerHTML = '<b>' + title + '</b><span>' + hint + '</span>' +
      '<button type="button" class="jbx-mp-manual">改用手动输入</button>';
    var btn = this.errEl.querySelector(".jbx-mp-manual");
    if (btn) btn.addEventListener("click", function () { self.close("manual"); });
    this.setAddr("地图不可用，请手动输入", "warn");
    this.okBtn.disabled = true;       // 没有地图就没有中心点，不能确认
  };

  Picker.prototype.setAddr = function (text, cls) {
    if (!this.addrEl) return;
    this.addrEl.textContent = text;
    this.addrEl.className = "jbx-mp-addr-txt" + (cls ? " " + cls : "");
  };

  /* 拖动结束 → 取容器中心 → 逆地理 → 更新地址行 */
  Picker.prototype.resolve = function () {
    var self = this;
    if (this.destroyed || !this.map) return;

    var c = this.map.getCenter();
    if (!c) return;
    var lng = Number(c.getLng()), lat = Number(c.getLat());
    if (!isFinite(lng) || !isFinite(lat)) return;

    this.seq++;
    var seq = this.seq;
    this.setAddr("解析中…", "pending");

    var done = function (r) {
      if (self.destroyed || seq !== self.seq) return;   // 结果过期，丢掉
      var ok = !!(r && r.ok && r.name);
      self.fix = { name: ok ? r.name : "", lng: lng, lat: lat, adcode: (r && r.adcode) || "" };
      if (ok) self.setAddr(r.name);
      else {
        // 解析失败也要能确认：名字退化成坐标，_geoResolve 认识 "经度,纬度"
        self.setAddr("未解析出地址，将使用坐标 " + coordText(lng, lat), "warn");
      }
      self.okBtn.disabled = false;
    };

    var fn = (typeof g.regeo === "function") ? g.regeo
           : (typeof regeo === "function" ? regeo : null);   // 全局函数形式
    if (!fn) { done({ ok: false }); return; }
    try {
      Promise.resolve(fn(lng, lat)).then(done, function () { done({ ok: false }); });
    } catch (e) {
      done({ ok: false });
    }
  };

  /* ---------------- 确认 / 关闭 ---------------- */
  Picker.prototype.confirm = function () {
    if (!this.map) return;
    var c = this.map.getCenter();
    var lng = Number(c.getLng()), lat = Number(c.getLat());
    var fix = this.fix;

    // 地址和当前中心对不上（用户刚拖完就点了确认）→ 用坐标兜底，绝不返回错误地址
    var same = fix && Math.abs(fix.lng - lng) < 1e-4 && Math.abs(fix.lat - lat) < 1e-4;
    var r = {
      name: (same && fix.name) ? fix.name : coordText(lng, lat),
      lng: lng, lat: lat,
      adcode: (same && fix.adcode) || ""
    };
    this.close("pick");
    if (typeof this.opts.onPick === "function") {
      try { this.opts.onPick(r); } catch (e) { console.error("[map-picker] onPick 抛错：", e); }
    }
  };

  Picker.prototype.close = function (why) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.seq++;

    if (this._onResize) { g.removeEventListener("resize", this._onResize); this._onResize = null; }
    if (this._onKey) { document.removeEventListener("keydown", this._onKey); this._onKey = null; }

    // 真的销毁实例：不 destroy 的话每次开都留一个地图对象，5 次就能看出内存涨
    if (this.map) {
      try { this.map.clearMap && this.map.clearMap(); } catch (e) { /* 忽略 */ }
      try { this.map.destroy(); } catch (e) { /* 个别版本 destroy 会抛，吞掉不影响 */ }
      this.map = null;
    }
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;

    document.body.style.overflow = this._prevOverflow || "";
    if (_cur === this) _cur = null;
    if (why === "cancel" && typeof this.opts.onCancel === "function") {
      try { this.opts.onCancel(); } catch (e) { /* 忽略 */ }
    }
  };

  /* ---------------- 对外接口 ---------------- */
  var JBXMapPicker = {
    open: function (opts) {
      if (typeof document === "undefined") return null;
      if (_cur) _cur.close("replace");              // 已经开着就先关掉，保证单实例
      injectStyle();
      var p = new Picker(opts);
      p.build();
      _cur = p;
      p.start();
      return p;
    },
    close: function () { if (_cur) _cur.close("api"); },
    isOpen: function () { return !!_cur; },
    destroyAll: function () { if (_cur) _cur.close("api"); }
  };

  g.JBXMapPicker = JBXMapPicker;
  if (typeof module !== "undefined" && module.exports) module.exports = JBXMapPicker;

})(typeof globalThis !== "undefined" ? globalThis : window);
