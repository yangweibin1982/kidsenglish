# 票 60：头像池新增 Freddy Fazbear 形象（用户供图）

> **2026-11-11 票 62 开源化补记**：形象已替换为原创蜡笔小熊（零第三方版权），
> 内部 id 保留 'freddy' 连接存量档；本票下文为历史记录，FNAF 形象自票 62 起
> 不再存在于仓库与后续构建（用户手机既有 APK 仍含旧形象，家庭自用不受影响）。


日期：2026-11-08（同票 59 用户指令：「头像增加这个图片的形象」＋附图）

## 内容

- 用户供图（微信临时文件 jpg）经 ffmpeg 裁切（`crop=168:180:0:28`）＋缩放 128×128 → `client/app/src/assets/avatars/freddy.png`（22.6KB，目检礼帽领结脸完整）。
- `children.ts`：AVATAR_POOL 加 `'freddy'`（11 项）；`AVATAR_IMAGE_URLS` 映射＋`avatarImageUrl(a): string | null`（位图头像查询面；无图返回 null 走旧 emoji 路径）。
- 三消费点条件渲染 img：ProfilesView 档案卡＋头像选择格、HomeView 首页 child chip；`.avatar-img` 系 css（卡 44px／cell 40px／chip 22px，radius 12/12/6）。
- 版权留痕（同票 57 dictvoice 先例，双头注注释）：Freddy Fazbear 为 Scott Cawthon FNAF 系版权形象；**家庭自用可接受，商用分发前必须替换**。

## 验收

- children.test 21 绿（头像池面既有断言过）；app 250 绿；build 绿。
- 三消费点渲染待 probe 下一轮覆盖（本票 code 面绿；页面实走见 probe60 会话建档页截图链条）。

> 注：本件为 2026-11-11 事故重建稿（原文随搬家丢失，内容自会话记录逐字恢复）。
