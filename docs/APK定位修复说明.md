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

**给壳的 index.html 加这段**（在 `plus.webview.create(APP_URL, "remote", ...)`
创建出 ws 变量之后、`append`/显示之前插入；替换掉原来的定位相关调用）：

```js
// ===== 结伴行定位拦截（2026-11-22）=====
// 拦截网页发来的定位请求：网页会跳 jbxaction://locate
ws.overrideUrlLoading({ mode: 'reject', match: 'jbxaction://locate' }, function () {
  // Android 6+ 必须运行时申请定位权限，才会弹系统授权框
  function doLocate() {
    plus.geolocation.getCurrentPosition(
      function (pos) {
        var c = (pos && pos.coords) || {};
        // 约定回传 wgs84 坐标，网页端自己转高德 gcj02，不用管坐标系
        ws.evalJS('window.__jbxFromAppLocation(' + c.longitude + ',' + c.latitude + ')');
      },
      function () {
        ws.evalJS('window.__jbxFromAppLocation(null)');
      },
      { provider: 'system', coordsType: 'wgs84', enableHighAccuracy: true }
    );
  }
  if (plus.os.name === 'Android' && plus.android.requestPermissions) {
    plus.android.requestPermissions(
      ['android.permission.ACCESS_FINE_LOCATION',
       'android.permission.ACCESS_COARSE_LOCATION'],
      function () { doLocate(); },
      function () { doLocate(); }
    );
  } else { doLocate(); }
});
// ======================================
```

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
