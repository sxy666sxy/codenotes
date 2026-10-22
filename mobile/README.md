# CodeNotes · 安卓壳（Capacitor）

这个目录把 `../` 里的网页应用（PWA）打包成真正的 Android App。

## 结构

```
mobile/
  capacitor.config.json   App 名称 / 包名 com.codenotes.app / 深色背景
  scripts/copy-web.mjs    把 ../ 的网页源码复制到 www/
  www/                    复制出来的网页（自动生成，不用手改）
  android/                Capacitor 生成的安卓工程（构建时用）
```

**改代码只改上一层的 `codenotes/`**，然后重新 `npm run sync-web`。

## 在 GitHub 上打包（不用装 Android Studio）

1. 把 `codenotes/` 整个目录 Push 到 GitHub 仓库（默认分支 main）。
2. 仓库的 Actions 页面会出现 **Build Android APK**，点 *Run workflow*。
3. 等 3~6 分钟，在该次运行页面底部下载 `codenotes-debug-apk` 压缩包，里面就是 `app-debug.apk`。
4. 传到手机安装（需要允许「安装未知来源应用」）。

工作流文件在 `../.github/workflows/build-apk.yml`，它会自动：装 Node 22 / JDK 21 / Android SDK 36 → `npm ci` → 复制网页 → `cap sync` → `gradlew assembleDebug`。

## 在本地打包（电脑 / 已装 Android SDK）

需要 JDK 21 + Android SDK Platform 36 + Build-Tools 36。

```bash
cd mobile
npm install
npm run sync-web
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

用 Android Studio 打开 `mobile/android` 也可以直接点 Run。

## 发布版（签名）

debug 包可以直接装、自己用。要上架/长期分发时做一个正式签名：

```bash
keytool -genkey -v -keystore codenotes.keystore -alias codenotes \
  -keyalg RSA -keysize 2048 -validity 10000
```

然后在 `android/app/build.gradle` 里配置 `signingConfigs.release`，执行 `./gradlew assembleRelease`。
