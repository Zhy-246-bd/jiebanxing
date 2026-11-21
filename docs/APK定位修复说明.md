# APK 内「自动定位」不可用 —— 修复说明

> 给雷馨怡：网页端已做兼容（2026-11-21，提交见仓库），下面按你的打包方式选一条走。
> 交付日 11/23，不着急，先在群里回一句"APK 是用什么工具打的"即可。

## 一、现象

在 APK 里点出发地旁的「🎯 定位」，**不弹系统授权框**，直接提示
「App 内置浏览器不支持网页定位：请点📍地图选点」。

浏览器里（手机自带浏览器 / 微信打开线上网址）一切正常。

## 二、根因（一句话）

APK 是 WebView 壳。网页的定位要弹授权框，必须由 **APK 的安卓代码**接一个回调
（`onGeolocationPermissionsShowPrompt`）并声明定位权限。大部分一键打包工具
默认没接，网页端无法自己解决。

## 三、按打包方式选修法

### A. HBuilderX / uni-app 打包（可能性最大）

网页端**已经兼容**：页面里检测到 App 注入的 `plus` 对象后，会自动改用它自带的
定位 API（`plus.geolocation`），不经过浏览器授权框。

你只需要确认两件事，然后**重新打包发一版**：

1. `manifest.json` → App 模块配置 → 勾选 **Geolocation（定位）** 模块
2. `manifest.json` → App 权限配置（Android）→ 勾选
   - `android.permission.ACCESS_FINE_LOCATION`（精确位置）
   - `android.permission.ACCESS_COARSE_LOCATION`（粗略位置）

验收：新 APK 里点「定位」→ 系统弹「是否允许获取位置」→ 允许 → 地址自动填好。

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
