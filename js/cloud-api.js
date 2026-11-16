/* ============================================================
 * cloud-api.js — 房间制的云端读写（张海燕维护，新增 11-13）
 *                              11-16 迁移到 Supabase
 * 迁移原因：云服务端强制精确 Origin 匹配，GitHub Pages 来源被拒（403），
 *           平台无自定义域名白名单入口；Supabase CORS 开放、免费、免备案。
 *
 * 设计要点：
 *   1. 不登录。身份靠两样东西：
 *        · 设备令牌（deviceToken，存本机 localStorage）—— 区分"我"是哪个成员
 *        · 房间邀请码（6 位）—— 区分"这个房间"
 *      RLS 对 anon 开放读写，安全性由"房间码不公开猜不到 + 7 天过期"兜底。
 *      这是课程原型的设计取舍，不是生产级权限方案（答辩如实说）。
 *   2. 一个房间只算一次：发起人算完把结果写进 rooms.plan，其余人只读。
 *      Supabase 免费额度远高于个人 Key 限频，6 台设备共用无压力。
 *   3. 所有函数返回 Promise，失败抛 Error（已翻译成中文），调用方只管 try/catch。
 *   4. SDK 与配置都不写死在这里：配置在 cloud-config.js，SDK 首次用时从 CDN 懒加载。
 *
 * 依赖：js/cloud-config.js 必须先加载。
 *       表结构见仓库根目录 supabase-schema.sql
 * ============================================================ */
(function (g) {
  var CFG = g.JBX_CLOUD;
  var TG = g;

  var TOKEN_KEY = "jbx_device_token";
  var OWNER_KEY_PREFIX = "jbx_owner_";   // jbx_owner_<code> = 1，表示这台设备建的这个房间

  var _client = null;
  var _sdk = null;

  /* ---------------- 初始化 ---------------- */

  function loadSdk() {
    if (TG.supabase && TG.supabase.createClient) return Promise.resolve();
    if (_sdk) return _sdk;
    _sdk = new Promise(function (resolve, reject) {
      var s = TG.document.createElement("script");
      s.src = CFG.sdkUrl;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        _sdk = null;
        reject(new Error("云服务组件没加载成功，请检查网络后刷新页面"));
      };
      TG.document.head.appendChild(s);
    });
    return _sdk;
  }

  function configReady() {
    return CFG && CFG.supabaseUrl && CFG.supabaseAnonKey &&
      !/REPLACE|填入|YOUR_/i.test(CFG.supabaseUrl) && !/REPLACE|填入|YOUR_/i.test(CFG.supabaseAnonKey);
  }

  function db() {
    if (_client) return Promise.resolve(_client);
    if (!configReady()) {
      return Promise.reject(new Error("云数据库还没配置好：请在 js/cloud-config.js 填入 Supabase 的 URL 和 Anon Key（见组长的 Supabase 操作单）"));
    }
    return loadSdk().then(function () {
      _client = TG.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
        auth: { persistSession: false }   // 不登录，无需会话持久化
      });
      return _client;
    });
  }

  /* ---------------- 错误翻译 ---------------- */

  var CODE_MSG = {
    "23505": "这个邀请码已经被占用了，正在换一个",
    "23503": "房间已失效，请重新创建",
    "42P01": "云数据库还没初始化，请联系组长执行 supabase-schema.sql",
    "42501": "没有权限操作这个房间"
  };

  function wrap(err) {
    if (!err) return new Error("未知的云服务错误");
    var code = err.code || "";
    var text = CODE_MSG[code];
    if (!text) {
      var raw = String(err.message || "");
      if (/Failed to fetch|NetworkError|Load failed|ERR_NETWORK|fetch/i.test(raw)) {
        text = "连不上云服务，请检查网络后重试";
      } else if (/Invalid API key|JWT|apikey/i.test(raw)) {
        text = "云服务配置有误，请联系组长检查 cloud-config.js";
      } else if (/schema cache|relation .* does not exist/i.test(raw)) {
        text = "云数据库还没初始化，请联系组长执行 supabase-schema.sql";
      } else {
        text = raw || "云服务异常，请稍后重试";
      }
    }
    var e = new Error(text);
    e.code = code;
    e.raw = err;
    return e;
  }

  function unwrap(res) {
    if (res && res.error) throw wrap(res.error);
    return res ? res.data : null;
  }

  /* ---------------- 本机身份 ---------------- */

  function deviceToken() {
    var t = null;
    try { t = TG.localStorage.getItem(TOKEN_KEY); } catch (e) { /* 隐私模式 */ }
    if (!t) {
      t = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { TG.localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* 忽略 */ }
    }
    return t;
  }

  function markOwner(code) {
    try { TG.localStorage.setItem(OWNER_KEY_PREFIX + code, "1"); } catch (e) { /* 忽略 */ }
  }
  function isOwner(code) {
    try { return TG.localStorage.getItem(OWNER_KEY_PREFIX + code) === "1"; } catch (e) { return false; }
  }

  /* ---------------- 邀请码 ---------------- */

  /* 去掉 0 O 1 I L 这类看着容易说错的字符，剩 31 个，6 位约 8.8 亿种组合 */
  var ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

  function randomCode() {
    var s = "";
    for (var i = 0; i < 6; i++) {
      s += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return s;
  }

  /* ---------------- 房间 ---------------- */

  /**
   * 创建房间
   * @param {Object} opts { cityCode, cityName, dest, meetStart, meetEnd }
   * @returns {Promise<{code:string, token:string, room:Object}>}
   */
  function createRoom(opts) {
    var token = deviceToken();
    var attempt = 0;

    function tryOnce() {
      var code = randomCode();
      return db().then(function (d) {
        return d.from("rooms").insert({
          code: code,
          city_code: String(opts.cityCode),
          city_name: opts.cityName,
          dest: opts.dest,
          meet_start: opts.meetStart || null,
          meet_end: opts.meetEnd || null,
          owner_token: token,
          status: "open"
        }).select();
      }).then(function (res) {
        if (res.error && (res.error.code === "23505" || /duplicate/i.test(res.error.message || ""))) {
          attempt++;
          if (attempt >= 5) throw new Error("邀请码连续冲突，请稍后重试");
          return tryOnce();          // 撞码：换一个重试
        }
        var rows = unwrap(res) || [];
        if (!rows.length) throw new Error("房间创建失败，请重试");
        markOwner(code);
        logEvent(code, "create", token, opts.cityName + " · " + opts.dest).catch(function () {});
        return { code: code, token: token, room: rows[0] };
      });
    }
    return tryOnce();
  }

  /**
   * 读房间（含成员与最近事件）
   * @returns {Promise<{room:Object, members:Array, events:Array, expired:boolean, isOwner:boolean}>}
   */
  function getRoom(code) {
    var c = String(code || "").trim().toUpperCase();
    if (!c) return Promise.reject(new Error("请先填邀请码"));

    return db().then(function (d) {
      return Promise.all([
        d.from("rooms").select("*").eq("code", c).maybeSingle(),
        d.from("room_members")
          .select("id, member_token, name, origin, origin_lng, origin_lat, mode, budget, win_start, win_end, joined_at, removed_at")
          .eq("room_code", c)
          .order("joined_at", { ascending: true })
      ]);
    }).then(function (out) {
      var room = unwrap(out[0]);
      var all = unwrap(out[1]) || [];
      if (!room) throw new Error("没找到这个邀请码对应的房间，请确认 6 位码是否输错");

      var expired = room.expire_at ? new Date(room.expire_at).getTime() < Date.now() : false;
      var members = all.filter(function (m) { return !m.removed_at; });
      return {
        room: room,
        members: members,
        events: [],
        expired: expired,
        isOwner: isOwner(c)
      };
    });
  }

  /**
   * 加入房间 / 更新自己的信息（同一台设备重复提交就是更新，不会变成两个人）
   * @param {string} code
   * @param {Object} me { name, origin, mode, budget, winStart, winEnd }
   * @param {string} [tokenOverride] 发起人代填时传一个临时令牌，避免覆盖发起人自己那一行
   */
  function joinRoom(code, me, tokenOverride) {
    var c = String(code).trim().toUpperCase();
    var token = tokenOverride || deviceToken();
    var row = {
      room_code: c,
      member_token: token,
      name: me.name,
      origin: me.origin,
      origin_lng: (me.originCoord && isFinite(me.originCoord.lng)) ? me.originCoord.lng : null,
      origin_lat: (me.originCoord && isFinite(me.originCoord.lat)) ? me.originCoord.lat : null,
      mode: me.mode || "transit",
      budget: Number(me.budget) || 0,
      win_start: me.winStart || null,
      win_end: me.winEnd || null,
      updated_at: new Date().toISOString()
    };

    return db().then(function (d) {
      return d.from("room_members").select("id").eq("room_code", c).eq("member_token", token);
    }).then(function (res) {
      var exist = unwrap(res) || [];
      return db().then(function (d) {
        if (exist.length) {
          return d.from("room_members").update(row).eq("id", exist[0].id).select();
        }
        return d.from("room_members").insert(row).select();
      });
    }).then(function (res) {
      var rows = unwrap(res) || [];
      if (!rows.length) throw new Error("提交失败，可能房间已过期");
      logEvent(c, "join", token, me.name).catch(function () {});
      return rows[0];
    });
  }

  /** 发起人移除成员（软删：只打时间戳，不真删行） */
  function removeMember(code, memberId) {
    var c = String(code).trim().toUpperCase();
    return db().then(function (d) {
      return d.from("room_members")
        .update({ removed_at: new Date().toISOString() })
        .eq("id", memberId)
        .eq("room_code", c)
        .select();
    }).then(function (res) {
      var rows = unwrap(res) || [];
      if (!rows.length) throw new Error("移除失败：这一行不存在或已被移除");
      return rows[0];
    });
  }

  /** 改房间公共信息（只有发起人界面会显示入口；服务端不做强校验） */
  function updateRoom(code, patch) {
    var c = String(code).trim().toUpperCase();
    return db().then(function (d) {
      return d.from("rooms").update(patch).eq("code", c).select();
    }).then(function (res) {
      var rows = unwrap(res) || [];
      if (!rows.length) throw new Error("保存失败，房间可能已过期");
      return rows[0];
    });
  }

  /**
   * 写方案快照（发起人算完后调用一次）
   * 用 status 做乐观锁：只有 open 状态才能抢占，避免两人同时点生成各算一遍
   */
  function savePlan(code, plan) {
    var c = String(code).trim().toUpperCase();
    return db().then(function (d) {
      return d.from("rooms")
        .update({ status: "ready", plan: plan, plan_at: new Date().toISOString() })
        .eq("code", c)
        .eq("status", "open")
        .select();
    }).then(function (res) {
      var rows = unwrap(res) || [];
      if (!rows.length) {
        // 没抢到：要么别人已经算完，要么房间过期了
        return getRoom(c).then(function (r) {
          if (r.room && r.room.plan) return { code: c, reused: true, room: r.room };
          throw new Error("生成失败：房间状态已变，请刷新后重试");
        });
      }
      logEvent(c, "generate", deviceToken(), "三方案已生成").catch(function () {});
      return { code: c, reused: false, room: rows[0] };
    });
  }

  /** 把状态改回 open（发起人要重新算时用） */
  function reopenPlan(code) {
    var c = String(code).trim().toUpperCase();
    return db().then(function (d) {
      return d.from("rooms").update({ status: "open", plan: null, plan_at: null }).eq("code", c).select();
    }).then(function (res) { return unwrap(res); });
  }

  /* ---------------- 事件流水 ---------------- */

  function logEvent(code, kind, actor, detail) {
    return db().then(function (d) {
      return d.from("room_events").insert({
        room_code: code, kind: kind, actor: actor || null, detail: detail || null
      });
    }).then(function (res) { return unwrap(res); });
  }

  function getEvents(code, limit) {
    return db().then(function (d) {
      return d.from("room_events")
        .select("kind, actor, detail, created_at")
        .eq("room_code", String(code).trim().toUpperCase())
        .order("created_at", { ascending: false })
        .limit(limit || 20);
    }).then(function (res) { return unwrap(res) || []; });
  }

  /* ---------------- 导出 ---------------- */

  var API = {
    deviceToken: deviceToken,
    isOwner: isOwner,
    randomCode: randomCode,
    createRoom: createRoom,
    getRoom: getRoom,
    joinRoom: joinRoom,
    removeMember: removeMember,
    updateRoom: updateRoom,
    savePlan: savePlan,
    reopenPlan: reopenPlan,
    getEvents: getEvents,
    logEvent: logEvent
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  TG.JBXCloud = API;
})(typeof globalThis !== "undefined" ? globalThis : window);
