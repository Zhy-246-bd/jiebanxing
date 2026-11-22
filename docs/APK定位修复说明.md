# APK 内「自动定位」不可用 —— 修复说明

> 给雷馨怡：项目结构已确认是 **5+App 直接加载网址**（11/22，不是 uni-app）。
> 网页端已配合改好，你只需要给壳的 index.html 加一段拦截代码 + 重新云打包。
> 直接看 **A2**（含完整代码，复制即可）。

## 一、现象

在 APK 里点出发地旁的「🎯 定位」，**不弹系统授权框**，直接提示
「App 内置浏览器不支持网页定位：请点📍地图选点」。

浏览器里（手机自带浏览器 / 微信打开线上网址）一切正常。

## 二、根因（一句话）

APK 是 WebView 壳。网页的定位要弹授权框，必须由 **APK 的安卓代码**接一个回调
（`onGeolocationPermissionsShowPrompt`）并声明定位权限。大部分一键打包工具
默认没接，网页端无法自己解决。

## 三、按打包方式选修法

### A. HBuilderX 打包 ★实锤走 A2（11/22：目录里只有 index.html + manifest.json，
### 且壳用 plus.webview.create(APP_URL) 加载远程网址，没有 pages.json/App.vue）

**先分清你建的是哪种项目**（HBuilderX 里看项目目录）：
- 目录里有 **`pages.json`** → 是 **uni-app** 项目 → 走 **A1**
- 只有 `manifest.json`、没有 `pages.json` → 是 **5+App / Wap2App** 项目 → 走 **A2**

#### A1. uni-app 项目（web-view 加载网址）—— 网页已支持，需加约 15 行代码

这种结构里 `plus` **不会**注入到网页里（11/21 新打的包验证过），所以网页已改为
用官方通信桥（`js/uni-webview.js`，已随页面自动加载）：网页发消息给 App 侧，
**App 侧代定位后把坐标送回网页**。

在加载网页的那个页面的 `.vue` 文件里（比如 `pages/index/index.vue`）改成：

```vue
<template>
  <view style="flex:1">
    <web-view src="https://zhy-246-bd.github.io/jiebanxing/" @message="onWebMsg"></web-view>
  </view>
</template>

<script>
export default {
  methods: {
    onWebMsg(e) {
      const d = e.detail.data && e.detail.data[e.detail.data.length - 1];
      if (!d || d.type !== 'jbx_getLocation') return;   // 只处理定位请求
      uni.getLocation({
        success: (res) => {
          // #ifdef APP-PLUS
          const wv = this.$scope.$getAppWebview().children()[0];
          wv.evalJS('window.__jbxFromAppLocation(' + res.longitude + ',' + res.latitude + ')');
          // #endif
        },
        fail: () => {
          // #ifdef APP-PLUS
          const wv = this.$scope.$getAppWebview().children()[0];
          wv.evalJS('window.__jbxFromAppLocation(null)');
          // #endif
        }
      });
    }
  }
}
</script>
```

同时 `manifest.json` 依然要：勾 **Geolocation（定位）** 模块 + 两个定位权限
（`ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`）——`uni.getLocation`
底层靠它。然后重新云打包。

网页端会自动把 App 返回的 wgs84 坐标转成高德 gcj02，不用管坐标系。
网页侧收到结果或 12 秒无响应都有对应提示。

#### A2. 5+App 项目（★实锤就是这条，11/22）

**为什么之前重打包也不行**：5+App 里网页是**远程 WebView**，出于安全
`plus` 对象**默认不注入远程页面**——所以网页里检测不到 plus，勾了模块也没用；
而远程 WebView 里浏览器标准的 `navigator.geolocation` 又因为运行时授权弹窗
从未触发（Android 6+ 必须用户当场点"允许"）而失败。两头堵死了。

**正解：壳代定位**。壳的 index.html 自己是有 plus 的，它来干活：

1. 网页点「定位」→ 跳自定义协议 `jbxaction://locate`（网页端已加好，2026-11-22 版）
2. 壳用 `overrideUrlLoading` 拦截这个协议 → 壳调 `plus.geolocation`（能触发系统授权弹窗）
3. 壳 `evalJS` 把坐标送回网页 → 网页自动填入出发地并转成高德坐标系

**⚠️ 先修缓存（11/22 深入排查发现）**：APK 的 WebView 会长期缓存旧页面
（截图角标显示 v1119k，即 11/19 的网页——11/22 的新定位代码根本没被加载）。
创建 webview 时**必须**加 `cacheMode: "noCache"` 并清一次旧缓存：

```js
var ws = plus.webview.create(APP_URL, "remote", {
  cacheMode: "noCache",     // ← 新加：每次都从网络取最新页面
  ...原有其他参数保留...
});
ws.clearCache();            // ← 新加：清掉之前缓存的旧页面
```

**验收顺序**：先看页面右下角小字版本号——**v1121c 才说明加载到了最新
网页**；还是 v1119k 就说明缓存没清干净，别急着测定位。

**给壳的 index.html 加这段**（在 `plus.webview.create(APP_URL, "remote", ...)`
创建出 ws 变量之后、`append`/显示之前插入；替换掉原来的定位相关调用）：

```js
// 让网页认出自己在壳里（v1121d 起必须：远程 webview 的 UA 实测不带
// Html5Plus 标记，网页只能靠这个注入标记认出壳环境）
ws.addEventListener('loaded', function () {
  ws.evalJS('window.__jbxShellBridge = 1');
});

// ===== 结伴行定位拦截 v2（2026-11-22，带回失败原因 + 缓存 + 低精度重试）=====
ws.overrideUrlLoading({ mode: 'reject', match: 'jbxaction://locate' }, function () {
  var tries = 0;

  // 统一回传：成功给坐标，失败给原因（网页会把原因显示给用户）
  function send(lng, lat, msg) {
    try {
      ws.evalJS('window.__jbxFromAppLocation(' +
        (lng == null ? 'null' : lng) + ',' +
        (lat == null ? 'null' : lat) + ',' +
        JSON.stringify(msg || '') + ')');
    } catch (e) {}
  }

  function describe(err) {
    var code = err && err.code;
    var map = {
      1: '定位权限被拒绝',
      2: '定位服务不可用（手机定位总开关可能关着）',
      3: '定位超时（室内信号弱）',
      9: '没有精确定位权限'
    };
    return (map[code] || ('错误码 ' + code)) + ' ' + ((err && err.message) || '');
  }

  function locate(highAccuracy) {
    plus.geolocation.getCurrentPosition(
      function (pos) {
        var c = (pos && pos.coords) || {};
        if (c.longitude && c.latitude) send(c.longitude, c.latitude);
        else retry('返回坐标为空');
      },
      function (err) { retry(describe(err)); },
      {
        provider: 'system',
        coordsType: 'wgs84',
        enableHighAccuracy: !!highAccuracy,
        timeout: 15000,
        maximumAge: 60000   // 允许用最近 1 分钟的缓存定位，室内也能出结果
      }
    );
  }

  function retry(msg) {
    tries++;
    if (tries === 1) { locate(false); return; }  // 高精度失败 → 网络/低精度再来一次
    send(null, null, msg);
  }

  function start() {
    if (plus.os.name === 'Android' && plus.android.requestPermissions) {
      plus.android.requestPermissions(
        ['android.permission.ACCESS_FINE_LOCATION',
         'android.permission.ACCESS_COARSE_LOCATION'],
        function () { setTimeout(function () { locate(true); }, 300); },
        function () { locate(true); }   // 即使被拒也试一次（可能是大致位置）
      );
    } else { locate(true); }
  }
  start();
});
// ======================================
```

> v2 改动（11/22）：原版失败只回传 null，用户只看到"定位失败"没法排查。
> v2 把错误码/原因带回网页显示；超时 15s、允许缓存定位；高精度失败后
> 自动用低精度（网络定位）重试一次——室内靠 WiFi/基站也能出大致位置。

**同时确认 manifest.json**（应该已勾过）：
- App 模块配置 → **Geolocation（定位）** 模块
- App 权限配置 → Android → `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION`

然后 **发行 → 原生 App-云打包** 出一版新 APK。

> ⚠️ 注意：壳的改动只在真机 App 里生效，HBuilderX「运行到浏览器」测不出，
> 必须真机运行或装新 APK 验证。网页端会自动把 App 回传的 wgs84 坐标转成
> 高德 gcj02；壳没接拦截代码时，网页会在 6 秒后自动降级试浏览器定位，
> 仍失败则引导「地图选点」，不会卡死。

### B. 原生 WebView 自定义壳（自己写的 Android 项目）

在 `MainActivity` 里给 WebView 接上定位桥（约 20 行）：

```java
// 1) 授权运行时权限（Android 6+）：先申请 ACCESS_FINE_LOCATION
// 2) 给 WebView 设置 WebChromeClient
webView.setWebChromeClient(new WebChromeClient() {
    @Override
    public void onGeolocationPermissionsShowPrompt(
            String origin, GeolocationPermissions.Callback callback) {
        // true = 允许，false = 不记住选择（每次问）
        callback.invoke(origin, true, false);
    }
});
// 3) WebSettings 里打开定位
webView.getSettings().setGeolocationEnabled(true);
```

`AndroidManifest.xml` 里补：

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

### C. 在线「网站转 APK」工具（WebViewGold / AppsGeyser 等）

进工具后台找类似 **Location / GPS / 定位权限** 的开关，打开后重新生成。
如果后台没有这个选项，就走下面的兜底，不用折腾。

## 四、兜底（所有情况都可用，已在产品里）

点出发地旁的 **「📍 地图选点」**：打开高德地图，拖动地图让图钉对准位置，
点「就用这里」。**这条路不依赖任何定位权限，APK 里 100% 可用**，坐标同样精确。

## 五、验收清单

- [ ] 新 APK 安装后，首次点「定位」会弹系统授权框（A/B 两种修法都应如此）
- [ ] 允许后出发地自动填成当前位置的地址，不是一串坐标
- [ ] 拒绝授权后，提示文案引导用地图选点，不卡死
- [ ] 地图选点在 APK 里始终可用
