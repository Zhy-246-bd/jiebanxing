/* ============================================================
 * cities.js — 城市配置表（组长张海燕维护）
 *
 * 作用：把"锁定单城"变成"可选城市"。
 * 切换城市时，本文件会同时替换四样东西：
 *   ① 地名解析限定城市（AMAP_CITY）
 *   ② 公交换乘的城市代码（AMAP_CITY_ADCODE）
 *   ③ 解析结果的合理性校验中心点（AMAP_CITY_CENTER）
 *   ④ 候选集合点名单（MEETING_CANDIDATES，必须是本市真实站名）
 *
 * 【加一个城市】在 CITIES 里加一条即可，字段含义：
 *   key          内部标识，存 localStorage 用，英文
 *   name        城市名，传给高德 geocode / inputtips 的 city 参数
 *   adcode      城市代码（6 位），公交查询 city1/city2 必须用它
 *   center      市中心 "经度,纬度"，用于判断地名是否被解析到外省（超 60km 判错）
 *   stations    候选集合点 4 个，分布在城市不同方向，方案二/三从里面挑
 *   destExample 目的地输入框的示例文字
 *   members     示例成员（3 人），让老师打开就能看到效果
 *
 * adcode 查法：https://restapi.amap.com/v3/config/district?keywords=城市名&key=KEY
 * ============================================================ */

var CITIES = [
  {
    key: "wuhan", name: "武汉", adcode: "420100", center: "114.3055,30.5928",
    stations: ["洪山广场", "中山公园", "循礼门", "武昌火车站"],
    destExample: "楚河汉街 / 江汉路",
    members: [
      { name: "张海燕", origin: "武汉站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "汉口火车站", mode: "taxi", budget: 40, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "光谷广场", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  },
  {
    key: "beijing", name: "北京", adcode: "110000", center: "116.4074,39.9042",
    stations: ["西直门", "东直门", "国贸", "北京南站"],
    destExample: "天安门广场 / 三里屯",
    members: [
      { name: "张海燕", origin: "北京南站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "国贸", mode: "taxi", budget: 60, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "西二旗", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  },
  {
    key: "shanghai", name: "上海", adcode: "310000", center: "121.4737,31.2304",
    stations: ["人民广场", "徐家汇", "世纪大道", "中山公园"],
    destExample: "外滩 / 南京东路",
    members: [
      { name: "张海燕", origin: "上海虹桥站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "徐家汇", mode: "taxi", budget: 60, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "陆家嘴", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  },
  {
    key: "guangzhou", name: "广州", adcode: "440100", center: "113.2644,23.1291",
    stations: ["体育西路", "公园前", "广州东站", "客村"],
    destExample: "珠江新城 / 北京路",
    members: [
      { name: "张海燕", origin: "广州南站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "天河体育中心", mode: "taxi", budget: 60, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "客村", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  },
  {
    key: "shenzhen", name: "深圳", adcode: "440300", center: "114.0579,22.5431",
    stations: ["福田", "老街", "车公庙", "深圳北站"],
    destExample: "市民中心 / 海上世界",
    members: [
      { name: "张海燕", origin: "深圳北站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "世界之窗", mode: "taxi", budget: 60, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "车公庙", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  },
  {
    key: "chengdu", name: "成都", adcode: "510100", center: "104.0657,30.6595",
    stations: ["天府广场", "春熙路", "成都东站", "犀浦"],
    destExample: "宽窄巷子 / 太古里",
    members: [
      { name: "张海燕", origin: "成都东站", mode: "transit", budget: 20, window: ["08:00", "09:30"] },
      { name: "雷馨怡", origin: "春熙路", mode: "taxi", budget: 60, window: ["08:00", "09:30"] },
      { name: "夏国静", origin: "犀浦", mode: "transit", budget: 15, window: ["08:30", "10:00"] }
    ]
  }
];

var CITY_STORE_KEY = "jbx_city";
var _city = CITIES[0];

function getCityList() { return CITIES; }

function getCity(key) {
  for (var i = 0; i < CITIES.length; i++) {
    if (CITIES[i].key === key) return CITIES[i];
  }
  return null;
}

function currentCity() { return _city; }
function currentCityKey() { return _city.key; }

/* 切换城市：同步刷新接口层配置 + 候选集合点 + 清空地名缓存
   （必须清缓存：武汉的"中山公园"和上海的不是同一个地方，同名会串） */
function applyCity(key) {
  var c = getCity(key) || CITIES[0];
  _city = c;

  if (typeof AMAP_CITY !== "undefined") {
    AMAP_CITY = c.name;
    AMAP_CITY_ADCODE = c.adcode;
    AMAP_CITY_CENTER = c.center;
  }
  if (typeof MEETING_CANDIDATES !== "undefined") {
    MEETING_CANDIDATES = c.stations.slice();
  }
  if (typeof _geoCache !== "undefined") { _geoCache = {}; }
  if (typeof _routeCache !== "undefined") { _routeCache = {}; }

  try { localStorage.setItem(CITY_STORE_KEY, c.key); } catch (e) { /* 无 localStorage 环境忽略 */ }
  return c;
}

/* 启动时按上次选择恢复 */
(function () {
  var saved = null;
  try { saved = localStorage.getItem(CITY_STORE_KEY); } catch (e) { /* Node 环境 */ }
  applyCity(saved || CITIES[0].key);
})();
