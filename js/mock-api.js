/* ============================================================
 * mock-api.js — 假数据路线查询（雷馨怡的 amap-api.js 联调通过后整个删掉即可）
 *
 * 特点：同样的出发地/目的地/方式，永远返回同样的数字（用字符串哈希做种子），
 *       方便测试用例复现（闫雅欣写测试时依赖这一点）。
 * ============================================================ */

function _hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _mockRoute(origin, dest, mode) {
  var seed = _hashStr(origin + "→" + dest);
  var km = 2 + (seed % 180) / 10;          // 2.0 ~ 20.0 公里
  var min, cost;
  if (mode === "taxi") {
    min = km / 35 * 60 + 5;                // 35km/h + 起步等待
    cost = Math.round(12 + 2.3 * km);      // 起步 12 元 + 2.3 元/km
  } else if (mode === "transit") {
    min = km / 25 * 60 + 12;               // 25km/h + 候车步行
    cost = 2 + Math.floor(km / 4);         // 2 元起步，每 4km 加 1 元
  } else {                                 // bike
    min = km / 12 * 60;
    cost = 0;
  }
  return {
    durationMin: Math.round(min * 10) / 10,
    distanceKm: Math.round(km * 10) / 10,
    cost: cost
  };
}

/* 接口签名与 amap-api.js 完全一致 —— 这就是全组交接的锚点 */
function queryRoute(origin, dest, mode) {
  return new Promise(function (resolve) {
    setTimeout(function () {               // 模拟网络延迟 200ms
      resolve(_mockRoute(origin, dest, mode));
    }, 200);
  });
}
