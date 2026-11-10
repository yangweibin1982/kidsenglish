# 票 62：开源化——GPL-3.0＋第三方版权清障＋仓转公开

日期：2026-11-11（用户指令「把这个 GIT 仓库更新为开源，你觉得哪个协议对我最友好」→ AskUserQuestion 两问拍板：**GPL-3.0**＋**清障后直接转公开**）

## 协议决策（证据＋三评估留痕）

- 推荐 GPL-3.0：个人开发者教育应用，无「求企业采用」诉求；防套壳闭源商用（教育 App 最常见下场）＝对作者最强自保；家庭自用场景三协议无差异。
- 用户拍板 GPL-3.0（推荐项）＋直转公开（推荐项）。

## 清障清单（开源＝公开分发，第三方版权自用豁免失效）

1. **freddy.png 替换为原创蜡笔小熊**（PIL 生成脚本 `C:\KE-Recovery\staging\make-bear-avatar.py` 留档；128×128 案 C 蜡笔风）——FNAF 版权面清零；children.ts 头注改写（内部 id 沿用 'freddy' 保存量档连续性，形象已原创）。用户手机 APK 仍含旧 freddy 形象（家庭自用不受影响），下次出货起换新形象。
2. **100 个 .pyc 清出索引**＋`__pycache__/*.pyc` 入 gitignore。
3. **NOTICE.md**：ECDICT（MIT，pypi 通路上游核验）、word-atlas（CC BY 4.0，页脚署名保留）、词表事实源声明（教材词表＝事实性目录，释义/例句自写）、音频不入仓声明（dictvoice 脚本仅供自用）、美术全原创声明。
4. **LICENSE**：GPL-3.0 官方全文（网络直连全断，经 pypi glances 包 COPYING 切出——LGPL+GPL 合订本剥离 LGPL 段，34,670B 首尾完整性抽验过）。

## 网络坑（L49 候选）

- 2026-11-11 凌晨出口网络整体不可达（gnu.org/raw.githubusercontent/api.github.com 全 timeout），pypi.org 仍通——**pip 是最后一条可靠出网通道**，GPL 等标准文本可经 pypi 包内 LICENSE 提取（注意合订本剥离）。

## 验收与执行

- 提交推送后 `gh repo edit --visibility public`（用户明示授权）→ 公开页可匿名访问验证。
