---
title: "Typora License Bypass 分析记录"
date: 2026-05-07
draft: false
tags: ["安全研究", "逆向分析", "macOS"]
summary: "逆向分析 Typora for macOS 的本地许可证机制，记录一次从文件存储到运行时状态同步的完整梳理"
---

> tips: 这篇主要就是把我原来那份写得太像报告的东西，按我平常记笔记的方式重新写一遍

### Background

最近顺手看了下 Typora macOS 版的许可证逻辑，主要想搞明白几个问题：

1. 它本地许可证到底存哪。
2. 它怎么判断自己有没有激活。
3. 原生层的激活状态怎么同步到前端 UI。
4. 如果要做本地 bypass，最后到底该卡在哪几个点。

目标程序是 `/Applications/Typora.app`，版本是 `1.13.4`。先看下最基础的信息：

```bash
$ file /Applications/Typora.app/Contents/MacOS/Typora
Mach-O universal binary with 2 architectures: [x86_64] [arm64]

$ cat /Applications/Typora.app/Contents/Info.plist | grep -A1 'CFBundleIdentifier'
<key>CFBundleIdentifier</key>
<string>abnerworks.Typora</string>

$ cat /Applications/Typora.app/Contents/Info.plist | grep -A1 'CFBundleShortVersionString'
<key>CFBundleShortVersionString</key>
<string>1.13.4</string>
```

可以看到它是个 `Universal Binary`，`Bundle ID` 是 `abnerworks.Typora`。然后再往资源目录里翻一遍，大概能看出它不是一个纯原生应用，而是典型的 `Cocoa + WKWebView` 混合架构。这个点后面很关键，因为许可证状态不光要在 native 那边成立，还得传到 web 层。

我当时大概整理出来的结构是这样：

```text
Typora.app/
├── Contents/
│   ├── MacOS/Typora
│   ├── Frameworks/Sparkle.framework
│   ├── Resources/
│   │   ├── TypeMark/
│   │   │   ├── appsrc/main.js
│   │   │   ├── page-dist/license.html
│   │   │   └── page-dist/static/js/LicenseIndex.*.js
│   │   └── *.lproj/
│   └── Info.plist
```

从这里其实已经能感觉出来了，许可证页面本身就是个单独的前端页面，所以后面只看 native 逻辑是不够的，UI 状态那条链也得一起看。

### 0x01 先找关键类和方法

这种东西我一般还是先从符号表和字符串入手，先别着急一头扎进汇编里。直接 `nm` 一把搜 `license`：

```bash
$ nm -arch arm64 /Applications/Typora.app/Contents/MacOS/Typora | grep -i license
```

翻一圈之后，核心基本都落在 `LicenseManager` 上了。比较关键的方法有这些：

- `+[LicenseManager sharedInstance]`
- `-[LicenseManager hasLicense]`
- `-[LicenseManager quickValidateLicense:]`
- `-[LicenseManager readLicenseInfo]`
- `-[LicenseManager postNotification]`
- `-[LicenseManager writeLicenseInfo]`
- `-[LicenseManager verifySig:]`
- `-[LicenseManager activate:with:force:callback:]`
- `-[LicenseManager unfillLicense]`
- `-[LicenseManager recordFilePathNew]`
- `-[LicenseManager recordFilePathOld]`

跟 UI 同步有关的也能顺手看到几个：

- `-[TyWindowController onFillLicense]`
- `-[TyWindowController onUnfillLicense]`
- `-[TyWindowController jsWhenUnfillLicense]`
- `-[WKPreferenceController onFillLicense]`

看到这里其实思路就比较清楚了。`LicenseManager` 负责本地许可证的读写和校验，`TyWindowController` / `WKPreferenceController` 负责把结果反映到界面上。也就是说如果只把 native 层某个布尔值改掉，但没有走完通知链，UI 还是有可能露馅。

### 0x02 hasLicense 这个点很关键

继续往下拆的时候，我第一个重点看的就是 `hasLicense`。因为这种方法名字都摆这了，不看白不看。反汇编一下：

```bash
$ objdump -d --arch=arm64 /Applications/Typora.app/Contents/MacOS/Typora \
    | awk '/^10006aadc:/{found=1} found{print; if(++count>6)exit}'
```

拿到的核心逻辑大概是这样：

```asm
; -[LicenseManager hasLicense]
10006aadc: ldr  x0, [x0, #0x18]
10006aae0: cbz  x0, 0x10006aae8
10006aae4: b    _objc_msgSend$boolValue
10006aae8: mov  w0, #0x1
10006aaec: ret
```

这个地方挺有意思的。它先读 `self + 0x18` 这个位置的实例变量，也就是 `_hasLicense`。如果这个值不是空，那就去调 `boolValue` 返回结果；如果这个值是 `nil`，它居然直接返回 `YES`。

也就是说这方法的语义不是“严格判断是否有许可证”，而更像是“如果状态没初始化出来，那先当成有”。这个地方我第一眼看到的时候就觉得挺怪，但也说明了一个事：最终许可证状态确实就是靠一个很普通的对象字段在撑。

### 0x03 本地许可证文件放哪

然后我继续顺着 `recordFilePathNew` 和 `recordFilePathOld` 看本地记录到底写在哪。最后能定位到路径：

```bash
$ ls -la ~/Library/Application\ Support/abnerworks.Typora/
-rw-r--r--  1 user  staff  368  .G1KQ60Enmo
drwxr-xr-x 14 user  staff  448  themes/
```

可以看到它会在 `~/Library/Application Support/abnerworks.Typora/` 下面放一个隐藏文件，这个文件名不是固定字符串，而是跟设备指纹相关。

这个时候我基本就能猜出来它大概想干嘛了：

- 用设备指纹生成文件名，避免直接拷来拷去。
- 文件内容再做一次加密，避免被一眼看懂。

继续顺着加密逻辑看，后面能确认它用的是 `AES-256-CBC`，密钥来自设备 UUID 再拼固定种子。整体流程大概是：

```text
1. 取设备 UUID
2. 拼接字符串: UUID + "typora-license"
3. 做 SHA256
4. 取 32 字节作为 AES key
5. 用 AES-256-CBC 处理本地许可证文件
```

在 `+[Crypto encryptAES:]` 相关逻辑里，`CCCrypt` 参数也能对上：

```asm
mov  w0, #0x0
mov  w1, #0x0
mov  w2, #0x1
mov  x3, x25
mov  w4, #0x20
mov  x5, #0x0
```

这里分别就是：

- `kCCEncrypt`
- `kCCAlgorithmAES128`
- `kCCOptionPKCS7Padding`
- key
- 32 字节 key length
- `IV = NULL`

虽然常量名叫 `AES128`，但 key 长度传的是 `0x20`，所以实际就是 `AES-256-CBC`。

### 0x04 解一下本地文件看看

知道算法之后事情就简单很多了，直接本地把它解出来看看到底存了什么。

先取设备 UUID：

```bash
$ ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
"IOPlatformUUID" = "F2B86F35-F9D1-5CE4-AD9E-B361CBBF641E"
```

然后拼接种子做 SHA256：

```bash
$ echo -n "F2B86F35-F9D1-5CE4-AD9E-B361CBBF641Etypora-license" | shasum -a 256
2eb86cb514fd78d5b9ff2aa8369c99de641d73e93fce676dadc8493adccd4ed0
```

接着直接解：

```bash
$ openssl enc -aes-256-cbc -d \
    -K "2eb86cb514fd78d5b9ff2aa8369c99de641d73e93fce676dadc8493adccd4ed0" \
    -iv 00000000000000000000000000000000 \
    -in ~/Library/Application\ Support/abnerworks.Typora/.G1KQ60Enmo \
    -out /tmp/license.plist
```

最后拿 `plutil` 看一下内容：

```bash
$ plutil -p /tmp/license.plist
{
  "installDate" => 2026-04-30 01:42:25 (NSDate)
}
```

能看到未激活状态下这个文件内容其实很朴素，只有一个 `installDate`。也就是说，重点根本不在“这个文件里藏了多复杂的东西”，重点在于 `readLicenseInfo` 读完之后，内存里的状态被怎么解释。

### 0x05 整个许可证链条怎么走

到这里我基本把流程串起来了，大概是这样：

```text
应用启动
  ↓
[LicenseManager readLicenseInfo]
  ↓
读取并解密本地记录文件
  ↓
填充 _licenseDict 和 _hasLicense
  ↓
[LicenseManager postNotification]
  ↓
检查 [_hasLicense boolValue]
  ├── YES
  │     ↓
  │   发送 fillLicense
  │     ↓
  │   [TyWindowController onFillLicense]
  │     ↓
  │   MainThreadRunner 执行 JS
  │     ↓
  │   File.option.hasLicense = true
  │
  └── NO
        ↓
      发送 unfillLicense
        ↓
      [TyWindowController onUnfillLicense]
        ↓
      jsWhenUnfillLicense 生成未激活 UI
```

这个地方我觉得是整篇里最关键的一段。因为它说明了 bypass 不一定非要去伪造一个完整合法的许可证，很多时候你只要把最后这几个消费状态的点拿下就够了。

尤其这里有两个地方特别值得记一下：

1. `_hasLicense` 是一个明确存在的状态位。
2. native 到 web 的同步最后会落到 `File.option.hasLicense = true` 这种 JS 侧结果上。

这就意味着如果你只改前面，不改后面，UI 可能还是会显示没激活；反过来如果你只改 UI，不改 native 层，一些依赖原生判断的地方也可能出问题。所以这条链最好一起看。

### 0x06 当时我的 bypass 思路

我当时的想法其实挺直接的，不去硬伪造完整许可证，也不去和它在线激活那套逻辑纠缠，直接从运行时状态下手。

具体来说就是几个点：

1. `hasLicense` 直接返回 `YES`。
2. `readLicenseInfo` 里手工塞一个假的许可证字典。
3. `_hasLicense` 直接置成真。
4. `onUnfillLicense` 这种会把未激活标签画出来的方法直接拦掉。
5. `quickValidateLicense:`、`verifySig:` 这类校验点直接放过。

这里还有两个坑当时顺手记了下。

第一个坑是 `DYLD_INSERT_LIBRARIES`。Typora 的签名带 `runtime` 标志，也就是 Hardened Runtime 默认会拦注入，所以不能上来就插 dylib。

第二个坑是通知链。你 native 里把 `_hasLicense` 改成真还不够，如果时机不对，窗口控制器和前端页面还没注册观察者，后面的 UI 也不会跟着变。所以这个地方最好还是让原始的 `postNotification` 自己跑一遍，只不过要选一个合适时机去调。

### 0x07 Hook 代码

我当时写的 `hook.m` 大概就是这样：

```objc
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <objc/message.h>

static IMP orig_postNotification = NULL;

static BOOL hooked_hasLicense(id self, SEL _cmd) { return YES; }

static BOOL hooked_cannotContonueUse(id self, SEL _cmd, BOOL arg) { return NO; }

static void hooked_showLicenseIfNeeded(id self, SEL _cmd) {}

static BOOL hooked_quickValidateLicense(id self, SEL _cmd, id license) { return YES; }

static BOOL hooked_verifySig(id self, SEL _cmd, id sig) { return YES; }

static void hooked_unfillLicense(id self, SEL _cmd) {
    NSLog(@"[HOOK] unfillLicense BLOCKED");
}

static void hooked_readLicenseInfo(id self, SEL _cmd) {
    NSLog(@"[HOOK] readLicenseInfo -> injecting fake license");

    NSDictionary *fakeDict = @{
        @"email": @"Hooked By Tarn",
        @"license": @"TARN00-HOOKED-BYPASS-CCFLAG",
        @"type": @"",
    };

    Ivar dictIvar = class_getInstanceVariable(object_getClass(self), "_licenseDict");
    if (dictIvar) object_setIvar(self, dictIvar, fakeDict);

    Ivar hasIvar = class_getInstanceVariable(object_getClass(self), "_hasLicense");
    if (hasIvar) object_setIvar(self, hasIvar, @YES);

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
        NSLog(@"[HOOK] Calling original postNotification");
        if (orig_postNotification) {
            ((void (*)(id, SEL))orig_postNotification)(self,
                NSSelectorFromString(@"postNotification"));
        }
    });
}

static id hooked_getLicensePanelUrlParams(id self, SEL _cmd, id sender) {
    return @"os=mac&email=Hooked%20By%20Tarn&license=TARN00-HOOKED-BYPASS-CCFLAG"
           @"&hasActivated=true&needLicense=false&index=0";
}

static void hooked_onUnfillLicense(id self, SEL _cmd) {
    NSLog(@"[HOOK] onUnfillLicense BLOCKED");
}

static id hooked_jsWhenUnfillLicense(id self, SEL _cmd) {
    return @"";
}

static void hookMethod(Class cls, NSString *selName, IMP newImp) {
    Method m = class_getInstanceMethod(cls, NSSelectorFromString(selName));
    if (m) {
        method_setImplementation(m, newImp);
        NSLog(@"[HOOK] Hooked %@.%@", NSStringFromClass(cls), selName);
    }
}

__attribute__((constructor))
static void hook_init(void) {
    NSLog(@"[HOOK] ===== Tarn License Bypass =====");

    Class lm = NSClassFromString(@"LicenseManager");
    if (lm) {
        Method pm = class_getInstanceMethod(lm, NSSelectorFromString(@"postNotification"));
        if (pm) orig_postNotification = method_getImplementation(pm);

        hookMethod(lm, @"hasLicense",              (IMP)hooked_hasLicense);
        hookMethod(lm, @"cannotContonueUse:",      (IMP)hooked_cannotContonueUse);
        hookMethod(lm, @"showLicenseIfNeeded",     (IMP)hooked_showLicenseIfNeeded);
        hookMethod(lm, @"readLicenseInfo",         (IMP)hooked_readLicenseInfo);
        hookMethod(lm, @"unfillLicense",           (IMP)hooked_unfillLicense);
        hookMethod(lm, @"quickValidateLicense:",   (IMP)hooked_quickValidateLicense);
        hookMethod(lm, @"verifySig:",              (IMP)hooked_verifySig);
        hookMethod(lm, @"getLicensePanelUrlParams:", (IMP)hooked_getLicensePanelUrlParams);
    }

    Class twc = NSClassFromString(@"TyWindowController");
    if (twc) {
        hookMethod(twc, @"onUnfillLicense",        (IMP)hooked_onUnfillLicense);
        hookMethod(twc, @"jsWhenUnfillLicense",    (IMP)hooked_jsWhenUnfillLicense);
    }

    Class wkpc = NSClassFromString(@"WKPreferenceController");
    if (wkpc) {
        hookMethod(wkpc, @"onUnfillLicense",       (IMP)hooked_onUnfillLicense);
    }

    NSLog(@"[HOOK] ===== All hooks installed =====");
}
```

这里面我觉得最重要的不是“把多少方法改成 return YES”，而是 `hooked_readLicenseInfo` 这段。因为它做了三件事：

1. 手工塞 `_licenseDict`。
2. 手工塞 `_hasLicense = @YES`。
3. 延迟调用原始 `postNotification`。

第三步特别关键。因为你如果直接自己造一堆通知，反而容易漏链；但如果你把状态先改好，再让原始 `postNotification` 自己走，它后面的 `fillLicense -> onFillLicense -> JS` 这整串就会按原本的逻辑自己跑完。

这也是我当时最想卡住的一个点：尽量顺着它已有的代码路径走，而不是自己重新伪造一整条路径。

### 0x08 launcher 这个东西为什么要写

前面说了，`DYLD_INSERT_LIBRARIES` 不是你想插就插的。为了让它启动的时候自动把 `hook.dylib` 带进去，我当时还顺手写了个很小的 `launcher`，让它替代原始二进制先跑起来，再去 `execv` 真正的程序。

代码很短：

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <libgen.h>
#include <mach-o/dyld.h>

int main(int argc, char *argv[]) {
    char path[4096];
    uint32_t size = sizeof(path);
    _NSGetExecutablePath(path, &size);
    char *dir = dirname(path);

    char dylib[4096];
    snprintf(dylib, sizeof(dylib), "%s/hook.dylib", dir);
    setenv("DYLD_INSERT_LIBRARIES", dylib, 1);

    char real[4096];
    snprintf(real, sizeof(real), "%s/Typora.real", dir);
    argv[0] = real;
    execv(real, argv);

    perror("execv failed");
    return 1;
}
```

这个东西本身没啥复杂的，就是把同目录下的 `hook.dylib` 自动塞到环境变量里，然后 `exec` 真正的二进制。这样应用图标双击启动的时候，也能把整个 hook 链带上。

### 0x09 编译和替换

`hook.dylib` 编译也很普通：

```bash
clang -dynamiclib \
    -framework Cocoa \
    -framework WebKit \
    -lobjc \
    -arch arm64 \
    -o hook.dylib \
    hook.m

codesign -f -s - hook.dylib
```

`launcher`：

```bash
clang -arch arm64 -o launcher launcher.c
```

当时我的处理流程大概是这样：

```bash
# ① 备份
cp -R /Applications/Typora.app /Applications/Typora.app.bak

# ② 处理签名
codesign --remove-signature /Applications/Typora.app/Contents/MacOS/Typora
codesign -f -s - --deep /Applications/Typora.app

# ③ 放 hook.dylib
clang -dynamiclib -framework Cocoa -framework WebKit -lobjc -arch arm64 \
    -o /Applications/Typora.app/Contents/MacOS/hook.dylib hook.m
codesign -f -s - /Applications/Typora.app/Contents/MacOS/hook.dylib

# ④ 编译 launcher
clang -arch arm64 -o /tmp/launcher launcher.c

# ⑤ 替换原始二进制
mv /Applications/Typora.app/Contents/MacOS/Typora \
   /Applications/Typora.app/Contents/MacOS/Typora.real
cp /tmp/launcher /Applications/Typora.app/Contents/MacOS/Typora
chmod +x /Applications/Typora.app/Contents/MacOS/Typora

# ⑥ 重新签名
codesign -f -s - --deep /Applications/Typora.app

# ⑦ 启动
open /Applications/Typora.app
```

这块我就不展开讲太多了，因为代码分析本身已经够说明问题了。真正有价值的还是前面那条状态链：本地记录怎么读，内存状态怎么落，通知怎么发，UI 怎么跟着变。

### 0x0a 最后看一下这个 bypass 到底卡住了哪几个点

回头看一遍，其实整个事的核心也就这几条：

1. `hasLicense` 最终就是个很普通的对象状态判断。
2. `readLicenseInfo` 会把本地文件内容翻译成 `_licenseDict` 和 `_hasLicense`。
3. `postNotification` 是 native 状态同步到 UI 的关键桥。
4. `onUnfillLicense` / `jsWhenUnfillLicense` 这类方法直接决定了未激活 UI 怎么画。

所以如果你只是把本地文件解出来，其实你只完成了一半；真正重要的是把“文件 -> 内存 -> 通知 -> UI”这整条线都串明白。串明白之后再回头看，很多点其实都很直白。

## 后记

这篇里我自己觉得最有意思的地方，不是 AES，也不是签名，而是 `readLicenseInfo` 和 `postNotification` 中间那条状态同步链。很多本地授权逻辑最后都不是输在算法上，而是输在“总得有一个地方把结果交出来”。

Typora 这个例子也差不多。你把这个地方看明白了，后面很多东西其实就顺下来了。
