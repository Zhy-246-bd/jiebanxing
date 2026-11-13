/* ============================================================
 * app.js — 录入页逻辑（胶水层，组长/陈滢竹维护）
 * 依赖：formats.js, amap-api.js, cities.js, engine.js
 * ============================================================ */

var DEST_KEY = "jbx_dest";
var MEM_KEY = "jbx_members";

/* 示例成员来自 cities.js 里的当前城市配置（武汉/北京/上海…），切换城市换一套 */
function demoMembers(cityKey) {
  var c = getCity(cityKey) || currentCity();
  return c.members.map(function (m) {
    return {
      name: m.name, origin: m.origin, mode: m.mode, budget: m.budget,
      window: (m.window || ["08:00", "09:30"]).slice()
    };
  });
}
function withIds(list) {
  list.forEach(function (m, i) { m.id = i + 1; });
  return list;
}
/* 判断当前成员是否还是某城市的示例数据（没被人改过） */
function isDemoOf(list, cityKey) {
  var demo = demoMembers(cityKey);
  if (!list || list.length !== demo.length) return false;
  return list.every(function (m, i) {
    return m.name === demo[i].name && m.origin === demo[i].origin &&
      m.mode === demo[i].mode && (+m.budget || 0) === (+demo[i].budget || 0);
  });
}

function loadMembers() {
  try {
    var saved = JSON.parse(localStorage.getItem(MEM_KEY));
    if (saved && saved.length) return saved;
  } catch (e) { /* 数据坏了就当没有 */ }
  return withIds(demoMembers(currentCityKey()));
}
function saveMembers(list) { localStorage.setItem(MEM_KEY, JSON.stringify(list)); }

var members = loadMembers();
var nextId = members.reduce(function (m, x) { return Math.max(m, x.id || 0); }, 0) + 1;

function render() {
  var box = document.getElementById("memberList");
  box.innerHTML = "";
  members.forEach(function (m) {
    var div = document.createElement("div");
    div.className = "card member-card";
    div.innerHTML =
      '<div class="member-head"><b>' + m.name + '</b>' +
      '<button class="remove-btn" data-id="' + m.id + '">删除</button></div>' +
      '<div class="field"><label>出发地点</label><input class="f-origin" value="' + m.origin + '"></div>' +
      '<div class="row2">' +
      '<div class="field"><label>出行偏好</label><select class="f-mode">' +
      '<option value="transit"' + (m.mode === "transit" ? " selected" : "") + '>地铁/公交</option>' +
      '<option value="taxi"' + (m.mode === "taxi" ? " selected" : "") + '>打车</option>' +
      '<option value="bike"' + (m.mode === "bike" ? " selected" : "") + '>骑行</option>' +
      '</select></div>' +
      '<div class="field"><label>预算上限(元, 0=不限)</label><input class="f-budget" type="number" min="0" value="' + m.budget + '"></div>' +
      '</div>' +
      '<div class="field"><label>姓名</label><input class="f-name" value="' + m.name + '"></div>';
    box.appendChild(div);
  });
  saveMembers(members);
}

/* 输入变化 → 写回内存（事件委托） */
document.addEventListener("input", function (e) {
  var card = e.target.closest(".member-card");
  if (!card) return;
  var btn = card.querySelector(".remove-btn");
  var m = members.filter(function (x) { return x.id === +btn.dataset.id; })[0];
  if (!m) return;
  if (e.target.classList.contains("f-origin")) m.origin = e.target.value;
  if (e.target.classList.contains("f-mode")) m.mode = e.target.value;
  if (e.target.classList.contains("f-budget")) m.budget = +e.target.value || 0;
  if (e.target.classList.contains("f-name")) m.name = e.target.value;
  saveMembers(members);
  var head = card.querySelector(".member-head b");
  if (head) head.textContent = m.name;
});

document.addEventListener("click", function (e) {
  if (e.target.classList.contains("remove-btn") && members.length > 1) {
    members = members.filter(function (x) { return x.id !== +e.target.dataset.id; });
    render();
  }
});

document.getElementById("addMember").addEventListener("click", function () {
  if (members.length >= 8) { alert("最多支持 8 人（项目范围约定）"); return; }
  members.push({ id: nextId++, name: "成员" + nextId, origin: "", mode: "transit", budget: 0, window: ["08:00", "09:30"] });
  render();
});

document.getElementById("generate").addEventListener("click", function () {
  var dest = document.getElementById("dest").value.trim();
  if (!dest) { alert("请先填写目的地"); return; }
  var invalid = members.filter(function (m) { return !m.name.trim() || !m.origin.trim(); });
  if (invalid.length) { alert("有成员的姓名或出发地点没填，请检查红色对应卡片"); return; }

  localStorage.setItem(DEST_KEY, dest);
  saveMembers(members);
  var btn = this;
  btn.disabled = true;
  btn.textContent = "正在计算方案…";
  generateSchemes(members, dest).then(function (result) {
    localStorage.setItem("jbx_result", JSON.stringify({
      dest: dest, city: currentCity().name, members: members, result: result
    }));
    location.href = "result.html";
  }).catch(function (err) {
    alert("计算出错：" + err.message);
    btn.disabled = false;
    btn.textContent = "生成三套方案";
  });
});

/* ---------------- 城市选择 ---------------- */
function updateCityUI() {
  var c = currentCity();
  document.getElementById("cityHint").textContent =
    "当前城市：" + c.name + " · 地名解析、公交换乘、候选集合点（" +
    c.stations.join(" / ") + "）都按该城市计算";
  document.getElementById("dest").placeholder =
    "填写目的地" + (c.destExample ? "，如：" + c.destExample : "");
}

var citySelect = document.getElementById("citySelect");
var customBox = document.getElementById("customCityBox");
var customInput = document.getElementById("customCityName");
var customGo = document.getElementById("customCityGo");
var customMsg = document.getElementById("customCityMsg");

function setCustomMsg(text, type) {
  customMsg.textContent = text || "";
  customMsg.className = "hint" + (type ? " hint-" + type : "");
}

/* 下拉列表：预置 6 城 + 已添加过的自定义城市 + "其他城市"入口 */
function renderCityOptions(selectedKey) {
  citySelect.innerHTML = "";
  getCityList().forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = c.custom ? c.name + "（自定义）" : c.name;
    citySelect.appendChild(opt);
  });
  var other = document.createElement("option");
  other.value = "__custom__";
  other.textContent = "＋ 其他城市（手动输入）";
  citySelect.appendChild(other);
  citySelect.value = selectedKey || currentCityKey();
}

/* 真正切城市：同步三件套 + 候选集合点 + 清缓存，再决定要不要刷新示例成员 */
function switchToCity(key) {
  var prevKey = currentCityKey();
  applyCity(key);
  customBox.style.display = "none";
  updateCityUI();

  if (isDemoOf(members, prevKey)) {
    // 成员还是上一城市的示例 → 换成新城市的示例，点开就能演示
    members = withIds(demoMembers(currentCityKey()));
    nextId = members.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
    document.getElementById("dest").value = "";
    localStorage.removeItem(DEST_KEY);
    render();
  } else {
    // 成员已被修改过 → 不覆盖成员，但目的地必须清：
    // "江汉路"这种地名只在本市有意义，留着能直接生成另一城市的无意义方案（Q-04）
    var destEl = document.getElementById("dest");
    var destCleared = !!destEl.value.trim();
    if (destCleared) {
      destEl.value = "";
      localStorage.removeItem(DEST_KEY);
    }
    document.getElementById("cityHint").textContent =
      "已切换为" + currentCity().name + "，地名解析范围已变，请检查每位成员的出发地是否属于该城市" +
      (destCleared ? "；原目的地属于上一城市，已清空，请重新填写" : "");
  }
}

renderCityOptions();
updateCityUI();

citySelect.addEventListener("change", function () {
  if (this.value === "__custom__") {
    this.value = currentCityKey();     // 只是打开输入框，当前城市先不变
    customBox.style.display = "block";
    setCustomMsg("", "");
    customInput.focus();
    return;
  }
  switchToCity(this.value);
});

/* 在线添加任意城市：城市名 → adcode + 中心点 + 候选地铁站 */
var cityBusy = false;
customGo.addEventListener("click", function () {
  if (cityBusy) return;
  var name = customInput.value.trim();
  if (!name) { setCustomMsg("请先填城市名", "err"); customInput.focus(); return; }

  cityBusy = true;
  customGo.disabled = true;
  customGo.textContent = "正在查询…";
  setCustomMsg("正在查「" + name + "」的行政区代码和地铁站，大约 2 秒…", "");

  prepareOnlineCity(name).then(function (city) {
    var c = addCustomCity(city);
    renderCityOptions(c.key);
    switchToCity(c.key);                 // 内部会隐藏输入框、刷新示例成员
    customInput.value = "";
    setCustomMsg("已切换到 " + c.name + "，候选集合点：" + c.stations.join(" / "), "ok");
  }).catch(function (e) {
    setCustomMsg(e.message || "添加失败，换个城市名试试", "err");
  }).then(function () {
    cityBusy = false;
    customGo.disabled = false;
    customGo.textContent = "添加并切换";
  });
});

/* 回车等于点按钮 */
customInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") customGo.click();
});

render();
document.getElementById("dest").value = localStorage.getItem(DEST_KEY) || "";
