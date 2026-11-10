"""补全五项（spec S3／R12 逐项）：音标、释义、模板例句、emoji 配图、拼读拆分。

来源留痕（U1 试点编制笔记＝票报告 03-engineer-pipeline-pilot.md「U1 试点编制笔记」）：
- 音标：ECDICT 自动补全（06 报告实测口径：音标单列英音 DJ、屈折词 exchange 0:lemma 救回）；
  phonetic_us 留空（ECDICT 无美音，R13 默认英式先行）。
- 释义：curated 层优先（票 17 全册校对轮 2026-11-01＝1 上 105 词；票 19 滚动轮 2026-11-01
  扩至 2 上 112 词）——CURATED_SENSES 逐词覆盖
  （键＝normalize_word；首义＝教材核心义、义项 ≤2 条、裁垃圾尾义），curated 优先、
  无 curated 走 ECDICT 原路（clean_translation 领域行裁剪＋build_senses 取前 MAX_SENSES 行）。
  curated 不改查无状态机：ECDICT 查无仍进 E7 零编造，curated 只替换 ok 词条的义项来源。
- 模板例句：ECDICT 无例句货（detail 全库仅 1 条，06 §2）→「句型模板＋词形填充」自拟生成：
  通用模板库（按词性分类）＋逐词 curated 句型覆盖（自拟 2026-10-24，用于模板产出不通顺的词，
  如问候语/功能词）。每条例句带 origin 标记（template:* / curated:*）可溯。
- emoji 配图：自拟小型映射（2026-10-24）；未映射词留空，不编造。
- 拼读拆分：保守 VCCV 启音-韵音启发式（VCCV 才切、双音 digraph 不切）＋逐词 override
  （自拟 2026-10-24）；无把握不拆（返回 None）。

WRONG 红线：ECDICT 查无（含纯领域释义、屈折且无可用 lemma）→ 音标/释义一律不编造，
status=missing 进待补队列（E7）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import pyphen

from app.pipeline.ecdict import (
    EcdictLookup,
    clean_translation,
    lemma_of,
    looks_inflected_only,
    normalize_phonetic,
)
from app.pipeline.normalize import lexical_entry_id, normalize_word

MAX_SENSES = 2  # 每词最多取 2 个义项（06 §7：取前 1-2 个义项）

# ---------------------------------------------------------------------------
# 自拟内容面（编制笔记留痕；均为「句型模板＋词形填充」形态）
# ---------------------------------------------------------------------------

# 模板例句库：词性类别 → (英文模板, 中文模板, origin)。占位符：
#   {word} 原词形、{Word} 首字母大写、{article} a/an（元音开头 → an）、
#   {zh} 首义 gloss 清洗形（票 22 zh 本土化：中文侧嵌释义不嵌英文原词）。
#   int/default 中文侧保留 {word}/{Word}：感叹词与「我会说"…"」引号内说词形本身，
#   属语义正确形态，非混排瑕疵。
EXAMPLE_TEMPLATES: dict[str, tuple[tuple[str, str, str], ...]] = {
    "n": (
        ("This is my {word}.", "这是我的{zh}。", "template:t-n-my"),
        ("I can see {article} {word}.", "我能看到{zh}。", "template:t-n-see"),
    ),
    "v": (
        ("I can {word}.", "我会{zh}。", "template:t-v-can"),
        ("Let's {word} together.", "我们一起{zh}吧。", "template:t-v-lets"),
    ),
    "adj": (("It is very {word}.", "它非常{zh}。", "template:t-adj-very"),),
    "int": (("She waves and says, \u201c{Word}!\u201d", "她挥着手说：“{Word}！”", "template:t-int-say"),),
    # pron 类＝空模板（2026-11-08 her 例句报障全库纠正）：代词句型各异（主格/宾格/
    # 限定词/反身），通用槽位填不出自然句——曾经的固定句 "I am seven. I am a pupil."
    # 不含 {word} 槽位，任何代词套它都得到同一句与词条脱钩的话（全库 28 词中招）。
    # 纪律＝按编制笔记既定线：模板填充不通顺的代词/功能词一律进 CURATED_EXAMPLES，
    # 无 curated 的 pron 词例句留空（视图层空行不渲染＝宁缺勿滥，同音标空值语义）。
    "pron": (),
    "default": (("I can say \u201c{word}\u201d.", "我会说“{word}”。", "template:t-default-say"),),
}

# 逐词 curated 句型（U1 试点 2026-10-24；票 17 全册校对轮 2026-11-01 扩到 1 上全册）：
# 模板按词形填充产出不通顺的词（动词/形容词/功能词/代词/数词/感叹拟声词/抽象词）
# 全部进本表；名词模板句自然通顺的可留模板。键＝normalize_word(词形)。
# 一年级口语短句，中英对齐。U1 单元语境句式参照 07 报告（"Hello, I'm ..." / "Good morning" 类）。
CURATED_EXAMPLES: dict[str, tuple[tuple[str, str, str], ...]] = {
    # --- U1 Hello（票 03 试点编制）---
    "hello": (("Hello! Hello, I'm Li Ming.", "你好！你好，我是李明。", "curated:u1-greet-intro"),),
    "hi": (("Hi! I'm Amy.", "嗨！我是埃米。", "curated:u1-greet-casual"),),
    "goodbye": (("Goodbye, Miss Li! See you tomorrow.", "再见，李老师！明天见。", "curated:u1-farewell"),),
    "morning": (("Good morning, Miss Li!", "早上好，李老师！", "curated:u1-greet-morning"),),
    "afternoon": (("Good afternoon, boys and girls.", "下午好，同学们。", "curated:u1-greet-afternoon"),),
    "i": (("I am a pupil. I am seven.", "我是小学生。我七岁。", "curated:u1-pron-i"),),
    "am": (("I am six years old.", "我六岁。", "curated:u1-be-am"),),
    "day": (("Have a nice day!", "祝你度过愉快的一天！", "curated:u1-farewell-day"),),
    # --- U2 My classmates（give 例句＝票 14 P2「这是我的give」治本）---
    "give": (("Give me the book, please.", "请给我这本书。", "curated:u2-give"),),
    "me": (("Look at me.", "看着我。", "curated:u2-pron-me"),),
    "a": (("This is a book.", "这是一本书。", "curated:u2-article-a"),),
    "please": (("Sit down, please.", "请坐。", "curated:u2-polite-please"),),
    "thank": (("Thank you!", "谢谢你！", "curated:u2-thank"),),
    "you": (("How are you?", "你好吗？", "curated:u2-pron-you"),),
    "on": (("The pencil is on the book.", "铅笔在书上。", "curated:u2-prep-on"),),
    "sunday": (("It is Sunday today.", "今天是星期日。", "curated:u2-sunday"),),
    "how": (("How old are you?", "你几岁？", "curated:u2-how"),),
    "nice": (("Nice to meet you!", "很高兴见到你！", "curated:u2-nice"),),
    # --- U3 My face ---
    "this": (("This is my face.", "这是我的脸。", "curated:u3-pron-this"),),
    "is": (("It is a pear.", "它是一个梨。", "curated:u3-be-is"),),
    "my": (("This is my pencil.", "这是我的铅笔。", "curated:u3-pron-my"),),
    "touch": (("Touch your nose.", "摸摸你的鼻子。", "curated:u3-touch"),),
    "your": (("What is your name?", "你叫什么名字？", "curated:u3-pron-your"),),
    "look": (("Look! A panda!", "看！一只熊猫！", "curated:u3-look"),),
    "no": (("No, it is not a pear.", "不，这不是一个梨。", "curated:u3-no"),),
    "not": (("That is not my book.", "那不是我的书。", "curated:u3-not"),),
    # --- U4 I can sing ---
    "can": (("Can you sing?", "你会唱歌吗？", "curated:u4-can"),),
    "sing": (("I can sing.", "我会唱歌。", "curated:u4-sing"),),
    "dance": (("Let's dance!", "我们一起跳舞吧！", "curated:u4-dance"),),
    "read": (("Read after me.", "跟我读。", "curated:u4-read"),),
    "draw": (("I can draw.", "我会画画。", "curated:u4-draw"),),
    "what": (("What is this?", "这是什么？", "curated:u4-what"),),
    "do": (("What can you do?", "你会做什么？", "curated:u4-do"),),
    # --- U5 My family ---
    "who": (("Who is she?", "她是谁？", "curated:u5-who"),),
    "she": (("She is my friend.", "她是我的朋友。", "curated:u5-pron-she"),),
    "he": (("He is my father.", "他是我的爸爸。", "curated:u5-pron-he"),),
    "yes": (("Yes, it is a pear.", "是的，这是一个梨。", "curated:u5-yes"),),
    # --- U6 My friends ---
    "tall": (("My father is tall.", "我的爸爸很高。", "curated:u6-tall"),),
    "short": (("My pencil is short.", "我的铅笔很短。", "curated:u6-short"),),
    "fat": (("The pig is fat.", "这只猪很胖。", "curated:u6-fat"),),
    "thin": (("I am thin.", "我很瘦。", "curated:u6-thin"),),
    # --- U7 Let's count ---
    "how many": (("How many books?", "有多少本书？", "curated:u7-how-many"),),
    "three": (("I have three peaches.", "我有三个桃子。", "curated:u7-three"),),
    "two": (("I have two pears.", "我有两个梨。", "curated:u7-two"),),
    "six": (("I have six books.", "我有六本书。", "curated:u7-six"),),
    "one": (("I have one apple.", "我有一个苹果。", "curated:u7-one"),),
    "four": (("I see four chicks.", "我看见四只小鸡。", "curated:u7-four"),),
    "five": (("I see five ducks.", "我看见五只鸭子。", "curated:u7-five"),),
    "let's": (("Let's sing!", "我们一起唱吧！", "curated:u7-lets"),),
    "count": (("Let's count!", "我们一起数吧！", "curated:u7-count"),),
    # --- U8 Apples, please ---
    "at": (("I am at school.", "我在学校。", "curated:u8-prep-at"),),
    "the": (("Open the book, please.", "请打开书。", "curated:u8-art-the"),),
    "supermarket": (("The supermarket is big.", "超市很大。", "curated:u8-supermarket"),),
    # --- U9 May I have a pie?（may 首义=教材核心用法「可以」，票 17 校对裁定）---
    "may": (("May I have a pie?", "我可以要一个馅饼吗？", "curated:u9-may"),),
    "have": (("I have a pie.", "我有一个馅饼。", "curated:u9-have"),),
    "bar": (("I have a chocolate bar.", "我有一块巧克力。", "curated:u9-bar"),),
    # --- U10 On the farm ---
    "moo": (("The cow says, “Moo!”", "牛说：“哞！”", "curated:u10-moo"),),
    "that": (("What is that?", "那是什么？", "curated:u10-that"),),
    "peep": (("Don't peep!", "别偷看！", "curated:u10-peep"),),
    "oink": (("The pig says, “Oink!”", "猪说：“哼哼！”", "curated:u10-oink"),),
    "quack": (("The duck says, “Quack!”", "鸭说：“嘎嘎！”", "curated:u10-quack"),),
    "cut": (("Cut the cake.", "把蛋糕切开。", "curated:u10-cut"),),
    "stick": (("Stick it here.", "把它贴在这里。", "curated:u10-stick"),),
    # --- U12 In the park ---
    "colour": (("What colour is it?", "它是什么颜色？", "curated:u12-colour"),),
    "yellow": (("The chick is yellow.", "小鸡是黄色的。", "curated:u12-yellow"),),
    "red": (("I see a red apple.", "我看见一个红苹果。", "curated:u12-red"),),
    "blue": (("I have a blue pencil.", "我有一支蓝色的铅笔。", "curated:u12-blue"),),
    "green": (("The pear is green.", "梨是绿色的。", "curated:u12-green"),),
    "small": (("My rubber is small.", "我的橡皮很小。", "curated:u12-small"),),
    "go": (("Let's go to school.", "我们去上学吧。", "curated:u12-go"),),
    "big": (("My school is big.", "我的学校很大。", "curated:u12-big"),),
    # --- 2 上 Good morning（票 19；origin 加 g2 前缀与 1 上同号单元区分）---
    "evening": (("Good evening, Dad.", "晚上好，爸爸。", "curated:g2u1-greet-evening"),),
    "night": (("Good night, Mum!", "晚安，妈妈！", "curated:g2u1-greet-night"),),
    "today": (("Today is Monday.", "今天是星期一。", "curated:g2u1-today"),),
    "very well": (("I am very well, thank you.", "我很好，谢谢你。", "curated:g2u1-very-well"),),
    "ant": (("Look! A little ant.", "看！一只小蚂蚁。", "curated:g2u1-ant"),),
    # --- 2 上 I'm Danny ---
    "boy": (("The boy is Danny.", "这个男孩是丹尼。", "curated:g2u2-boy"),),
    "girl": (("The girl is Alice.", "这个女孩是爱丽丝。", "curated:g2u2-girl"),),
    "name": (("My name is Danny.", "我的名字叫丹尼。", "curated:g2u2-name"),),
    # --- 2 上 Are you Alice? ---
    "sorry": (("Sorry, Mum.", "对不起，妈妈。", "curated:g2u3-sorry"),),
    "seven": (("I am seven years old.", "我七岁。", "curated:g2u3-seven"),),
    "eight": (("I see eight fish.", "我看见八条鱼。", "curated:g2u3-eight"),),
    "nine": (("I see nine birds.", "我看见九只鸟。", "curated:g2u3-nine"),),
    "ten": (("I have ten fingers.", "我有十根手指。", "curated:g2u3-ten"),),
    "elephant": (("The elephant is big.", "大象很大。", "curated:g2u3-elephant"),),
    # --- 2 上 Can you swim?（swim/run/write 模板句「I can …」自然，留模板）---
    "fly": (("Birds can fly.", "鸟会飞。", "curated:g2u4-fly"),),
    "can't": (("I can't swim.", "我不会游泳。", "curated:g2u4-cant"),),
    "giraffe": (("The giraffe is tall.", "长颈鹿很高。", "curated:g2u4-giraffe"),),
    # --- 2 上 U4 词组（票 21 词组 curated 通道：ECDICT 查无，enrich miss 分支装配）---
    "ride a bicycle": (("I can ride a bicycle.", "我会骑自行车。", "curated:g2u4-phrase-ride-bike"),),
    # --- 2 上 U8 词组（票 22 核验兜底：pos 缺失落 default 引号说词形，curated 后走名词句）---
    "pencil case": (("This is my pencil case.", "这是我的铅笔盒。", "curated:g2u8-pencil-case"),),
    # --- 2 上 That's my family（family/brother/sister「This is my …」自然，留模板；
    #     family 例句 curated 兜底：模板第二句「我能看到家庭」语义弱，票 22 核验裁定）---
    "family": (("This is my family.", "这是我的家人。", "curated:g2u5-family"),),
    "young": (("She is young.", "她很年轻。", "curated:g2u5-young"),),
    "old": (("My grandfather is old.", "我的爷爷年纪大。", "curated:g2u5-old"),),
    "insect": (("The insect is small.", "昆虫很小。", "curated:g2u5-insect"),),
    "jellyfish": (("Look at the jellyfish!", "看那只水母！", "curated:g2u5-jellyfish"),),
    # --- 2 上 My hair is short（head/long 模板句自然，留模板）---
    "hair": (("My hair is short.", "我的头发很短。", "curated:g2u6-hair"),),
    "now": (("I can run now.", "我现在会跑了。", "curated:g2u6-now"),),
    "kangaroo": (("Look at the kangaroo!", "看那只袋鼠！", "curated:g2u6-kangaroo"),),
    "lion": (("The lion has long hair.", "狮子有长长的毛。", "curated:g2u6-lion"),),
    "has": (("He has a big box.", "他有一个大箱子。", "curated:g2u6-has"),),
    # --- 2 上 In the playground（5 词全 curated：设施类「This is my …」不通顺）---
    "playground": (("We are in the playground.", "我们在游乐场里。", "curated:g2u7-playground"),),
    "slide": (("The slide is long.", "滑梯很长。", "curated:g2u7-slide"),),
    "swing": (("The swing is green.", "秋千是绿色的。", "curated:g2u7-swing"),),
    "seesaw": (("Look at the seesaw!", "看那个跷跷板！", "curated:g2u7-seesaw"),),
    "nightingale": (("The nightingale can sing.", "夜莺会唱歌。", "curated:g2u7-nightingale"),),
    # --- 2 上 In my room（room/bag/dad/box/chair/desk/car/pencil case 模板自然，留模板）---
    "put": (("Put the book in the bag.", "把书放进包里。", "curated:g2u8-put"),),
    "in": (("The pencil is in the bag.", "铅笔在包里。", "curated:g2u8-prep-in"),),
    "look at": (("Look at me!", "看我！", "curated:g2u8-look-at"),),
    "ox": (("The ox is big.", "牛很大。", "curated:g2u8-ox"),),
    "work": (("Dad goes to work.", "爸爸去上班。", "curated:g2u8-work"),),
    "sleep": (("I sleep at night.", "我在夜里睡觉。", "curated:g2u8-sleep"),),
    # --- 2 上 Dinner is ready（plate/bowl/spoon 模板自然，留模板）---
    "dinner": (("Dinner is ready!", "晚饭好了！", "curated:g2u9-dinner"),),
    "ready": (("I am ready!", "我准备好了！", "curated:g2u9-ready"),),
    "chopsticks": (("The chopsticks are long.", "筷子很长。", "curated:g2u9-chopsticks"),),
    "queen bee": (("Look at the queen bee!", "看那只蜂王！", "curated:g2u9-queen-bee"),),
    "fly around": (("The birds fly around.", "鸟儿飞来飞去。", "curated:g2u9-fly-around"),),
    "run around": (("We run around.", "我们跑来跑去。", "curated:g2u9-run-around"),),
    # --- 2 上 In the sky（bright「It is very …」自然，留模板）---
    "sky": (("The sky is blue.", "天空是蓝色的。", "curated:g2u10-sky"),),
    "moon": (("The moon is bright.", "月亮很亮。", "curated:g2u10-moon"),),
    "sun": (("The sun is big.", "太阳很大。", "curated:g2u10-sun"),),
    "star": (("I can see a star.", "我看见一颗星星。", "curated:g2u10-star"),),
    "snake": (("The snake is long.", "蛇很长。", "curated:g2u10-snake"),),
    "king": (("The lion is the king.", "狮子是国王。", "curated:g2u10-king"),),
    # --- 2 上 In the forest（cute「It is very …」自然，留模板）---
    "forest": (("We are in the forest.", "我们在森林里。", "curated:g2u11-forest"),),
    "fox": (("The fox is orange.", "狐狸是橙色的。", "curated:g2u11-fox"),),
    "meat": (("The lion eats meat.", "狮子吃肉。", "curated:g2u11-meat"),),
    "hippo": (("The hippo is big.", "河马很大。", "curated:g2u11-hippo"),),
    "grass": (("The grass is green.", "草是绿色的。", "curated:g2u11-grass"),),
    "wild": (("Wild animals live in the forest.", "野生动物住在森林里。", "curated:g2u11-wild"),),
    "animal": (("What animal is it?", "它是什么动物？", "curated:g2u11-animal"),),
    "wow": (("Wow! A big elephant!", "哇！一头大象！", "curated:g2u11-wow"),),
    "so": (("The panda is so cute!", "熊猫这么可爱！", "curated:g2u11-so"),),
    "dove": (("The dove can fly.", "鸽子会飞。", "curated:g2u11-dove"),),
    "swan": (("The swan is white.", "天鹅是白色的。", "curated:g2u11-swan"),),
    "white": (("The moon is white.", "月亮是白色的。", "curated:g2u11-white"),),
    # --- 2 上 In the street（beautiful「It is very …」自然，留模板）---
    "street": (("The car is in the street.", "汽车在街上。", "curated:g2u12-street"),),
    "don't": (("Don't climb the tree!", "不要爬树！", "curated:g2u12-dont"),),
    "pick": (("Pick an apple, please.", "请摘一个苹果。", "curated:g2u12-pick"),),
    "flower": (("The flower is beautiful.", "花很美丽。", "curated:g2u12-flower"),),
    "climb": (("The monkey can climb.", "猴子会爬。", "curated:g2u12-climb"),),
    "tree": (("The tree is tall.", "树很高。", "curated:g2u12-tree"),),
    "park": (("We are in the park.", "我们在公园里。", "curated:g2u12-park"),),
    "cry": (("Don't cry, Danny.", "别哭，丹尼。", "curated:g2u12-cry"),),
    "yak": (("The yak has long hair.", "牦牛有长长的毛。", "curated:g2u12-yak"),),
    "zebra": (("The zebra is black and white.", "斑马是黑白色的。", "curated:g2u12-zebra"),),
    # --- 票 42 新版小学 4 册查无词组例句（一年级口语短句，中英对齐；tag 按册单元编）---
    "baozi": (("I eat baozi for breakfast.", "我早餐吃包子。", "curated:g1bn-u1-baozi"),),
    "ride a bike": (("I can ride a bike.", "我会骑自行车。", "curated:g1bn-u3-ride-bike"),),
    "ride a scooter": (("Look! I can ride a scooter.", "看！我会骑滑板车。", "curated:g1bn-u3-ride-scooter"),),
    "play football": (("We play football after school.", "放学后我们踢足球。", "curated:g1bn-u3-football"),),
    "toy plane": (("My toy plane can fly high.", "我的玩具飞机飞得很高。", "curated:g2an-u3-toy-plane"),),
    "toy bear": (("The toy bear is soft.", "玩具熊很软。", "curated:g2an-u3-toy-bear"),),
    "fruit shop": (("We buy apples at the fruit shop.", "我们在水果店买苹果。", "curated:g2an-u4-fruit-shop"),),
    "toy shop": (("The toy shop is big.", "玩具店很大。", "curated:g2an-u4-toy-shop"),),
    "play with lanterns": (("We play with lanterns at night.", "晚上我们玩灯笼。", "curated:g2an-u6-lanterns"),),
    "eat mooncakes": (("We eat mooncakes on Mid-Autumn Day.", "中秋节我们吃月饼。", "curated:g2an-u6-mooncakes"),),
    "solve riddles": (("Can you solve riddles?", "你会猜灯谜吗？", "curated:g2an-u6-riddles"),),
    "look at the moon": (("We look at the moon together.", "我们一起赏月。", "curated:g2an-u6-moon"),),
    "wash my hands": (("I wash my hands before dinner.", "晚饭前我洗手。", "curated:g2bn-u2-wash-hands"),),
    "brush my teeth": (("I brush my teeth every morning.", "我每天早上刷牙。", "curated:g2bn-u2-brush-teeth"),),
    "wash my face": (("I wash my face in the morning.", "我早上洗脸。", "curated:g2bn-u2-wash-face"),),
    "do paper-cutting": (("We do paper-cutting in the club.", "我们在社团里剪纸。", "curated:g2bn-u3-paper-cutting"),),
    "do the lion dance": (("They can do the lion dance.", "他们会舞狮。", "curated:g2bn-u3-lion-dance"),),
    "kick a shuttlecock": (("I can kick a shuttlecock.", "我会踢毽子。", "curated:g2bn-u3-shuttlecock"),),
    # --- 票 43 旧版 5 下/6 下词组例句（五年级语境短句，中英对齐）---
    "be full of": (("The box is full of toys.", "盒子里装满了玩具。", "curated:g5b-u1-full-of"),),
    "wear glasses": (("My grandpa wears glasses.", "我爷爷戴眼镜。", "curated:g5b-u2-wear-glasses"),),
    "do exercise": (("We do exercise every day.", "我们每天锻炼。", "curated:g5b-u3-do-exercise"),),
    "be weak in": (("I am weak in maths.", "我数学比较弱。", "curated:g5b-u3-weak-in"),),
    "not any more": (("I don't cry any more.", "我不再哭了。", "curated:g5b-u3-not-any-more"),),
    "do a survey": (("Let's do a survey about hobbies.", "我们做个爱好调查吧。", "curated:g5b-u4-survey"),),
    "act out": (("We act out the story.", "我们表演这个故事。", "curated:g5b-u4-act-out"),),
    "see a film": (("Let's see a film tonight.", "今晚我们去看电影吧。", "curated:g5b-u5-see-film"),),
    "row a boat": (("Can you row a boat?", "你会划船吗？", "curated:g5b-u5-row-boat"),),
    "go swimming": (("I go swimming on Sundays.", "我周日去游泳。", "curated:g5b-u6-go-swimming"),),
    "all year round": (("It is warm all year round there.", "那里一年到头都很暖和。", "curated:g5b-u6-year-round"),),
    "school gate": (("Meet me at the school gate.", "在校门口等我。", "curated:g5b-u7-school-gate"),),
    "art room": (("We draw in the art room.", "我们在美术室画画。", "curated:g5b-u7-art-room"),),
    "meeting room": (("The meeting room is big.", "会议室很大。", "curated:g5b-u7-meeting-room"),),
    "try on": (("Try on the red coat.", "试试这件红外套。", "curated:g5b-u8-try-on"),),
    "put on": (("Put on your scarf.", "围上你的围巾。", "curated:g5b-u8-put-on"),),
    "have a headache": (("I have a headache.", "我头疼。", "curated:g5b-u9-headache"),),
    "have a fever": (("He has a fever today.", "他今天发烧了。", "curated:g5b-u9-fever"),),
    "have a toothache": (("I have a toothache.", "我牙疼。", "curated:g5b-u9-toothache"),),
    "have a meeting": (("They have a meeting at nine.", "他们九点开会。", "curated:g5b-u9-meeting"),),
    "pull out": (("The dentist pulled out my tooth.", "牙医拔了我的牙。", "curated:g5b-u9-pull-out"),),
    "far away from": (("My home is far away from school.", "我家离学校很远。", "curated:g5b-u10-far-away"),),
    "at the end of": (("We rest at the end of the day.", "我们在一天结束时休息。", "curated:g5b-u10-end-of"),),
    "no entry": (("The door says 'No entry'.", "门上写着「禁止进入」。", "curated:g5b-u11-no-entry"),),
    "be kind to": (("Be kind to animals.", "对动物要友善。", "curated:g5b-u12-kind-to"),),
    "get in": (("Farmers get in the rice in autumn.", "农民秋天收稻子。", "curated:g6b-u2-get-in"),),
    "online": (("I read books online.", "我在网上读书。", "curated:g6b-u2-online"),),
    "chinese ink painting": (("Chinese ink painting is beautiful.", "中国水墨画很美。", "curated:g6b-u4-ink-painting"),),
    "on the right": (("The bank is on the right.", "银行在右边。", "curated:g6b-u8-on-right"),),
    "model house": (("This is a model house.", "这是一个模型房子。", "curated:g6b-u3-model-house"),),
    "long race": (("He won the long race.", "他赢了长跑。", "curated:g6b-u6-long-race"),),
    "short race": (("The short race is exciting.", "短跑很激动人心。", "curated:g6b-u6-short-race"),),
    "swimming goggles": (("Don't forget your swimming goggles.", "别忘了你的泳镜。", "curated:g6b-u6-goggles"),),
    "praise for": (("Mum praised me for my homework.", "妈妈因作业表扬了我。", "curated:g6b-u7-praise-for"),),
    "no smoking": (("This is a no smoking area.", "这是禁烟区。", "curated:g6b-u8-no-smoking"),),
    "no swimming": (("The sign means 'No swimming'.", "这个标志意思是「禁止游泳」。", "curated:g6b-u8-no-swimming"),),
    "pen holder": (("The pen holder is on my desk.", "笔筒在我书桌上。", "curated:g6b-u5-pen-holder"),),
    "jack-o'-lantern": (("We make a jack-o'-lantern.", "我们做一个南瓜灯。", "curated:g6b-u11-jack-o-lantern"),),
    # --- 票 45 初中词组例句（模板句会不通顺的功能语/动词短语；名词复合词留模板——票 22 纪律）---
    "turn to somebody for help": (("You can turn to teachers for help.", "你可以向老师求助。", "curated:g7a-turn-to"),),
    "be willing to do something": (("He is willing to help others.", "他愿意帮助别人。", "curated:g7a-willing"),),
    "medium height": (("She is of medium height.", "她中等身高。", "curated:g7a-medium-height"),),
    "rise into": (("The balloon rises into the sky.", "气球升上天空。", "curated:g7a-rise-into"),),
    "cry oneself to sleep": (("The baby cried himself to sleep.", "宝宝哭着睡着了。", "curated:g7a-cry-sleep"),),
    "take somebody's place": (("Nothing can take your place.", "没有什么能代替你。", "curated:g7a-take-place"),),
    "have picnics": (("We have picnics in spring.", "春天我们去野餐。", "curated:g7a-picnics"),),
    "work one's land": (("Farmers work their land every day.", "农民每天耕种土地。", "curated:g7a-work-land"),),
    "solar term": (("There are 24 solar terms in a year.", "一年有 24 个节气。", "curated:g7a-solar-term"),),
    "be divided into": (("The class is divided into four groups.", "班级被分成四组。", "curated:g7a-divided"),),
    "play an important part in": (("Water plays an important part in our lives.", "水在我们的生活中起重要作用。", "curated:g7a-important-part"),),
    "fact file": (("Read the fact file about pandas.", "读一读熊猫资料卡。", "curated:g7a-fact-file"),),
    "be covered by": (("The ground is covered by snow.", "地面被雪覆盖。", "curated:g7a-covered"),),
    "as far as we know": (("As far as we know, he is fine.", "据我们所知，他很好。", "curated:g7a-as-far-as"),),
    "what's more": (("It's cheap. What's more, it's good.", "它便宜，而且质量好。", "curated:g7a-whats-more"),),
    "get into orbit": (("The satellite gets into orbit.", "卫星进入轨道。", "curated:g7a-orbit"),),
    "add to": (("Add some sugar to the tea.", "往茶里加点糖。", "curated:g7a-add-to"),),
    "a waste of time": (("Watching TV all day is a waste of time.", "整天看电视是浪费时间。", "curated:g7a-waste-time"),),
    "lead (somebody) to": (("The map led us to the station.", "地图把我们带到了车站。", "curated:g7b-lead-to"),),
    "have something in common": (("We have a lot in common.", "我们有很多共同点。", "curated:g7b-in-common"),),
    "devote yourself to": (("She devoted herself to teaching.", "她投身于教学。", "curated:g7b-devote"),),
    "go back a long way": (("These traditions go back a long way.", "这些传统由来已久。", "curated:g8a-long-way"),),
    "bring big changes to": (("Phones have brought big changes to our lives.", "手机给我们的生活带来巨变。", "curated:g8a-big-changes"),),
    "snake its way": (("The river snakes its way through the town.", "小河蜿蜒穿过小镇。", "curated:g8a-snake-way"),),
    "make jokes about": (("Don't make jokes about others.", "不要拿别人开玩笑。", "curated:g8a-jokes"),),
    "have no choice but to do": (("I had no choice but to wait.", "我别无选择只能等。", "curated:g8a-no-choice"),),
    "cheer somebody up": (("Let's cheer him up.", "我们让他振作起来。", "curated:g8b-cheer-up"),),
    "raise one's spirits": (("Music raises my spirits.", "音乐能提振我的精神。", "curated:g8b-spirits"),),
    "hold something up": (("Hold your hand up if you know.", "知道就举手。", "curated:g8b-hold-up"),),
    "make a good impression on": (("First, make a good impression on others.", "首先要给别人留下好印象。", "curated:g8b-impression"),),
    "have an influence on": (("Friends have an influence on us.", "朋友对我们有影响。", "curated:g8b-influence"),),
    "at risk of": (("The animals are at risk of dying out.", "这些动物有灭绝的风险。", "curated:g8b-at-risk"),),
    "take one's eyes off something": (("I can't take my eyes off the painting.", "我的视线离不开这幅画。", "curated:g8b-eyes-off"),),
    "neither nor": (("Neither he nor I knew the answer.", "他和我都不知道答案。", "curated:g8b-neither-nor"),),
    "in one sitting": (("I read the book in one sitting.", "我一口气读完了这本书。", "curated:g8b-one-sitting"),),
    "in the mood": (("I'm in the mood for a walk.", "我有心情散散步。", "curated:g8b-mood"),),
    "be at one with": (("He feels at one with nature.", "他感到与自然融为一体。", "curated:g8b-at-one"),),
    "shoot dead": (("The hunter shot the wolf dead.", "猎人射杀了狼。", "curated:g8b-shoot-dead"),),
    "without a care in the world": (("Kids play without a care in the world.", "孩子们无忧无虑地玩。", "curated:g8b-without-care"),),
    "lose one's life": (("He lost his life in the war.", "他在战争中丧生。", "curated:g8b-lose-life"),),
    "cannot afford to": (("We cannot afford to lose the game.", "我们输不起这场比赛。", "curated:g8b-cannot-afford"),),
    "in fear": (("The mouse ran away in fear.", "老鼠吓得逃走了。", "curated:g8b-in-fear"),),
    "with something in mind": (("He spoke with the future in mind.", "他说话时想着未来。", "curated:g9a-in-mind"),),
    "go straight to": (("Go straight to the office.", "径直去办公室。", "curated:g9a-straight-to"),),
    "get something across": (("Good stories get ideas across.", "好故事能把想法讲清楚。", "curated:g9a-across"),),
    "fresh in one's memory": (("That day is still fresh in my memory.", "那一天我仍记忆犹新。", "curated:g9a-fresh"),),
    "get addicted to": (("Don't get addicted to games.", "不要沉迷游戏。", "curated:g9a-addicted"),),
    "be in charge of": (("Who is in charge of the club?", "谁负责这个社团？", "curated:g9a-in-charge"),),
    "drive somebody mad": (("The noise drives me mad.", "噪音让我抓狂。", "curated:g9a-mad"),),
    "mess something up": (("Don't mess up your room.", "别把房间搞乱。", "curated:g9a-mess-up"),),
    "hit it off with somebody": (("They hit it off at first.", "他们一见如故。", "curated:g9a-hit-off"),),
    "fall out with somebody": (("He fell out with his best friend.", "他和挚友闹翻了。", "curated:g9a-fall-out"),),
    "feel ashamed of": (("Don't feel ashamed of mistakes.", "不要为错误感到羞愧。", "curated:g9a-ashamed"),),
    "shine down upon somebody": (("The sun shone down upon us.", "阳光照在我们身上。", "curated:g9a-shine-down"),),
    "carry on with something": (("Carry on with your work.", "继续你的工作。", "curated:g9a-carry-on"),),
    "get tired": (("I get tired after running.", "跑步后我会累。", "curated:g9a-get-tired"),),
    "with a spring in one's step": (("He walked with a spring in his step.", "他步履轻快地走着。", "curated:g9a-spring-step"),),
    "pass something down": (("The story was passed down for years.", "这个故事传了很多年。", "curated:g9a-pass-down"),),
    "fix one's eyes on": (("She fixed her eyes on the book.", "她凝视着书。", "curated:g9a-fix-eyes"),),
    "have no time to do": (("I have no time to play today.", "我今天没时间玩。", "curated:g9b-no-time"),),
    "be dying to": (("I'm dying to see you.", "我迫不及待想见你。", "curated:g9b-dying-to"),),
    "can't wait to": (("I can't wait to open the box.", "我等不及要打开盒子。", "curated:g9b-cant-wait"),),
    "cancel out": (("The two sounds cancel out.", "两个声音抵消了。", "curated:g9b-cancel-out"),),
    "look on the bright side": (("Look on the bright side of life.", "看到生活好的一面。", "curated:g9b-bright-side"),),
    "be busy with": (("I'm busy with my homework.", "我忙于作业。", "curated:g9b-busy-with"),),
    # --- 高中 7 本查无兜底（票 46，2026-11-05；专名百科式＋短语自然例句）---
    "a chorus of": (("They cheered in a chorus of voices.", "他们齐声欢呼。", "curated:senior-chorus-of"),),
    "absorbed in": (("She was absorbed in her book.", "她全神贯注地看书。", "curated:senior-absorbed-in"),),
    "addicted to": (("He is addicted to computer games.", "他对电脑游戏很入迷。", "curated:senior-addicted-to"),),
    "appeal to": (("The cartoon appeals to children.", "这部动画片很吸引孩子。", "curated:senior-appeal-to"),),
    "as far as i am concerned": (("As far as I am concerned, the plan works well.", "就我而言，这个计划很可行。", "curated:senior-as-far-as"),),
    "bank of canton": (("Bank of Canton is an old building in San Francisco's Chinatown.", "广东银行是旧金山唐人街的一座老建筑。", "curated:senior-bank-of-canton"),),
    "be attracted to": (("She is attracted to the colourful kites.", "她被五颜六色的风筝吸引了。", "curated:senior-be-attracted-to"),),
    "be comprised of": (("The team is comprised of twelve players.", "这支队伍由十二名队员组成。", "curated:senior-be-comprised-of"),),
    "bird field guide": (("A bird field guide helps us tell birds apart.", "鸟类图鉴帮我们分辨鸟类。", "curated:senior-bird-field-guide"),),
    "blog post": (("She wrote a blog post about her trip.", "她写了一篇关于旅行的博客文章。", "curated:senior-blog-post"),),
    "bounce around": (("The ball bounced around the yard.", "球在院子里弹来弹去。", "curated:senior-bounce-around"),),
    "bunol": (("Bunol is a small town in Spain.", "布尼奥尔是西班牙的一个小镇。", "curated:senior-bunol"),),
    "butchart gardens": (("Butchart Gardens is a famous garden in Canada.", "布查特花园是加拿大的一座著名花园。", "curated:senior-butchart-gardens"),),
    "chandra theeravit": (("Chandra Theeravit was a survivor of the tsunami.", "钱德拉·特拉维是那场海啸的幸存者。", "curated:senior-chandra"),),
    "chiwen": (("Chiwen is a dragon-like animal on old Chinese roofs.", "鸱吻是中国古建筑屋脊上的龙形兽。", "curated:senior-chiwen"),),
    "clearing after snow on a mountain pass": (("Clearing After Snow on a Mountain Pass is an ink painting from the Ming Dynasty.", "《函关雪霁图》是一幅明代水墨画。", "curated:senior-clearing-snow"),),
    "cm": (("The pencil is 15 cm long.", "这支铅笔长 15 厘米。", "curated:senior-cm"),),
    "comfort zone": (("Try new things and leave your comfort zone.", "尝试新事物，走出舒适区。", "curated:senior-comfort-zone"),),
    "coming of age day": (("Japan celebrates Coming of Age Day in January.", "日本在一月庆祝成人节。", "curated:senior-coming-of-age"),),
    "commit oneself to do": (("He committed himself to finish the work on time.", "他保证按时完成工作。", "curated:senior-commit-oneself"),),
    "concerned about": (("Mum is concerned about my study.", "妈妈为我的学习担忧。", "curated:senior-concerned-about"),),
    "cost an arm and a leg": (("The new phone cost an arm and a leg.", "这部新手机花了一大笔钱。", "curated:senior-cost-arm-leg"),),
    "cpr": (("He learned CPR at school.", "他在学校学了心肺复苏。", "curated:senior-cpr"),),
    "credit card": (("Dad paid with a credit card.", "爸爸用信用卡付款。", "curated:senior-credit-card"),),
    "cyberbully": (("Never cyberbully others online.", "网上决不欺凌他人。", "curated:senior-cyberbully"),),
    "dim sim": (("Try a dim sim at the food fair.", "在美食节上尝个澳式点心吧。", "curated:senior-dim-sim"),),
    "donate to": (("They donated books to the village school.", "他们把书捐给了乡村学校。", "curated:senior-donate-to"),),
    "electric shock": (("Never touch a broken wire, or you may get an electric shock.", "别碰断了的电线，否则可能触电。", "curated:senior-electric-shock"),),
    "elon musk": (("Elon Musk founded a rocket company.", "埃隆·马斯克创办了一家火箭公司。", "curated:senior-elon-musk"),),
    "eric whitacre": (("Eric Whitacre is the founder of the virtual choir.", "埃里克·惠塔克是虚拟合唱团的创始人。", "curated:senior-eric-whitacre"),),
    "face up": (("Put the card face up on the table.", "把卡片面朝上放在桌上。", "curated:senior-face-up"),),
    "feeling from mountain and water": (("Feeling from Mountain and Water is a famous ink animation.", "《山水情》是一部著名的水墨动画。", "curated:senior-mountain-water"),),
    "flow chart": (("Draw a flow chart to show your plan.", "画一张流程图展示你的计划。", "curated:senior-flow-chart"),),
    "frank wild": (("Frank Wild stayed with the crew on the island.", "弗兰克·怀尔德和队员们留在了岛上。", "curated:senior-frank-wild"),),
    "frank worsley": (("Frank Worsley sailed a small boat across the wild sea.", "弗兰克·沃斯利驾小船穿越了狂暴的大海。", "curated:senior-frank-worsley"),),
    "fred hoyle": (("Fred Hoyle named the big bang theory.", "大爆炸理论这个名字出自弗雷德·霍伊尔。", "curated:senior-fred-hoyle"),),
    "freezing cold": (("The water was freezing cold.", "水冷得刺骨。", "curated:senior-freezing-cold"),),
    "geothermal park": (("The geothermal park is full of hot pools.", "地热公园里到处是热水池。", "curated:senior-geothermal-park"),),
    "giverny": (("Monet painted his garden in Giverny.", "莫奈在吉维尼画他的花园。", "curated:senior-giverny"),),
    "have an urge to": (("She had an urge to open the box.", "她有一股想打开盒子的冲动。", "curated:senior-have-urge"),),
    "head to": (("We headed to the beach at noon.", "我们中午动身去了海边。", "curated:senior-head-to"),),
    "heimlich manoeuvre": (("The Heimlich manoeuvre can save a choking person.", "海姆立克急救法能救被噎住的人。", "curated:senior-heimlich"),),
    "help somebody to one's feet": (("The nurse helped the old man to his feet.", "护士扶老人站起身来。", "curated:senior-help-to-feet"),),
    "henry adams": (("Henry Adams got a million pound bank note.", "亨利·亚当斯得到了一张百万英镑的钞票。", "curated:senior-henry-adams"),),
    "henry norman bethune": (("Henry Norman Bethune worked as a doctor in China.", "亨利·诺曼·白求恩在中国当过医生。", "curated:senior-bethune"),),
    "high-end": (("They sell high-end cameras.", "他们卖高端相机。", "curated:senior-high-end"),),
    "huangguoshu waterfall": (("Huangguoshu Waterfall is in Guizhou, China.", "黄果树瀑布在中国贵州。", "curated:senior-huangguoshu"),),
    "hubert hudson": (("Hubert Hudson was a member of the ship crew.", "休伯特·赫德森是船队的一员。", "curated:senior-hubert-hudson"),),
    "hurricane katrina": (("Hurricane Katrina hit New Orleans in 2005.", "飓风卡特里娜 2005 年袭击了新奥尔良。", "curated:senior-katrina"),),
    "iconic": (("The Eiffel Tower is an iconic building.", "埃菲尔铁塔是标志性的建筑。", "curated:senior-iconic"),),
    "illegally": (("He parked illegally by the road.", "他非法停在了路边。", "curated:senior-illegally"),),
    "in a league of one's own": (("As a cook, Grandma is in a league of her own.", "论做饭，奶奶独领风骚。", "curated:senior-league-own"),),
    "in closing": (("In closing, thank you all for coming.", "最后，感谢各位的到来。", "curated:senior-in-closing"),),
    "in shock": (("After the accident, he was in shock.", "事故之后，他处于震惊之中。", "curated:senior-in-shock"),),
    "in the open air": (("We slept in the open air.", "我们睡在户外。", "curated:senior-open-air"),),
    "in this sense": (("In this sense, failure is a teacher.", "从这个意义上讲，失败是一位老师。", "curated:senior-in-this-sense"),),
    "inner mongolia autonomous region": (("The Naadam Festival is held in the Inner Mongolia Autonomous Region.", "那达慕大会在内蒙古自治区举行。", "curated:senior-inner-mongolia"),),
    "iv needle": (("The nurse put an IV needle in his arm.", "护士把静脉注射针扎进了他的手臂。", "curated:senior-iv-needle"),),
    "jade rabbit": (("The Jade Rabbit rover drove on the moon.", "“玉兔”号月球车在月球上行驶。", "curated:senior-jade-rabbit"),),
    "jan tchamani": (("Jan Tchamani started an IT club for older people.", "简·查马尼为老年人创办了信息技术俱乐部。", "curated:senior-jan-tchamani"),),
    "jean anthelme brillat-savarin": (("Jean Anthelme Brillat-Savarin was a famous French food writer.", "布里亚-萨瓦兰是著名的法国美食作家。", "curated:senior-brillat-savarin"),),
    "jean-philippe": (("Jean-Philippe is a character in the travel journal.", "让-菲利普是游记里的人物。", "curated:senior-jean-philippe"),),
    "john a. logan": (("John A. Logan helped start Memorial Day in the USA.", "约翰·A·洛根推动设立了美国阵亡将士纪念日。", "curated:senior-john-logan"),),
    "join to": (("This bridge joins the island to the city.", "这座桥把小岛和城市连接起来。", "curated:senior-join-to"),),
    "journey to the west": (("Journey to the West is a classic Chinese novel.", "《西游记》是中国经典小说。", "curated:senior-journey-west"),),
    "keep balance": (("The boy stretched out his arms to keep balance.", "男孩张开双臂保持平衡。", "curated:senior-keep-balance"),),
    "keep somebody company": (("The little dog keeps grandma company.", "小狗陪伴着奶奶。", "curated:senior-keep-company"),),
    "keep your eyes open for": (("Keep your eyes open for the road sign.", "留意路牌。", "curated:senior-eyes-open"),),
    "la tomatina": (("People throw tomatoes at each other at La Tomatina.", "在番茄大战上人们互相扔西红柿。", "curated:senior-la-tomatina"),),
    "lake louise": (("Lake Louise is a blue lake in the mountains.", "路易斯湖是山中的一汪蓝色湖泊。", "curated:senior-lake-louise"),),
    "lake titicaca": (("Lake Titicaca lies high in the mountains.", "的的喀喀湖高卧在群山之中。", "curated:senior-lake-titicaca"),),
    "lamb kebab": (("The lamb kebab smells great.", "烤羊肉串闻起来真香。", "curated:senior-lamb-kebab"),),
    "lao zi": (("Lao Zi was a great thinker in ancient China.", "老子是中国古代伟大的思想家。", "curated:senior-lao-zi"),),
    "leave alone": (("Leave the sleeping dog alone.", "别打扰睡着的狗。", "curated:senior-leave-alone"),),
    "lionel greenstreet": (("Lionel Greenstreet was a member of the ship crew.", "莱昂内尔·格林斯特里特是船队的一员。", "curated:senior-lionel-greenstreet"),),
    "lux aurumque": (("Lux Aurumque is a famous virtual choir song.", "《金色光芒》是一首著名的虚拟合唱团歌曲。", "curated:senior-lux-aurumque"),),
    "make a bet": (("Let's make a bet on the final result.", "我们就最后结果打个赌吧。", "curated:senior-make-bet"),),
    "make fire": (("They learned how to make fire in the wild.", "他们学会了在野外生火。", "curated:senior-make-fire"),),
    "make inferences": (("We can make inferences from the facts.", "我们可以根据事实做出推断。", "curated:senior-make-inferences"),),
    "manuka honey": (("Manuka honey is made in New Zealand.", "麦卢卡蜂蜜产自新西兰。", "curated:senior-manuka-honey"),),
    "marie curie": (("Marie Curie won two Nobel Prizes.", "玛丽·居里两次获得诺贝尔奖。", "curated:senior-marie-curie"),),
    "merry christmas!": (("The children sang “Merry Christmas!” together.", "孩子们一起唱“圣诞快乐！”。", "curated:senior-merry-christmas"),),
    "moral dilemma": (("The story begins with a moral dilemma.", "故事以一个道德困境开篇。", "curated:senior-moral-dilemma"),),
    "mouth-to-mouth rescue breathing": (("Mouth-to-mouth rescue breathing helps a person breathe again.", "口对口人工呼吸能帮助人恢复呼吸。", "curated:senior-mouth-to-mouth"),),
    "napa valley": (("Napa Valley is famous for its wine.", "纳帕谷以葡萄酒闻名。", "curated:senior-napa-valley"),),
    "neil armstrong": (("Neil Armstrong was the first man to walk on the moon.", "尼尔·阿姆斯特朗是第一个登上月球的人。", "curated:senior-armstrong"),),
    "neuschwanstein castle": (("Neuschwanstein Castle is in southern Germany.", "新天鹅堡在德国南部。", "curated:senior-neuschwanstein"),),
    "non-newtonian fluid": (("Cornstarch and water can make a non-Newtonian fluid.", "玉米淀粉加水能调成非牛顿流体。", "curated:senior-non-newtonian"),),
    "on a basis": (("We meet on a weekly basis.", "我们每周见面一次。", "curated:senior-on-a-basis"),),
    "overstatement": (("It is an overstatement to call him a genius.", "说他是天才有点夸张。", "curated:senior-overstatement"),),
    "owe something to somebody": (("He owes his success to his team.", "他把成功归功于团队。", "curated:senior-owe-to"),),
    "peak season": (("Hotel rooms cost more in peak season.", "旺季时酒店房间更贵。", "curated:senior-peak-season"),),
    "peking union medical college": (("Lin Qiaozhi studied at Peking Union Medical College.", "林巧稚曾就读于北京协和医学院。", "curated:senior-peking-union"),),
    "perce blackborow": (("Perce Blackborow hid on the ship to join the trip.", "珀西·布莱克博罗藏在船上偷偷加入了探险。", "curated:senior-perce-blackborow"),),
    "portia langham": (("Portia Langham is a character in the play.", "波希亚·兰厄姆是剧中人物。", "curated:senior-portia-langham"),),
    "portsmouth square": (("Portsmouth Square is a lively square in San Francisco.", "花园角广场是旧金山一个热闹的广场。", "curated:senior-portsmouth-square"),),
    "pray that": (("They prayed that the storm would pass.", "他们祈求风暴过去。", "curated:senior-pray-that"),),
    "prefer to": (("I prefer tea to coffee.", "比起咖啡我更喜欢茶。", "curated:senior-prefer-to"),),
    "proceed to": (("After a short break, we proceeded to the next hall.", "短暂休息后，我们接着去了下一个展厅。", "curated:senior-proceed-to"),),
    "real estate agent": (("The real estate agent showed us three flats.", "房产经纪人带我们看了三套房子。", "curated:senior-real-estate"),),
    "red braised pork": (("Grandma's red braised pork is delicious.", "奶奶做的红烧肉很好吃。", "curated:senior-red-braised-pork"),),
    "relay to": (("Please relay the message to your teacher.", "请把口信转达给老师。", "curated:senior-relay-to"),),
    "resident physician": (("The resident physician works long hours at the hospital.", "这位住院医师在医院工作很长时间。", "curated:senior-resident-physician"),),
    "robert louis stevenson": (("Robert Louis Stevenson wrote Treasure Island.", "罗伯特·路易斯·史蒂文森写了《金银岛》。", "curated:senior-rl-stevenson"),),
    "saint basil's cathedral": (("Saint Basil's Cathedral stands on Red Square.", "圣瓦西里大教堂矗立在红场上。", "curated:senior-saint-basil"),),
    "sarek national park": (("Sarek National Park is in northern Sweden.", "萨勒克国家公园在瑞典北部。", "curated:senior-sarek"),),
    "series of": (("A series of questions came up in the meeting.", "会议中出现了一连串问题。", "curated:senior-series-of"),),
    "set an example": (("Teachers set an example for students.", "老师为学生树立榜样。", "curated:senior-set-example"),),
    "sign up for": (("I signed up for the chess club.", "我报名参加了国际象棋社。", "curated:senior-sign-up-for"),),
    "sonnets from the portuguese": (("Sonnets from the Portuguese is a famous love poem collection.", "《葡萄牙人十四行诗》是著名的爱情诗集。", "curated:senior-sonnets"),),
    "south georgia island": (("The crew reached South Georgia Island by boat.", "队员们乘小船到达了南乔治亚岛。", "curated:senior-south-georgia"),),
    "soyuz 11": (("Soyuz 11 flew to the first space station in 1971.", "联盟 11 号 1971 年飞往第一座空间站。", "curated:senior-soyuz-11"),),
    "st lawrence river": (("The St Lawrence River flows into the sea in Canada.", "圣劳伦斯河在加拿大流入大海。", "curated:senior-st-lawrence"),),
    "stephen hawking": (("Stephen Hawking studied black holes.", "史蒂芬·霍金研究黑洞。", "curated:senior-hawking"),),
    "sulphuric pool": (("The sulphuric pools are bright yellow.", "硫黄池是明黄色的。", "curated:senior-sulphuric-pool"),),
    "sumatra island": (("The tsunami hit Sumatra Island hard.", "海啸重创了苏门答腊岛。", "curated:senior-sumatra"),),
    "superior to": (("This model is superior to the old one.", "这个型号比旧的好。", "curated:senior-superior-to"),),
    "tadpoles searching for mother": (("Tadpoles Searching for Mother is China's first ink animation.", "《小蝌蚪找妈妈》是中国第一部水墨动画。", "curated:senior-tadpoles"),),
    "take for granted": (("Don't take your parents' love for granted.", "别把父母的爱当作理所当然。", "curated:senior-take-granted"),),
    "take out a loan": (("They took out a loan to buy a car.", "他们贷款买了一辆车。", "curated:senior-take-loan"),),
    "techno": (("Techno is fast electronic dance music.", "泰克诺是快节奏的电子舞曲。", "curated:senior-techno"),),
    "test out": (("The team will test out the new robot.", "团队将测试这台新机器人。", "curated:senior-test-out"),),
    "the amazon rainforest": (("The Amazon rainforest is the lungs of the earth.", "亚马孙雨林是地球之肺。", "curated:senior-amazon-rainforest"),),
    "the amish": (("The Amish farm without modern machines.", "阿米什人不用现代机器种田。", "curated:senior-amish"),),
    "the andes mountains": (("The Andes Mountains run along South America.", "安第斯山脉纵贯南美洲。", "curated:senior-andes"),),
    "the antarctic": (("Penguins live in the Antarctic.", "企鹅生活在南极地区。", "curated:senior-antarctic"),),
    "the arctic": (("Polar bears live in the Arctic.", "北极熊生活在北极地区。", "curated:senior-arctic"),),
    "the belt and road initiative": (("The Belt and Road Initiative links many countries.", "“一带一路”倡议连接了许多国家。", "curated:senior-belt-road"),),
    "the big bang theory": (("Many scientists accept the big bang theory.", "许多科学家接受大爆炸宇宙论。", "curated:senior-big-bang"),),
    "the cowboy's flute": (("The Cowboy's Flute is a classic ink animation.", "《牧笛》是经典水墨动画。", "curated:senior-cowboys-flute"),),
    "the crescent moon": (("The Crescent Moon is a poem collection by Tagore.", "《新月集》是泰戈尔的诗集。", "curated:senior-crescent-moon"),),
    "the eiffel tower": (("The Eiffel Tower stands in Paris.", "埃菲尔铁塔矗立在巴黎。", "curated:senior-eiffel"),),
    "the emerald isle": (("The Emerald Isle is another name for Ireland.", "绿宝石岛是爱尔兰的别称。", "curated:senior-emerald-isle"),),
    "the forbidden city": (("The Forbidden City is in the heart of Beijing.", "紫禁城位于北京市中心。", "curated:senior-forbidden-city"),),
    "the golden gate bridge": (("The Golden Gate Bridge is the symbol of San Francisco.", "金门大桥是旧金山的标志。", "curated:senior-golden-gate"),),
    "the inca empire": (("The Inca Empire once ruled the Andes.", "印加帝国曾统治安第斯山区。", "curated:senior-inca-empire"),),
    "the international space station": (("Astronauts live and work on the International Space Station.", "宇航员在国际空间站上生活和工作。", "curated:senior-iss"),),
    "the jet propulsion laboratory": (("The Jet Propulsion Laboratory sends rovers to Mars.", "喷气推进实验室向火星发射火星车。", "curated:senior-jpl"),),
    "the kremlin": (("The Kremlin stands in the heart of Moscow.", "克里姆林宫位于莫斯科市中心。", "curated:senior-kremlin"),),
    "the media": (("The media reported the news at once.", "媒体立即报道了这条新闻。", "curated:senior-the-media"),),
    "the middle ages": (("Castles were common in the Middle Ages.", "中世纪时城堡很常见。", "curated:senior-middle-ages"),),
    "the mission district": (("The Mission District is full of Mexican food and murals.", "传教区满是墨西哥美食和壁画。", "curated:senior-mission-district"),),
    "the naadam festival": (("The Naadam Festival shows Mongolian sports and culture.", "那达慕大会展示蒙古族的体育与文化。", "curated:senior-naadam"),),
    "the national people's congress": (("The National People's Congress meets in Beijing.", "全国人民代表大会在北京召开。", "curated:senior-npc"),),
    "the nile": (("The Nile runs through Egypt.", "尼罗河流经埃及。", "curated:senior-the-nile"),),
    "the normans": (("The Normans came from northern France.", "诺曼人来自法国北部。", "curated:senior-normans"),),
    "the north south pole": (("Scientists study the North South Pole regions.", "科学家研究南北极地区。", "curated:senior-north-south-pole"),),
    "the ob-gyn department": (("She works in the OB-GYN department.", "她在妇产科工作。", "curated:senior-ob-gyn"),),
    "the people's republic of china": (("The People's Republic of China was founded in 1949.", "中华人民共和国成立于 1949 年。", "curated:senior-prc"),),
    "the phantom of the opera": (("The Phantom of the Opera is a world-famous musical.", "《歌剧魅影》是世界闻名的音乐剧。", "curated:senior-phantom-opera"),),
    "the renaissance": (("The Renaissance began in Italy.", "文艺复兴始于意大利。", "curated:senior-renaissance"),),
    "the richmond district": (("Many Chinese families live in the Richmond District.", "许多华人家庭住在里士满区。", "curated:senior-richmond-district"),),
    "the south pole": (("Amundsen reached the South Pole first.", "阿蒙森第一个到达南极。", "curated:senior-south-pole"),),
    "the terracotta army": (("The Terracotta Army guards an emperor's tomb in Xi'an.", "兵马俑守卫着西安的一位皇帝陵墓。", "curated:senior-terracotta"),),
    "the upper class": (("Rich lords belonged to the upper class.", "富有的贵族属于上流社会。", "curated:senior-upper-class"),),
    "the uros": (("The Uros live on islands made of reeds.", "乌鲁斯人住在芦苇造的浮岛上。", "curated:senior-uros"),),
    "the ussr": (("The USSR sent the first man into space.", "苏联把第一名航天员送入太空。", "curated:senior-ussr"),),
    "the victorian era": (("Railways grew fast in the Victorian era.", "维多利亚时代铁路发展很快。", "curated:senior-victorian-era"),),
    "the wenhai scholarship": (("Lin Qiaozhi went to college on the Wenhai Scholarship.", "林巧稚靠“文海”奖学金上了大学。", "curated:senior-wenhai"),),
    "the world wide web": (("The World Wide Web changed our lives.", "万维网改变了我们的生活。", "curated:senior-www"),),
    "theoretical framework": (("The paper builds a theoretical framework for the study.", "论文为这项研究建立了理论框架。", "curated:senior-framework"),),
    "thomas orde-lees": (("Thomas Orde-Lees was a member of the ship crew.", "托马斯·奥德-利斯是船队的一员。", "curated:senior-orde-lees"),),
    "tibetan antelope": (("The Tibetan antelope lives on the high plains.", "藏羚羊生活在高原上。", "curated:senior-tibetan-antelope"),),
    "tin how temple": (("Tin How Temple is an old temple in San Francisco's Chinatown.", "天后古庙是旧金山唐人街的一座古庙。", "curated:senior-tin-how"),),
    "to extent": (("To some extent, I agree with you.", "在某种程度上我同意你的看法。", "curated:senior-to-extent"),),
    "to name but a few": (("He knows French, German and Japanese, to name but a few.", "他懂法语、德语、日语，仅举几例。", "curated:senior-name-but-few"),),
    "tom crean": (("Tom Crean was a brave Irish sailor.", "汤姆·克林是一位勇敢的爱尔兰水手。", "curated:senior-tom-crean"),),
    "turn somebody down": (("He asked her to the dance, but she turned him down.", "他邀她去舞会，但她拒绝了他。", "curated:senior-turn-down"),),
    "typhoon goni": (("Typhoon Goni was one of the strongest storms in 2020.", "台风“天鹅”是 2020 年最强风暴之一。", "curated:senior-typhoon-goni"),),
    "virtual choir": (("Eric Whitacre created the first virtual choir.", "埃里克·惠塔克创建了第一个虚拟合唱团。", "curated:senior-virtual-choir"),),
    "voyager 1": (("Voyager 1 has flown beyond the solar system.", "旅行者 1 号已飞出太阳系。", "curated:senior-voyager-1"),),
    "water pump": (("They fixed the village water pump.", "他们修好了村里的水泵。", "curated:senior-water-pump"),),
    "yuri gagarin": (("Yuri Gagarin was the first man in space.", "尤里·加加林是第一位进入太空的人。", "curated:senior-gagarin"),),
    "yangtze river dolphin": (("The Yangtze River dolphin lived only in China.", "白鳍豚曾只生活在中国。", "curated:senior-yangtze-dolphin"),),
    "no matter": (("No matter how hard it is, don't give up.", "无论多难，都不要放弃。", "curated:senior-no-matter"),),
    "cut out": (("Cut out the picture and stick it here.", "把图片剪下来贴在这里。", "curated:senior-cut-out"),),
    "compare with": (("Compare your answers with your partner's.", "把你的答案和同伴的比一比。", "curated:senior-compare-with"),),
    "date back to": (("This temple dates back to the Tang Dynasty.", "这座寺庙的历史可追溯到唐代。", "curated:senior-date-back"),),
    "bring to life": (("The paintings bring history to life.", "这些画作让历史鲜活起来。", "curated:senior-bring-life"),),
    "pretend to": (("He pretended to be asleep.", "他假装睡着了。", "curated:senior-pretend-to"),),
    "be about to": (("Hurry up! The film is about to begin.", "快点！电影就要开始了。", "curated:senior-be-about-to"),),
    "be willing to": (("He is willing to help others.", "他愿意帮助别人。", "curated:senior-be-willing-to"),),
    # --- 小学 3上-6上 查无兜底（票 44，2026-11-05；课本 Word list 词组/缩略语，五项）---
    "a (an)": (("I have a book and an apple.", "我有一本书和一个苹果。", "curated:primary-3a-a-an"),),
    "afraid (of)": (("The little mouse is afraid of the cat.", "小老鼠怕猫。", "curated:primary-3b-afraid-of"),),
    "bus driver": (("The bus driver drives our bus every day.", "公交车司机每天开我们的公交车。", "curated:primary-4a-bus-driver"),),
    "climb trees": (("Monkeys can climb trees very fast.", "猴子爬树爬得很快。", "curated:primary-4a-climb-trees"),),
    "grandfather (grandpa)": (("My grandfather is seventy years old.", "我爷爷七十岁了。", "curated:primary-4a-grandfather"),),
    "grandmother (grandma)": (("My grandmother cooks nice food.", "我奶奶做的饭菜很好吃。", "curated:primary-4a-grandmother"),),
    "at the weekend": (("We go to the park at the weekend.", "我们周末去公园。", "curated:primary-4b-weekend"),),
    "brush teeth": (("Brush your teeth before you go to bed.", "睡觉前要刷牙。", "curated:primary-4b-brush-teeth"),),
    "half past": (("It is half past seven.", "现在是七点半。", "curated:primary-4b-half-past"),),
    "have a party": (("We have a party on Children's Day.", "我们在儿童节举办聚会。", "curated:primary-4b-party"),),
    "have breakfast": (("I have breakfast at seven.", "我七点吃早餐。", "curated:primary-4b-breakfast"),),
    "have lunch": (("We have lunch at school.", "我们在学校吃午餐。", "curated:primary-4b-lunch"),),
    "be late for": (("Hurry up! Don't be late for school.", "快点！上学不要迟到。", "curated:primary-4b-late-for"),),
    "pe": (("We play football in PE.", "我们在体育课上踢足球。", "curated:primary-4b-pe"),),
    "play basketball": (("Yao Ming can play basketball very well.", "姚明篮球打得很好。", "curated:primary-4b-basketball"),),
    "play the guitar": (("My father can play the guitar.", "我爸爸会弹吉他。", "curated:primary-4b-guitar"),),
    "play the violin": (("She plays the violin every day.", "她每天拉小提琴。", "curated:primary-4b-violin"),),
    "play volleyball": (("They play volleyball on the beach.", "他们在海滩上打排球。", "curated:primary-4b-volleyball"),),
    "wash face": (("Wash your face and brush your teeth.", "洗洗脸，刷刷牙。", "curated:primary-4b-wash-face"),),
    "by bike": (("I go to school by bike.", "我骑自行车上学。", "curated:primary-5a-by-bike"),),
    "flower shop": (("Mum buys flowers at the flower shop.", "妈妈在花店买花。", "curated:primary-5a-flower-shop"),),
    "grow crops": (("Farmers grow crops in the fields.", "农民在田里种庄稼。", "curated:primary-5a-grow-crops"),),
    "make phone calls": (("Grandma makes phone calls to her friends.", "奶奶给她的朋友们打电话。", "curated:primary-5a-phone-calls"),),
    "model plane": (("Peter has a cool model plane.", "彼得有一架很酷的飞机模型。", "curated:primary-5a-model-plane"),),
    "play sport": (("We play sport after school.", "我们放学后做运动。", "curated:primary-5a-play-sport"),),
    "put out fires": (("Firemen put out fires.", "消防员灭火。", "curated:primary-5a-put-out-fires"),),
    "car museum": (("There are many old cars in the car museum.", "汽车博物馆里有很多老式汽车。", "curated:primary-6a-car-museum"),),
    "in the north of": (("Beijing is in the north of China.", "北京在中国的北部。", "curated:primary-6a-north-of"),),
    "insect museum": (("We see many butterflies in the insect museum.", "我们在昆虫博物馆看到很多蝴蝶。", "curated:primary-6a-insect-museum"),),
    "keep alive": (("Animals need food and water to keep alive.", "动物需要食物和水才能存活。", "curated:primary-6a-keep-alive"),),
    "many kinds of": (("There are many kinds of animals in the zoo.", "动物园里有许多种动物。", "curated:primary-6a-many-kinds"),),
    "model car": (("Joe makes a model car at home.", "乔在家做了一辆汽车模型。", "curated:primary-6a-model-car"),),
    "plant trees": (("We plant trees in spring.", "我们在春天植树。", "curated:primary-6a-plant-trees"),),
    "plastic bag": (("Please don't use plastic bags.", "请不要使用塑料袋。", "curated:primary-6a-plastic-bag"),),
    "south china tiger": (("The South China tiger is in danger.", "华南虎濒临灭绝。", "curated:primary-6a-south-china-tiger"),),
    "summer holiday": (("I will visit Beijing in the summer holiday.", "暑假我要去北京游玩。", "curated:primary-6a-summer-holiday"),),
    # --- 代词/功能词段（2026-11-08 her 例句报障全库纠正：pron 空模板后逐词 curated）---
    "it": (("It is a cat.", "它是一只猫。", "curated:p-pron-it"),),
    "these": (("These are my books.", "这些是我的书。", "curated:p-pron-these"),),
    "they": (("They are my friends.", "他们是我的朋友。", "curated:p-pron-they"),),
    "its": (("The cat eats its food.", "猫吃它的食物。", "curated:p-pron-its"),),
    "we": (("We are good friends.", "我们是好朋友。", "curated:p-pron-we"),),
    "our": (("This is our classroom.", "这是我们的教室。", "curated:p-pron-our"),),
    "some": (("I have some apples.", "我有一些苹果。", "curated:p-pron-some"),),
    "her": (("This is her book.", "这是她的书。", "curated:p-pron-her"),),
    "his": (("That is his schoolbag.", "那是他的书包。", "curated:p-pron-his"),),
    "him": (("I know him.", "我认识他。", "curated:p-pron-him"),),
    "them": (("Let's help them.", "让我们帮帮他们。", "curated:p-pron-them"),),
    "us": (("Come with us.", "跟我们一起来吧。", "curated:p-pron-us"),),
    "those": (("Those are green trees.", "那些是绿树。", "curated:p-pron-those"),),
    "whose": (("Whose bag is this?", "这是谁的书包？", "curated:p-pron-whose"),),
    "yours": (("This pen is yours.", "这支钢笔是你的。", "curated:p-pron-yours"),),
    "their": (("This is their classroom.", "这是他们的教室。", "curated:p-pron-their"),),
    "hers": (("This pen is hers.", "这支钢笔是她的。", "curated:p-pron-hers"),),
    "myself": (("I can do it myself.", "我自己能做这件事。", "curated:p-pron-myself"),),
    "theirs": (("The classroom is theirs.", "这间教室是他们的。", "curated:p-pron-theirs"),),
    "which": (("Which is your pen?", "哪支是你的钢笔？", "curated:p-pron-which"),),
    "something": (("There is something in the box.", "盒子里有东西。", "curated:p-pron-something"),),
    "anything": (("Is there anything in your bag?", "你的包里有什么东西吗？", "curated:p-pron-anything"),),
    "yourself": (("You can do it yourself.", "你自己能做这件事。", "curated:p-pron-yourself"),),
    "everyone": (("Everyone is here today.", "今天大家都到了。", "curated:p-pron-everyone"),),
    "himself": (("He can dress himself.", "他能自己穿衣服。", "curated:p-pron-himself"),),
    "themselves": (("They clean the room themselves.", "他们自己打扫房间。", "curated:p-pron-themselves"),),
    "whatever": (("You can eat whatever you like.", "你想吃什么就吃什么。", "curated:p-pron-whatever"),),
    # --- 词组模板误伤纠正（n. 模板对词组填不出自然句：make-up/switch-off 形）---
    "make up": (("They make up a story.", "他们编了个故事。", "curated:p-phr-make-up"),),
    "switch-off": (("Switch off the lights before you leave.", "离开前把灯关掉。", "curated:p-phr-switch-off"),),
}

# 逐词 curated 义项（票 17 全册校对轮，2026-11-01）：沪教牛津（深圳专版）一年级上
# 1 上全册 105 词逐词核（不抽检）。票 19（2026-11-01）滚动扩至二年级上：2 上 113 收词中
# 112 个 ECDICT 命中词逐词核（ride a bicycle 查无进 E7），其中 17 词与 1 上共享既有条目。
# 键＝normalize_word(词形)；值＝sense dict 序列
# （pos/gloss，≤2 条）。依据两类：教材语境通识 ＋ ECDICT 义项重排（首义＝教材核心义），
# 禁生造僻义；垃圾尾义（如 school「鱼群」、hamburger「德国港口」）裁除；pos 保留 ECDICT
# 原标注（am/is ECDICT 本无 pos，保持 None）。origin 不进 gloss（儿童卡面纯义），溯源
# 即本表（键＋票 17 报告对照表）。emoji 仍由 EMOJI_MAP 附加到 senses[0]，与 curated 兼容。
CURATED_SENSES: dict[str, tuple[dict, ...]] = {
    # --- U1 Hello ---
    "hello": ({"pos": "int.", "gloss": "你好"},),
    "hi": ({"pos": "int.", "gloss": "嗨"},),
    "goodbye": ({"pos": "int.", "gloss": "再见"},),
    "morning": ({"pos": "n.", "gloss": "早晨"}, {"pos": "n.", "gloss": "上午"}),
    "afternoon": ({"pos": "n.", "gloss": "下午"},),
    "i": ({"pos": "pron.", "gloss": "我"},),
    "am": ({"pos": None, "gloss": "是"},),
    "school": ({"pos": "n.", "gloss": "学校"},),
    "day": ({"pos": "n.", "gloss": "天、日子"}, {"pos": "n.", "gloss": "白天"}),
    # --- U2 My classmates（give 首义「给」＝票 14 P2 治本；a 裁 \r 残留与 [计] 域行）---
    "give": ({"pos": "vt.", "gloss": "给"},),
    "me": ({"pos": "pron.", "gloss": "我"},),
    "a": ({"pos": "art.", "gloss": "一个"},),
    "please": ({"pos": "adv.", "gloss": "请"},),
    "thank": ({"pos": "vt.", "gloss": "谢谢"}, {"pos": "n.", "gloss": "感谢"}),
    "you": ({"pos": "pron.", "gloss": "你、你们"},),
    "book": ({"pos": "n.", "gloss": "书"},),
    "ruler": ({"pos": "n.", "gloss": "尺子"},),
    "pencil": ({"pos": "n.", "gloss": "铅笔"},),
    "rubber": ({"pos": "n.", "gloss": "橡皮"},),
    "on": ({"pos": "prep.", "gloss": "在…上面"},),
    "sunday": ({"pos": "n.", "gloss": "星期日"},),
    "how": ({"pos": "adv.", "gloss": "怎样"}, {"pos": "adv.", "gloss": "多么"}),
    "nice": ({"pos": "a.", "gloss": "好的"},),
    # --- U3 My face ---
    "this": ({"pos": "pron.", "gloss": "这、这个"},),
    "is": ({"pos": None, "gloss": "是"},),
    "my": ({"pos": "pron.", "gloss": "我的"},),
    "face": ({"pos": "n.", "gloss": "脸"},),
    "mouth": ({"pos": "n.", "gloss": "嘴"},),
    "nose": ({"pos": "n.", "gloss": "鼻子"},),
    "eye": ({"pos": "n.", "gloss": "眼睛"},),
    "ear": ({"pos": "n.", "gloss": "耳朵"},),
    "touch": ({"pos": "vt.", "gloss": "摸"},),
    "your": ({"pos": "pron.", "gloss": "你的、你们的"},),
    "picture": ({"pos": "n.", "gloss": "图画"}, {"pos": "n.", "gloss": "照片"}),
    "look": ({"pos": "vi.", "gloss": "看"},),
    "no": ({"pos": "adv.", "gloss": "不"}, {"pos": "a.", "gloss": "没有"}),
    "not": ({"pos": "adv.", "gloss": "不"},),
    # --- U4 I can sing（can ECDICT 首行「装罐」为名词义误排首，重排 aux.）---
    "can": ({"pos": "aux.", "gloss": "会、能"},),
    "sing": ({"pos": "vi.", "gloss": "唱歌"},),
    "dance": ({"pos": "v.", "gloss": "跳舞"}, {"pos": "n.", "gloss": "舞蹈"}),
    "read": ({"pos": "v.", "gloss": "读"},),
    "draw": ({"pos": "vt.", "gloss": "画画"},),
    "what": ({"pos": "pron.", "gloss": "什么"},),
    "do": ({"pos": "v.", "gloss": "做"},),
    # --- U5 My family ---
    "who": ({"pos": "pron.", "gloss": "谁"},),
    "she": ({"pos": "pron.", "gloss": "她"},),
    "grandmother": ({"pos": "n.", "gloss": "（外）祖母"},),
    "he": ({"pos": "pron.", "gloss": "他"},),
    "father": ({"pos": "n.", "gloss": "父亲"},),
    "grandfather": ({"pos": "n.", "gloss": "（外）祖父"},),
    "mother": ({"pos": "n.", "gloss": "母亲"},),
    "yes": ({"pos": "adv.", "gloss": "是的"},),
    # --- U6 My friends ---
    "tall": ({"pos": "a.", "gloss": "高的"},),
    "short": ({"pos": "a.", "gloss": "短的"}, {"pos": "a.", "gloss": "矮的"}),
    "fat": ({"pos": "a.", "gloss": "胖的"},),
    "thin": ({"pos": "a.", "gloss": "瘦的"}, {"pos": "a.", "gloss": "薄的"}),
    "classmate": ({"pos": "n.", "gloss": "同班同学"},),
    "friend": ({"pos": "n.", "gloss": "朋友"},),
    # --- U7 Let's count（one pos 随数词族统一 num.，pron.「任何人」尾义裁）---
    "how many": ({"pos": None, "gloss": "多少、几个"},),
    "three": ({"pos": "num.", "gloss": "三"},),
    "two": ({"pos": "num.", "gloss": "二"},),
    "six": ({"pos": "num.", "gloss": "六"},),
    "one": ({"pos": "num.", "gloss": "一"},),
    "four": ({"pos": "num.", "gloss": "四"},),
    "five": ({"pos": "num.", "gloss": "五"},),
    "let's": ({"pos": "abbr.", "gloss": "让我们"},),
    "count": ({"pos": "vi.", "gloss": "数数"},),
    # --- U8 Apples, please（the 功能词义＝定冠词，ECDICT「那」误导裁除）---
    "apple": ({"pos": "n.", "gloss": "苹果"},),
    "pear": ({"pos": "n.", "gloss": "梨"},),
    "peach": ({"pos": "n.", "gloss": "桃子"},),
    "orange": ({"pos": "n.", "gloss": "橙子"}, {"pos": "a.", "gloss": "橙色的"}),
    "at": ({"pos": "prep.", "gloss": "在"},),
    "the": ({"pos": "art.", "gloss": "定冠词"},),
    "supermarket": ({"pos": "n.", "gloss": "超市"},),
    # --- U9 May I have a pie?（may 首义随教材核心用法 aux.「可以」，n. 五月退居第二）---
    "may": ({"pos": "aux.", "gloss": "可以"}, {"pos": "n.", "gloss": "五月"}),
    "have": ({"pos": "vt.", "gloss": "有"},),
    "pie": ({"pos": "n.", "gloss": "馅饼"},),
    "hamburger": ({"pos": "n.", "gloss": "汉堡包"},),
    "pizza": ({"pos": "n.", "gloss": "比萨饼"},),
    "cake": ({"pos": "n.", "gloss": "蛋糕"},),
    "snack": ({"pos": "n.", "gloss": "零食"}, {"pos": "n.", "gloss": "点心"}),
    "bar": ({"pos": "n.", "gloss": "条、棒"},),
    # --- U10 On the farm（peep 首义「偷看」＝票 17 裁定；拟声词义给儿童拟声汉字）---
    "moo": ({"pos": "vi.", "gloss": "哞（牛叫声）"},),
    "that": ({"pos": "a.", "gloss": "那、那个"},),
    "cow": ({"pos": "n.", "gloss": "奶牛"},),
    "chick": ({"pos": "n.", "gloss": "小鸡"},),
    "peep": ({"pos": "vi.", "gloss": "偷看"}, {"pos": "n.", "gloss": "吱吱声"}),
    "duck": ({"pos": "n.", "gloss": "鸭子"},),
    "pig": ({"pos": "n.", "gloss": "猪"},),
    "oink": ({"pos": "n.", "gloss": "哼哼（猪叫声）"},),
    "quack": ({"pos": "n.", "gloss": "嘎嘎（鸭叫声）"},),
    "cut": ({"pos": "vt.", "gloss": "切、剪"},),
    "stick": ({"pos": "vt.", "gloss": "贴"}, {"pos": "n.", "gloss": "棍、棒"}),
    # --- U11 In the zoo ---
    "monkey": ({"pos": "n.", "gloss": "猴子"},),
    "bear": ({"pos": "n.", "gloss": "熊"},),
    "panda": ({"pos": "n.", "gloss": "熊猫"},),
    "tiger": ({"pos": "n.", "gloss": "老虎"},),
    # --- U12 In the park（色词首义统一形容词「X色的」）---
    "colour": ({"pos": "n.", "gloss": "颜色"}, {"pos": "vt.", "gloss": "涂色"}),
    "yellow": ({"pos": "a.", "gloss": "黄色的"}, {"pos": "n.", "gloss": "黄色"}),
    "red": ({"pos": "a.", "gloss": "红色的"}, {"pos": "n.", "gloss": "红色"}),
    "blue": ({"pos": "a.", "gloss": "蓝色的"}, {"pos": "n.", "gloss": "蓝色"}),
    "green": ({"pos": "a.", "gloss": "绿色的"}, {"pos": "n.", "gloss": "绿色"}),
    "small": ({"pos": "a.", "gloss": "小的"},),
    "go": ({"pos": "vi.", "gloss": "去"},),
    "big": ({"pos": "a.", "gloss": "大的"},),
    # --- 2 上 Good morning（票 19 滚动校对轮，2026-11-01；沪教牛津深圳专版二年级上语境）---
    "good": ({"pos": "a.", "gloss": "好的"},),
    "evening": ({"pos": "n.", "gloss": "傍晚、晚上"},),
    "night": ({"pos": "n.", "gloss": "夜晚"},),
    "mum": ({"pos": "n.", "gloss": "妈妈"},),
    "today": ({"pos": "n.", "gloss": "今天"},),
    "very well": ({"pos": None, "gloss": "很好"},),
    "ant": ({"pos": "n.", "gloss": "蚂蚁"},),
    # --- 2 上 I'm Danny ---
    "boy": ({"pos": "n.", "gloss": "男孩"},),
    "girl": ({"pos": "n.", "gloss": "女孩"},),
    "name": ({"pos": "n.", "gloss": "名字"},),
    # --- 2 上 Are you Alice?（sorry 教材核心用法＝道歉 int.，ECDICT 形容词义退居第二）---
    "sorry": ({"pos": "int.", "gloss": "对不起"}, {"pos": "a.", "gloss": "难过的"}),
    "seven": ({"pos": "num.", "gloss": "七"},),
    "eight": ({"pos": "num.", "gloss": "八"},),
    "nine": ({"pos": "num.", "gloss": "九"},),
    "ten": ({"pos": "num.", "gloss": "十"},),
    "elephant": ({"pos": "n.", "gloss": "大象"},),
    # --- 2 上 Can you swim?（can't ECDICT pos vi. 误标，随 let's 惯例 abbr.；fly 首义随教材动词）---
    "swim": ({"pos": "vi.", "gloss": "游泳"},),
    "run": ({"pos": "vi.", "gloss": "跑"},),
    "write": ({"pos": "vt.", "gloss": "写字"},),
    "fly": ({"pos": "vi.", "gloss": "飞"}, {"pos": "n.", "gloss": "苍蝇"}),
    "can't": ({"pos": "abbr.", "gloss": "不能"},),
    "giraffe": ({"pos": "n.", "gloss": "长颈鹿"},),
    # --- 2 上 U4 词组（票 21 词组 curated 通道：ECDICT 查无，enrich miss 分支装配）---
    "ride a bicycle": ({"pos": "v.", "gloss": "骑自行车"},),
    # --- 2 上 That's my family（old ECDICT 名词义「以前, 往昔」误排首，裁除重排）---
    "family": ({"pos": "n.", "gloss": "家庭、家人"},),
    "brother": ({"pos": "n.", "gloss": "哥哥、弟弟"},),
    "sister": ({"pos": "n.", "gloss": "姐姐、妹妹"},),
    "young": ({"pos": "a.", "gloss": "年轻的"},),
    "old": ({"pos": "a.", "gloss": "老的"}, {"pos": "a.", "gloss": "旧的"}),
    "insect": ({"pos": "n.", "gloss": "昆虫"},),
    "jellyfish": ({"pos": "n.", "gloss": "水母"},),
    # --- 2 上 My hair is short（has 随 am/is 惯例 pos 置 None，裁「have的第三人称单数现在式」屈折串）---
    "hair": ({"pos": "n.", "gloss": "头发"},),
    "head": ({"pos": "n.", "gloss": "头"},),
    "long": ({"pos": "a.", "gloss": "长的"},),
    "now": ({"pos": "adv.", "gloss": "现在"},),
    "kangaroo": ({"pos": "n.", "gloss": "袋鼠"},),
    "lion": ({"pos": "n.", "gloss": "狮子"},),
    "has": ({"pos": None, "gloss": "有"},),
    # --- 2 上 In the playground（slide ECDICT 无「滑梯」义，取教材核心义补；设备类模板句不通顺）---
    "playground": ({"pos": "n.", "gloss": "游乐场、操场"},),
    "slide": ({"pos": "n.", "gloss": "滑梯"},),
    "swing": ({"pos": "n.", "gloss": "秋千"},),
    "seesaw": ({"pos": "n.", "gloss": "跷跷板"},),
    "nightingale": ({"pos": "n.", "gloss": "夜莺"},),
    # --- 2 上 In my room（词组随 how many 惯例 pos 置 None；box 源页「盆子」系站点噪音不采）---
    "room": ({"pos": "n.", "gloss": "房间"},),
    "put": ({"pos": "vt.", "gloss": "放"},),
    "in": ({"pos": "prep.", "gloss": "在…里"},),
    "bag": ({"pos": "n.", "gloss": "袋子、包"},),
    "dad": ({"pos": "n.", "gloss": "爸爸"},),
    "box": ({"pos": "n.", "gloss": "盒子、箱子"},),
    "chair": ({"pos": "n.", "gloss": "椅子"},),
    "desk": ({"pos": "n.", "gloss": "书桌"},),
    "car": ({"pos": "n.", "gloss": "小汽车"},),
    "look at": ({"pos": None, "gloss": "看"},),
    "pencil case": ({"pos": "n.", "gloss": "铅笔盒"},),  # 票 22：ECDICT 词组无 pos，curated 置 n.
    "ox": ({"pos": "n.", "gloss": "公牛"},),
    "work": ({"pos": "vi.", "gloss": "工作"},),
    "sleep": ({"pos": "vi.", "gloss": "睡觉"},),
    # --- 2 上 Dinner is ready（plate ECDICT「碟」居首，随教材核心义「盘子」重排）---
    "dinner": ({"pos": "n.", "gloss": "晚餐、正餐"},),
    "ready": ({"pos": "a.", "gloss": "准备好的"},),
    "plate": ({"pos": "n.", "gloss": "盘子、碟子"},),
    "chopsticks": ({"pos": "n.", "gloss": "筷子"},),
    "bowl": ({"pos": "n.", "gloss": "碗"},),
    "spoon": ({"pos": "n.", "gloss": "勺子、调羹"},),
    "queen bee": ({"pos": None, "gloss": "蜂王"},),
    "fly around": ({"pos": None, "gloss": "飞来飞去"},),
    "run around": ({"pos": None, "gloss": "跑来跑去"},),
    # --- 2 上 In the sky ---
    "sky": ({"pos": "n.", "gloss": "天空"},),
    "moon": ({"pos": "n.", "gloss": "月亮、月球"},),
    "bright": ({"pos": "a.", "gloss": "明亮的"},),
    "sun": ({"pos": "n.", "gloss": "太阳"},),
    "star": ({"pos": "n.", "gloss": "星星"},),
    "snake": ({"pos": "n.", "gloss": "蛇"},),
    "king": ({"pos": "n.", "gloss": "国王"},),
    # --- 2 上 In the forest（wild ECDICT 名词义「荒野」误排首裁除；dove 裁 dive 屈折尾行）---
    "forest": ({"pos": "n.", "gloss": "森林"},),
    "fox": ({"pos": "n.", "gloss": "狐狸"},),
    "meat": ({"pos": "n.", "gloss": "肉"},),
    "hippo": ({"pos": "n.", "gloss": "河马"},),
    "grass": ({"pos": "n.", "gloss": "草"},),
    "wild": ({"pos": "a.", "gloss": "野生的"},),
    "animal": ({"pos": "n.", "gloss": "动物"},),
    "cute": ({"pos": "a.", "gloss": "可爱的"},),
    "wow": ({"pos": "int.", "gloss": "哇"},),
    "so": ({"pos": "adv.", "gloss": "这么、那么"}, {"pos": "conj.", "gloss": "所以"}),
    "dove": ({"pos": "n.", "gloss": "鸽子"},),
    "swan": ({"pos": "n.", "gloss": "天鹅"},),
    "white": ({"pos": "a.", "gloss": "白色的"}, {"pos": "n.", "gloss": "白色"}),
    # --- 2 上 In the street（don't 裁 n. 禁忌尾义；pick ECDICT 名词义「精选」误排首重排）---
    "street": ({"pos": "n.", "gloss": "街道、马路"},),
    "don't": ({"pos": "abbr.", "gloss": "不要"},),
    "pick": ({"pos": "v.", "gloss": "摘、采"},),
    "flower": ({"pos": "n.", "gloss": "花"},),
    "climb": ({"pos": "v.", "gloss": "爬、攀登"},),
    "tree": ({"pos": "n.", "gloss": "树"},),
    "park": ({"pos": "n.", "gloss": "公园"},),
    "beautiful": ({"pos": "a.", "gloss": "美丽的"},),
    "cry": ({"pos": "vi.", "gloss": "哭"},),
    "yak": ({"pos": "n.", "gloss": "牦牛"},),
    "zebra": ({"pos": "n.", "gloss": "斑马"},),
    # --- 票 42 新版小学 4 册词组 curated 通道（ECDICT 查无 19 词，票 21 机制复用；
    #     义项按低年级教材语境人工校对，音标零编造走 miss 分支 None）---
    "baozi": ({"pos": "n.", "gloss": "包子"},),
    "dim sum": ({"pos": "n.", "gloss": "点心"},),
    "ride a bike": ({"pos": "v.", "gloss": "骑自行车"},),
    "ride a scooter": ({"pos": "v.", "gloss": "骑滑板车"},),
    "play football": ({"pos": "v.", "gloss": "踢足球"},),
    "toy plane": ({"pos": "n.", "gloss": "玩具飞机"},),
    "toy bear": ({"pos": "n.", "gloss": "玩具熊"},),
    "fruit shop": ({"pos": "n.", "gloss": "水果店"},),
    "toy shop": ({"pos": "n.", "gloss": "玩具店"},),
    "play with lanterns": ({"pos": "v.", "gloss": "玩灯笼"},),
    "eat mooncakes": ({"pos": "v.", "gloss": "吃月饼"},),
    "solve riddles": ({"pos": "v.", "gloss": "猜灯谜"},),
    "look at the moon": ({"pos": "v.", "gloss": "赏月"},),
    "wash my hands": ({"pos": "v.", "gloss": "洗手"},),
    "brush my teeth": ({"pos": "v.", "gloss": "刷牙"},),
    "wash my face": ({"pos": "v.", "gloss": "洗脸"},),
    "do paper-cutting": ({"pos": "v.", "gloss": "剪纸"},),
    "do the lion dance": ({"pos": "v.", "gloss": "舞狮"},),
    "kick a shuttlecock": ({"pos": "v.", "gloss": "踢毽子"},),
    # --- 票 43 旧版 5 下/6 下词组 curated（ECDICT 查无 38 词；词形已按核心形规范化，
    #     课本可变形标注 (be)/… 剥离——gen43 WORD_FIX 留痕）---
    "be full of": ({"pos": "v.", "gloss": "充满"},),
    "wear glasses": ({"pos": "v.", "gloss": "戴眼镜"},),
    "do exercise": ({"pos": "v.", "gloss": "锻炼"},),
    "be weak in": ({"pos": "v.", "gloss": "在……方面弱"},),
    "not any more": ({"pos": "adv.", "gloss": "不再"},),
    "do a survey": ({"pos": "v.", "gloss": "做调查"},),
    "act out": ({"pos": "v.", "gloss": "表演"},),
    "see a film": ({"pos": "v.", "gloss": "看电影"},),
    "row a boat": ({"pos": "v.", "gloss": "划船"},),
    "go swimming": ({"pos": "v.", "gloss": "去游泳"},),
    "all year round": ({"pos": "adv.", "gloss": "一年到头"},),
    "school gate": ({"pos": "n.", "gloss": "校门口"},),
    "art room": ({"pos": "n.", "gloss": "美术室"},),
    "meeting room": ({"pos": "n.", "gloss": "会议室"},),
    "try on": ({"pos": "v.", "gloss": "试穿"},),
    "put on": ({"pos": "v.", "gloss": "穿上"},),
    "have a headache": ({"pos": "v.", "gloss": "头疼"},),
    "have a fever": ({"pos": "v.", "gloss": "发烧"},),
    "have a toothache": ({"pos": "v.", "gloss": "牙疼"},),
    "have a meeting": ({"pos": "v.", "gloss": "开会"},),
    "pull out": ({"pos": "v.", "gloss": "拔出"},),
    "far away from": ({"pos": "prep.", "gloss": "远离"},),
    "at the end of": ({"pos": "prep.", "gloss": "在……末尾"},),
    "no entry": ({"pos": "phra.", "gloss": "禁止进入"},),
    "be kind to": ({"pos": "v.", "gloss": "对……友善"},),
    "get in": ({"pos": "v.", "gloss": "收获；进入"},),
    "online": ({"pos": "adj.", "gloss": "在线的"},),
    "chinese ink painting": ({"pos": "n.", "gloss": "中国水墨画"},),
    "on the right": ({"pos": "prep.", "gloss": "在右边"},),
    "model house": ({"pos": "n.", "gloss": "模型房子"},),
    "long race": ({"pos": "n.", "gloss": "长跑"},),
    "short race": ({"pos": "n.", "gloss": "短跑"},),
    "swimming goggles": ({"pos": "n.", "gloss": "泳镜"},),
    "praise for": ({"pos": "v.", "gloss": "因……赞扬"},),
    "no smoking": ({"pos": "phra.", "gloss": "禁止吸烟"},),
    "no swimming": ({"pos": "phra.", "gloss": "禁止游泳"},),
    "pen holder": ({"pos": "n.", "gloss": "笔筒"},),
    "jack-o'-lantern": ({"pos": "n.", "gloss": "南瓜灯"},),
    # --- 票 45 初中 6 册 curated（沪教牛津 2024 版；ECDICT 精简库 77 万条对初中词组/
    #     复合专名/[计]域词覆盖不足；键＝normalize 后小写）---
    # 七上（U1-U8）
    "turn to somebody for help": ({"pos": "v.", "gloss": "向某人求助"},),
    "be willing to do something": ({"pos": "v.", "gloss": "愿意做某事"},),
    "medium height": ({"pos": "n.", "gloss": "中等身高"},),
    "rise into": ({"pos": "v.", "gloss": "升入"},),
    "cry oneself to sleep": ({"pos": "v.", "gloss": "哭着睡着"},),
    "take somebody's place": ({"pos": "v.", "gloss": "代替某人"},),
    "have picnics": ({"pos": "v.", "gloss": "野餐"},),
    "work one's land": ({"pos": "v.", "gloss": "耕种土地"},),
    "solar term": ({"pos": "n.", "gloss": "节气"},),
    "be divided into": ({"pos": "v.", "gloss": "被分成"},),
    "play an important part in": ({"pos": "v.", "gloss": "在……起重要作用"},),
    "fact file": ({"pos": "n.", "gloss": "资料卡"},),
    "be covered by": ({"pos": "v.", "gloss": "被……覆盖"},),
    "as far as we know": ({"pos": "phra.", "gloss": "据我们所知"},),
    "what's more": ({"pos": "phra.", "gloss": "而且；更重要的是"},),
    "plastic pollution": ({"pos": "n.", "gloss": "塑料污染"},),
    "space station": ({"pos": "n.", "gloss": "空间站"},),
    "take photos": ({"pos": "v.", "gloss": "拍照"},),
    "get into orbit": ({"pos": "v.", "gloss": "进入轨道"},),
    "tourist spot": ({"pos": "n.", "gloss": "旅游景点"},),
    "in the centre of": ({"pos": "prep.", "gloss": "在……中心"},),
    "historic site": ({"pos": "n.", "gloss": "历史遗迹"},),
    "clubs fair": ({"pos": "n.", "gloss": "社团招募会"},),
    "remote control": ({"pos": "n.", "gloss": "遥控器"},),
    "add to": ({"pos": "v.", "gloss": "添加到"},),
    "a waste of time": ({"pos": "phra.", "gloss": "浪费时间"},),
    # 七下
    "go sightseeing": ({"pos": "v.", "gloss": "观光"},),
    "in the wild": ({"pos": "prep.", "gloss": "在野外"},),
    "golden monkey": ({"pos": "n.", "gloss": "金丝猴"},),
    "go hiking": ({"pos": "v.", "gloss": "远足"},),
    "search-and-rescue": ({"pos": "adj.", "gloss": "搜救的"},),
    "lead (somebody) to": ({"pos": "v.", "gloss": "把……带到"},),
    "steam engine": ({"pos": "n.", "gloss": "蒸汽机"},),
    "switch-off": ({"pos": "n.", "gloss": "关机；断开"},),
    "have something in common": ({"pos": "v.", "gloss": "有共同之处"},),
    "air conditioner": ({"pos": "n.", "gloss": "空调"},),
    "video game": ({"pos": "n.", "gloss": "电子游戏"},),
    "well-respected": ({"pos": "adj.", "gloss": "受人尊敬的"},),
    "devote yourself to": ({"pos": "v.", "gloss": "献身于"},),
    "college entrance examination": ({"pos": "n.", "gloss": "高考"},),
    "chief engineer": ({"pos": "n.", "gloss": "总工程师"},),
    "go outside": ({"pos": "v.", "gloss": "外出"},),
    # 八上
    "general education": ({"pos": "n.", "gloss": "通识教育"},),
    "go back a long way": ({"pos": "v.", "gloss": "由来已久"},),
    "alphabetical order": ({"pos": "n.", "gloss": "字母顺序"},),
    "play an important role": ({"pos": "v.", "gloss": "起重要作用"},),
    "flight schedule": ({"pos": "n.", "gloss": "航班时刻表"},),
    "without hesitation": ({"pos": "adv.", "gloss": "毫不犹豫"},),
    "laptop": ({"pos": "n.", "gloss": "笔记本电脑"},),
    "app": ({"pos": "n.", "gloss": "应用程序"},),
    "download": ({"pos": "v.", "gloss": "下载"},),
    "bring big changes to": ({"pos": "v.", "gloss": "给……带来巨变"},),
    "mobile payment": ({"pos": "n.", "gloss": "移动支付"},),
    "social media": ({"pos": "n.", "gloss": "社交媒体"},),
    "the general public": ({"pos": "n.", "gloss": "大众"},),
    "steam locomotive": ({"pos": "n.", "gloss": "蒸汽机车"},),
    "crewed spacecraft": ({"pos": "n.", "gloss": "载人飞船"},),
    "large amounts of": ({"pos": "phra.", "gloss": "大量的"},),
    "international trade": ({"pos": "n.", "gloss": "国际贸易"},),
    "3d printer": ({"pos": "n.", "gloss": "3D 打印机"},),
    "beijing opera": ({"pos": "n.", "gloss": "京剧"},),
    "host family": ({"pos": "n.", "gloss": "寄宿家庭"},),
    "snake its way": ({"pos": "v.", "gloss": "蜿蜒前行"},),
    "make jokes about": ({"pos": "v.", "gloss": "拿……开玩笑"},),
    "go on board": ({"pos": "v.", "gloss": "上船（飞机）"},),
    "flash card": ({"pos": "n.", "gloss": "教学卡片"},),
    "make a point of doing something": ({"pos": "v.", "gloss": "坚持做某事"},),
    "natural disaster": ({"pos": "n.", "gloss": "自然灾害"},),
    "have no choice but to do": ({"pos": "v.", "gloss": "别无选择只能"},),
    "run free": ({"pos": "v.", "gloss": "自由奔跑"},),
    "catch the eye of somebody": ({"pos": "v.", "gloss": "吸引某人注意"},),
    # 八下
    "voluntary work": ({"pos": "n.", "gloss": "志愿工作"},),
    "disabled people": ({"pos": "n.", "gloss": "残障人士"},),
    "cheer somebody up": ({"pos": "v.", "gloss": "使某人振作"},),
    "raise one's spirits": ({"pos": "v.", "gloss": "提振精神"},),
    "hold something up": ({"pos": "v.", "gloss": "举起"},),
    "make a good impression on": ({"pos": "v.", "gloss": "给……留下好印象"},),
    "artificial intelligence": ({"pos": "n.", "gloss": "人工智能"},),
    "shadow puppet": ({"pos": "n.", "gloss": "皮影"},),
    "ink-wash painting": ({"pos": "n.", "gloss": "水墨画"},),
    "have an influence on": ({"pos": "v.", "gloss": "对……有影响"},),
    "at risk of": ({"pos": "prep.", "gloss": "有……风险"},),
    "take one's eyes off something": ({"pos": "v.", "gloss": "把视线移开"},),
    "neither nor": ({"pos": "conj.", "gloss": "既不……也不"},),
    "in one sitting": ({"pos": "adv.", "gloss": "一口气"},),
    "in the mood": ({"pos": "prep.", "gloss": "有心情"},),
    "be at one with": ({"pos": "v.", "gloss": "与……融为一体"},),
    "all walks of life": ({"pos": "phra.", "gloss": "各行各业"},),
    "red-crowned crane": ({"pos": "n.", "gloss": "丹顶鹤"},),
    "more than enough": ({"pos": "adj.", "gloss": "绰绰有余"},),
    "shoot dead": ({"pos": "v.", "gloss": "射杀"},),
    "without a care in the world": ({"pos": "adv.", "gloss": "无忧无虑"},),
    "lose one's life": ({"pos": "v.", "gloss": "丧命"},),
    "cultural exchange": ({"pos": "n.", "gloss": "文化交流"},),
    "technological development": ({"pos": "n.", "gloss": "科技发展"},),
    "high-speed train": ({"pos": "n.", "gloss": "高铁"},),
    "cannot afford to": ({"pos": "v.", "gloss": "负担不起"},),
    "space junk": ({"pos": "n.", "gloss": "太空垃圾"},),
    "in fear": ({"pos": "prep.", "gloss": "恐惧地"},),
    "landing site": ({"pos": "n.", "gloss": "着陆点"},),
    # 九上
    "with something in mind": ({"pos": "prep.", "gloss": "带着某种想法"},),
    "go straight to": ({"pos": "v.", "gloss": "直奔"},),
    "get something across": ({"pos": "v.", "gloss": "讲清楚"},),
    "with admiration": ({"pos": "adv.", "gloss": "钦佩地"},),
    "right and wrong": ({"pos": "n.", "gloss": "是非"},),
    "fresh in one's memory": ({"pos": "adj.", "gloss": "记忆犹新"},),
    "get addicted to": ({"pos": "v.", "gloss": "沉迷于"},),
    "be in charge of": ({"pos": "v.", "gloss": "负责"},),
    "drive somebody mad": ({"pos": "v.", "gloss": "使某人抓狂"},),
    "mess something up": ({"pos": "v.", "gloss": "搞砸"},),
    "hit it off with somebody": ({"pos": "v.", "gloss": "与某人投缘"},),
    "fall out with somebody": ({"pos": "v.", "gloss": "与某人闹翻"},),
    "feel ashamed of": ({"pos": "v.", "gloss": "对……感到羞愧"},),
    "lighting operator": ({"pos": "n.", "gloss": "灯光师"},),
    "make-up artist": ({"pos": "n.", "gloss": "化妆师"},),
    "sound operator": ({"pos": "n.", "gloss": "音效师"},),
    "reality show": ({"pos": "n.", "gloss": "真人秀"},),
    "travel show": ({"pos": "n.", "gloss": "旅游节目"},),
    "tv drama": ({"pos": "n.", "gloss": "电视剧"},),
    "shine down upon somebody": ({"pos": "v.", "gloss": "照在某人身上"},),
    "film review": ({"pos": "n.", "gloss": "影评"},),
    "fizzy drink": ({"pos": "n.", "gloss": "碳酸饮料"},),
    "fried food": ({"pos": "n.", "gloss": "油炸食品"},),
    "a balanced diet": ({"pos": "n.", "gloss": "均衡饮食"},),
    "dairy product": ({"pos": "n.", "gloss": "乳制品"},),
    "remind somebody of": ({"pos": "v.", "gloss": "使某人想起"},),
    "first-person point of view": ({"pos": "n.", "gloss": "第一人称视角"},),
    "carry on with something": ({"pos": "v.", "gloss": "继续做某事"},),
    "get tired": ({"pos": "v.", "gloss": "变累"},),
    "with a spring in one's step": ({"pos": "phra.", "gloss": "步履轻快"},),
    "pass something down": ({"pos": "v.", "gloss": "把……传下去"},),
    "fix one's eyes on": ({"pos": "v.", "gloss": "凝视"},),
    "photo album": ({"pos": "n.", "gloss": "相册"},),
    "ivy vine": ({"pos": "n.", "gloss": "常春藤"},),
    # 九下
    "in one's spare time": ({"pos": "prep.", "gloss": "在业余时间"},),
    "have no time to do": ({"pos": "v.", "gloss": "没时间做"},),
    "the pacific": ({"pos": "n.", "gloss": "太平洋"},),
    "be dying to": ({"pos": "v.", "gloss": "渴望"},),
    "can't wait to": ({"pos": "v.", "gloss": "迫不及待"},),
    "cancel out": ({"pos": "v.", "gloss": "抵消"},),
    "look on the bright side": ({"pos": "v.", "gloss": "看到好的一面"},),
    "be busy with": ({"pos": "v.", "gloss": "忙于"},),
    "check in": ({"pos": "v.", "gloss": "登记入住"},),
    # --- 高中 7 本查无兜底（票 46，2026-11-05；专名百科式＋短语自然义项）---
    "a chorus of": ({"pos": "n.", "gloss": "齐声;异口同声"},),
    "absorbed in": ({"pos": "adj.", "gloss": "专心致志于"},),
    "addicted to": ({"pos": "adj.", "gloss": "对……入迷的"},),
    "appeal to": ({"pos": "v.", "gloss": "吸引;呼吁"},),
    "as far as i am concerned": ({"pos": "prep.", "gloss": "就我而言"},),
    "bank of canton": ({"pos": "n.", "gloss": "广东银行（旧金山唐人街老建筑）"},),
    "be attracted to": ({"pos": "v.", "gloss": "被……吸引"},),
    "be comprised of": ({"pos": "v.", "gloss": "由……组成"},),
    "bird field guide": ({"pos": "n.", "gloss": "鸟类图鉴"},),
    "blog post": ({"pos": "n.", "gloss": "博客文章"},),
    "bounce around": ({"pos": "v.", "gloss": "蹦来蹦去;弹来弹去"},),
    "bunol": ({"pos": "n.", "gloss": "布尼奥尔（西班牙小镇）"},),
    "butchart gardens": ({"pos": "n.", "gloss": "布查特花园（加拿大）"},),
    "chandra theeravit": ({"pos": "n.", "gloss": "钱德拉·特拉维（人名）"},),
    "chiwen": ({"pos": "n.", "gloss": "鸱吻（古建筑屋脊兽）"},),
    "clearing after snow on a mountain pass": ({"pos": "n.", "gloss": "《函关雪霁图》（明代画作）"},),
    "cm": ({"pos": "n.", "gloss": "厘米"},),
    "comfort zone": ({"pos": "n.", "gloss": "舒适区"},),
    "coming of age day": ({"pos": "n.", "gloss": "成人节（日本节日）"},),
    "commit oneself to do": ({"pos": "v.", "gloss": "承诺;保证(做某事)"},),
    "concerned about": ({"pos": "adj.", "gloss": "为……担忧的"},),
    "cost an arm and a leg": ({"pos": "v.", "gloss": "花一大笔钱"},),
    "cpr": ({"pos": "n.", "gloss": "心肺复苏"},),
    "credit card": ({"pos": "n.", "gloss": "信用卡"},),
    "cyberbully": ({"pos": "v.", "gloss": "网络欺凌（者）"},),
    "dim sim": ({"pos": "n.", "gloss": "澳式点心"},),
    "donate to": ({"pos": "v.", "gloss": "向……捐赠"},),
    "electric shock": ({"pos": "n.", "gloss": "触电;电击"},),
    "elon musk": ({"pos": "n.", "gloss": "埃隆·马斯克（企业家）"},),
    "eric whitacre": ({"pos": "n.", "gloss": "埃里克·惠塔克（美国作曲家）"},),
    "face up": ({"pos": "adv.", "gloss": "面朝上地"},),
    "feeling from mountain and water": ({"pos": "n.", "gloss": "《山水情》（水墨动画）"},),
    "flow chart": ({"pos": "n.", "gloss": "流程图"},),
    "frank wild": ({"pos": "n.", "gloss": "弗兰克·怀尔德（探险队员）"},),
    "frank worsley": ({"pos": "n.", "gloss": "弗兰克·沃斯利（探险队船长）"},),
    "fred hoyle": ({"pos": "n.", "gloss": "弗雷德·霍伊尔（英国天文学家）"},),
    "freezing cold": ({"pos": "adj.", "gloss": "极冷的"},),
    "geothermal park": ({"pos": "n.", "gloss": "地热公园"},),
    "giverny": ({"pos": "n.", "gloss": "吉维尼（法国小镇）"},),
    "have an urge to": ({"pos": "v.", "gloss": "有做某事的强烈欲望"},),
    "head to": ({"pos": "v.", "gloss": "前往"},),
    "heimlich manoeuvre": ({"pos": "n.", "gloss": "海姆立克急救法"},),
    "help somebody to one's feet": ({"pos": "v.", "gloss": "帮助某人站起身来"},),
    "henry adams": ({"pos": "n.", "gloss": "亨利·亚当斯（剧作人物）"},),
    "henry norman bethune": ({"pos": "n.", "gloss": "亨利·诺曼·白求恩（医生）"},),
    "high-end": ({"pos": "adj.", "gloss": "高端的"},),
    "huangguoshu waterfall": ({"pos": "n.", "gloss": "黄果树瀑布"},),
    "hubert hudson": ({"pos": "n.", "gloss": "休伯特·赫德森（探险队员）"},),
    "hurricane katrina": ({"pos": "n.", "gloss": "飓风卡特里娜"},),
    "iconic": ({"pos": "adj.", "gloss": "标志性的"},),
    "illegally": ({"pos": "adv.", "gloss": "不合法地;非法地"},),
    "in a league of one's own": ({"pos": "phra.", "gloss": "独领风骚"},),
    "in closing": ({"pos": "prep.", "gloss": "最后"},),
    "in shock": ({"pos": "prep.", "gloss": "震惊地"},),
    "in the open air": ({"pos": "prep.", "gloss": "在户外"},),
    "in this sense": ({"pos": "prep.", "gloss": "从这个意义上讲"},),
    "inner mongolia autonomous region": ({"pos": "n.", "gloss": "内蒙古自治区"},),
    "iv needle": ({"pos": "n.", "gloss": "静脉注射针"},),
    "jade rabbit": ({"pos": "n.", "gloss": "“玉兔”号月球车"},),
    "jan tchamani": ({"pos": "n.", "gloss": "简·查马尼（英国教师）"},),
    "jean anthelme brillat-savarin": ({"pos": "n.", "gloss": "布里亚-萨瓦兰（法国美食家）"},),
    "jean-philippe": ({"pos": "n.", "gloss": "让-菲利普（人名）"},),
    "john a. logan": ({"pos": "n.", "gloss": "约翰·A·洛根（美国将军）"},),
    "join to": ({"pos": "v.", "gloss": "把……和……连接起来"},),
    "journey to the west": ({"pos": "n.", "gloss": "《西游记》"},),
    "keep balance": ({"pos": "v.", "gloss": "保持平衡"},),
    "keep somebody company": ({"pos": "v.", "gloss": "陪伴某人"},),
    "keep your eyes open for": ({"pos": "v.", "gloss": "留心;留意"},),
    "la tomatina": ({"pos": "n.", "gloss": "番茄大战（西班牙节日）"},),
    "lake louise": ({"pos": "n.", "gloss": "路易斯湖（加拿大）"},),
    "lake titicaca": ({"pos": "n.", "gloss": "的的喀喀湖"},),
    "lamb kebab": ({"pos": "n.", "gloss": "烤羊肉串"},),
    "lao zi": ({"pos": "n.", "gloss": "老子（古代哲学家）"},),
    "leave alone": ({"pos": "v.", "gloss": "不打扰;不惊动"},),
    "lionel greenstreet": ({"pos": "n.", "gloss": "莱昂内尔·格林斯特里特（探险队员）"},),
    "lux aurumque": ({"pos": "n.", "gloss": "《金色光芒》（歌曲）"},),
    "make a bet": ({"pos": "v.", "gloss": "打个赌"},),
    "make fire": ({"pos": "v.", "gloss": "生火"},),
    "make inferences": ({"pos": "v.", "gloss": "做推断"},),
    "manuka honey": ({"pos": "n.", "gloss": "麦卢卡蜂蜜"},),
    "marie curie": ({"pos": "n.", "gloss": "玛丽·居里（物理学家）"},),
    "merry christmas!": ({"pos": "int.", "gloss": "圣诞快乐!"},),
    "moral dilemma": ({"pos": "n.", "gloss": "道德困境"},),
    "mouth-to-mouth rescue breathing": ({"pos": "n.", "gloss": "口对口人工呼吸"},),
    "napa valley": ({"pos": "n.", "gloss": "纳帕谷（美国）"},),
    "neil armstrong": ({"pos": "n.", "gloss": "尼尔·阿姆斯特朗（宇航员）"},),
    "neuschwanstein castle": ({"pos": "n.", "gloss": "新天鹅堡（德国）"},),
    "non-newtonian fluid": ({"pos": "n.", "gloss": "非牛顿流体"},),
    "on a basis": ({"pos": "prep.", "gloss": "以……为基准"},),
    "overstatement": ({"pos": "n.", "gloss": "夸大;夸张"},),
    "owe something to somebody": ({"pos": "v.", "gloss": "欠某人某物;把……归功于某人"},),
    "peak season": ({"pos": "n.", "gloss": "旺季"},),
    "peking union medical college": ({"pos": "n.", "gloss": "北京协和医学院"},),
    "perce blackborow": ({"pos": "n.", "gloss": "珀西·布莱克博罗（探险队员）"},),
    "portia langham": ({"pos": "n.", "gloss": "波希亚·兰厄姆（剧中人物）"},),
    "portsmouth square": ({"pos": "n.", "gloss": "花园角广场（旧金山）"},),
    "pray that": ({"pos": "v.", "gloss": "祈求;但愿"},),
    "prefer to": ({"pos": "v.", "gloss": "喜欢……多于……"},),
    "proceed to": ({"pos": "v.", "gloss": "接着进行"},),
    "real estate agent": ({"pos": "n.", "gloss": "房地产经纪人"},),
    "red braised pork": ({"pos": "n.", "gloss": "红烧肉"},),
    "relay to": ({"pos": "v.", "gloss": "转达给;转发给"},),
    "resident physician": ({"pos": "n.", "gloss": "住院医师"},),
    "robert louis stevenson": ({"pos": "n.", "gloss": "罗伯特·路易斯·史蒂文森（作家）"},),
    "saint basil's cathedral": ({"pos": "n.", "gloss": "圣瓦西里大教堂"},),
    "sarek national park": ({"pos": "n.", "gloss": "萨勒克国家公园（瑞典）"},),
    "series of": ({"pos": "n.", "gloss": "一系列"},),
    "set an example": ({"pos": "v.", "gloss": "树立榜样"},),
    "sign up for": ({"pos": "v.", "gloss": "报名参加"},),
    "sonnets from the portuguese": ({"pos": "n.", "gloss": "《葡萄牙人十四行诗》"},),
    "south georgia island": ({"pos": "n.", "gloss": "南乔治亚岛"},),
    "soyuz 11": ({"pos": "n.", "gloss": "联盟 11 号（飞船）"},),
    "st lawrence river": ({"pos": "n.", "gloss": "圣劳伦斯河"},),
    "stephen hawking": ({"pos": "n.", "gloss": "史蒂芬·霍金（物理学家）"},),
    "sulphuric pool": ({"pos": "n.", "gloss": "硫黄池"},),
    "sumatra island": ({"pos": "n.", "gloss": "苏门答腊岛"},),
    "superior to": ({"pos": "adj.", "gloss": "优于"},),
    "tadpoles searching for mother": ({"pos": "n.", "gloss": "《小蝌蚪找妈妈》"},),
    "take for granted": ({"pos": "v.", "gloss": "认为……理所当然"},),
    "take out a loan": ({"pos": "v.", "gloss": "贷款"},),
    "techno": ({"pos": "n.", "gloss": "泰克诺电子舞曲"},),
    "test out": ({"pos": "v.", "gloss": "检验;测试"},),
    "the amazon rainforest": ({"pos": "n.", "gloss": "亚马孙雨林"},),
    "the amish": ({"pos": "n.", "gloss": "阿米什人"},),
    "the andes mountains": ({"pos": "n.", "gloss": "安第斯山脉"},),
    "the antarctic": ({"pos": "n.", "gloss": "南极地区"},),
    "the arctic": ({"pos": "n.", "gloss": "北极地区"},),
    "the belt and road initiative": ({"pos": "n.", "gloss": "“一带一路”倡议"},),
    "the big bang theory": ({"pos": "n.", "gloss": "大爆炸宇宙论"},),
    "the cowboy's flute": ({"pos": "n.", "gloss": "《牧笛》"},),
    "the crescent moon": ({"pos": "n.", "gloss": "《新月集》"},),
    "the eiffel tower": ({"pos": "n.", "gloss": "埃菲尔铁塔"},),
    "the emerald isle": ({"pos": "n.", "gloss": "绿宝石岛（爱尔兰别称）"},),
    "the forbidden city": ({"pos": "n.", "gloss": "紫禁城"},),
    "the golden gate bridge": ({"pos": "n.", "gloss": "金门大桥"},),
    "the inca empire": ({"pos": "n.", "gloss": "印加帝国"},),
    "the international space station": ({"pos": "n.", "gloss": "国际空间站"},),
    "the jet propulsion laboratory": ({"pos": "n.", "gloss": "喷气推进实验室（美国）"},),
    "the kremlin": ({"pos": "n.", "gloss": "克里姆林宫"},),
    "the media": ({"pos": "n.", "gloss": "大众传播媒介"},),
    "the middle ages": ({"pos": "n.", "gloss": "中世纪"},),
    "the mission district": ({"pos": "n.", "gloss": "传教区（旧金山街区）"},),
    "the naadam festival": ({"pos": "n.", "gloss": "那达慕大会"},),
    "the national people's congress": ({"pos": "n.", "gloss": "全国人民代表大会"},),
    "the nile": ({"pos": "n.", "gloss": "尼罗河"},),
    "the normans": ({"pos": "n.", "gloss": "诺曼人"},),
    "the north south pole": ({"pos": "n.", "gloss": "北极/南极"},),
    "the ob-gyn department": ({"pos": "n.", "gloss": "妇产科"},),
    "the people's republic of china": ({"pos": "n.", "gloss": "中华人民共和国"},),
    "the phantom of the opera": ({"pos": "n.", "gloss": "《歌剧魅影》"},),
    "the renaissance": ({"pos": "n.", "gloss": "文艺复兴"},),
    "the richmond district": ({"pos": "n.", "gloss": "里士满区（旧金山街区）"},),
    "the south pole": ({"pos": "n.", "gloss": "南极"},),
    "the terracotta army": ({"pos": "n.", "gloss": "兵马俑"},),
    "the upper class": ({"pos": "n.", "gloss": "上流社会"},),
    "the uros": ({"pos": "n.", "gloss": "乌鲁斯人"},),
    "the ussr": ({"pos": "n.", "gloss": "苏联"},),
    "the victorian era": ({"pos": "n.", "gloss": "维多利亚时代"},),
    "the wenhai scholarship": ({"pos": "n.", "gloss": "“文海”奖学金"},),
    "the world wide web": ({"pos": "n.", "gloss": "万维网"},),
    "theoretical framework": ({"pos": "n.", "gloss": "理论框架"},),
    "thomas orde-lees": ({"pos": "n.", "gloss": "托马斯·奥德-利斯（探险队员）"},),
    "tibetan antelope": ({"pos": "n.", "gloss": "藏羚羊"},),
    "tin how temple": ({"pos": "n.", "gloss": "天后古庙（旧金山）"},),
    "to extent": ({"pos": "prep.", "gloss": "到……程度"},),
    "to name but a few": ({"pos": "phra.", "gloss": "仅举几例"},),
    "tom crean": ({"pos": "n.", "gloss": "汤姆·克林（探险队员）"},),
    "turn somebody down": ({"pos": "v.", "gloss": "拒绝(某人)"},),
    "typhoon goni": ({"pos": "n.", "gloss": "台风“天鹅”"},),
    "virtual choir": ({"pos": "n.", "gloss": "虚拟合唱团"},),
    "voyager 1": ({"pos": "n.", "gloss": "旅行者 1 号（探测器）"},),
    "water pump": ({"pos": "n.", "gloss": "水泵"},),
    "yuri gagarin": ({"pos": "n.", "gloss": "尤里·加加林（宇航员）"},),
    "yangtze river dolphin": ({"pos": "n.", "gloss": "白鳍豚"},),
    "no matter": ({"pos": "conj.", "gloss": "不论;不管"},),
    "cut out": ({"pos": "v.", "gloss": "停止做(或使用、食用);剪下"},),
    "compare with": ({"pos": "v.", "gloss": "与……比较"},),
    "date back to": ({"pos": "v.", "gloss": "追溯到"},),
    "bring to life": ({"pos": "v.", "gloss": "使……鲜活起来"},),
    "pretend to": ({"pos": "v.", "gloss": "假装(做某事)"},),
    "be about to": ({"pos": "v.", "gloss": "即将;正要(做某事)"},),
    "be willing to": ({"pos": "v.", "gloss": "愿意(做某事)"},),
    # --- 小学 3上-6上 查无兜底（票 44，2026-11-05；课本 Word list 词组/缩略语）---
    "a (an)": ({"pos": "art.", "gloss": "一（个、件……）"},),
    "afraid (of)": ({"pos": "adj.", "gloss": "害怕（……的）"},),
    "bus driver": ({"pos": "n.", "gloss": "公交车司机"},),
    "climb trees": ({"pos": "v.", "gloss": "爬树"},),
    "grandfather (grandpa)": ({"pos": "n.", "gloss": "爷爷;外公;祖父;外祖父"},),
    "grandmother (grandma)": ({"pos": "n.", "gloss": "奶奶;外婆;祖母;外祖母"},),
    "at the weekend": ({"pos": "phra.", "gloss": "在周末"},),
    "brush teeth": ({"pos": "v.", "gloss": "刷牙"},),
    "half past": ({"pos": "phra.", "gloss": "……点半"},),
    "have a party": ({"pos": "v.", "gloss": "举办聚会"},),
    "have breakfast": ({"pos": "v.", "gloss": "吃早餐"},),
    "have lunch": ({"pos": "v.", "gloss": "吃午餐"},),
    "be late for": ({"pos": "phra.", "gloss": "迟到"},),
    "pe": ({"pos": "n.", "gloss": "体育（课）"},),
    "play basketball": ({"pos": "v.", "gloss": "打篮球"},),
    "play the guitar": ({"pos": "v.", "gloss": "弹吉他"},),
    "play the violin": ({"pos": "v.", "gloss": "拉小提琴"},),
    "play volleyball": ({"pos": "v.", "gloss": "打排球"},),
    "wash face": ({"pos": "v.", "gloss": "洗脸"},),
    "by bike": ({"pos": "phra.", "gloss": "骑自行车（出行）"},),
    "flower shop": ({"pos": "n.", "gloss": "花店"},),
    "grow crops": ({"pos": "v.", "gloss": "种庄稼"},),
    "make phone calls": ({"pos": "v.", "gloss": "打电话"},),
    "model plane": ({"pos": "n.", "gloss": "飞机模型"},),
    "play sport": ({"pos": "v.", "gloss": "做运动"},),
    "put out fires": ({"pos": "v.", "gloss": "灭火"},),
    "car museum": ({"pos": "n.", "gloss": "汽车博物馆"},),
    "in the north of": ({"pos": "phra.", "gloss": "在……的北部"},),
    "insect museum": ({"pos": "n.", "gloss": "昆虫博物馆"},),
    "keep alive": ({"pos": "v.", "gloss": "存活;维持生命"},),
    "many kinds of": ({"pos": "phra.", "gloss": "许多种类的"},),
    "model car": ({"pos": "n.", "gloss": "汽车模型"},),
    "plant trees": ({"pos": "v.", "gloss": "植树;种树"},),
    "plastic bag": ({"pos": "n.", "gloss": "塑料袋"},),
    "south china tiger": ({"pos": "n.", "gloss": "华南虎"},),
    "summer holiday": ({"pos": "n.", "gloss": "暑假"},),
}

# emoji 配图映射（自拟 2026-10-24）；键＝normalize_word(词形)。未映射词留空，不编造。
EMOJI_MAP: dict[str, str] = {
    "hello": "👋",
    "hi": "👋",
    "goodbye": "👋",
    "morning": "🌅",
    "afternoon": "🌞",
    "i": "🙋",
    "school": "🏫",
    "day": "📅",
    # "am"（be 动词）刻意无 emoji——具象配图对功能词无意义
}

# 拼读拆分 override（自拟 2026-10-24）：拆分源无把握处人工定拆。
PHONICS_OVERRIDES: dict[str, str] = {
    "goodbye": "good·bye",
}

# ---------------------------------------------------------------------------
# 拼读拆分（票 54 全库纠正）：pyphen 词典连字为主源，保守 VCCV 启发式兜底
# ---------------------------------------------------------------------------

_VOWEL_GROUP = re.compile(r"[aeiou]+")
# 双音辅音对（跨切点会把 digraph 劈开，如 fa|ther）：命中则不切（无把握不拆）
_DIGRAPHS = {"sh", "th", "ch", "ph", "wh", "ck", "ng", "qu"}

# pyphen en_US 连字词典（词典标准音节；尖刀 24 词抽检 20 精确命中＋665 变更抽查 30 全对；
# 模块级单例：词典加载一次复用）。VCCV 旧启发式只覆盖双写辅音型——全库 1,813 多音节
# 词无拆（registration/exchange/grandma/begin 等），pyphen 为主源后新增 2,125 拆、
# 665 拆分归位词典标准；548 词典无词条词仍保守不拆（宁缺勿滥）。
_PYPHEN_EN = pyphen.Pyphen(lang="en_US")


def _pyphen_parts(key: str) -> list[str] | None:
    """pyphen 连字切分；无词条/不成段返回 None。join==key 宁缺勿滥守卫。"""
    parts = _PYPHEN_EN.inserted(key, hyphen="·").split("·")
    if len(parts) < 2 or "".join(parts) != key:
        return None
    return parts


def _vccv_parts(key: str) -> list[str] | None:
    """保守 VCCV 启发式（2026-10-24 自拟）：仅两元音组间恰 2 个非 digraph 辅音切分。"""
    groups = [(match.start(), match.end()) for match in _VOWEL_GROUP.finditer(key)]
    if len(groups) < 2:
        return None  # 单音节：无需拆
    cuts: list[int] = []
    for (start_a, end_a), (start_b, _end_b) in zip(groups, groups[1:]):
        gap = key[end_a:start_b]
        if len(gap) == 2 and gap not in _DIGRAPHS:
            cuts.append(end_a + 1)  # VCCV：辅音串中间切（hel·lo / mor·ning）
    if not cuts:
        return None
    parts: list[str] = []
    previous = 0
    for cut in cuts:
        parts.append(key[previous:cut])
        previous = cut
    parts.append(key[previous:])
    return parts


def phonics_split(word: str) -> str | None:
    """拼读拆分：pyphen 词典主源＋VCCV 兜底；返回 None＝不拆（整词呈现）。

    词组/含符号词一律不拆；override 表优先；切分必须能拼回原词（宁缺勿滥）。
    """
    key = normalize_word(word)
    if key in PHONICS_OVERRIDES:
        return PHONICS_OVERRIDES[key]
    if not key.isascii() or not key.isalpha():
        return None
    parts = _pyphen_parts(key) or _vccv_parts(key)
    if parts is None or len(parts) < 2:
        return None
    return "·".join(parts)


# ---------------------------------------------------------------------------
# 义项与例句
# ---------------------------------------------------------------------------

_POS_PREFIX_RE = re.compile(r"^([a-z]{1,8}\.)\s*(.+)$", re.IGNORECASE)


def build_senses(lines: list[str]) -> list[dict]:
    """义项行 → senses JSON（取前 MAX_SENSES 行；解析行首词性，无词性置 None）。"""
    senses: list[dict] = []
    for line in lines[:MAX_SENSES]:
        match = _POS_PREFIX_RE.match(line)
        if match:
            senses.append({"pos": match.group(1).lower(), "gloss": match.group(2).strip()})
        else:
            senses.append({"pos": None, "gloss": line})
    return senses


def _curated_senses(word: str) -> list[dict] | None:
    """curated 义项覆盖（票 17 校对轮）：命中即整表替换，未命中返回 None 走 ECDICT 原路。"""
    curated = CURATED_SENSES.get(normalize_word(word))
    if not curated:
        return None
    return [dict(sense) for sense in curated]


def _category(pos: str | None) -> str:
    if not pos:
        return "default"
    p = pos.lower()
    if p.startswith("num"):
        return "default"
    if p.startswith("n"):
        return "n"
    if p.startswith("v"):
        return "v"
    if p.startswith("adj") or p.startswith("a."):
        return "adj"
    if p.startswith("int"):
        return "int"
    if p.startswith("pron"):
        return "pron"
    return "default"


def _article_for(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def _zh_filler(senses: list[dict]) -> str:
    """模板中文侧 {zh} 填充（票 22 zh 本土化）：首义 gloss 清洗——去句号、
    多义并列「、」「，」取首段（嵌句取代表义）、去 adj 形态尾「的」（长度>1）。"""
    gloss = (senses[0].get("gloss") or "").strip().rstrip("。")
    for sep in ("、", "，"):
        if sep in gloss:
            gloss = gloss.split(sep)[0].strip()
    if len(gloss) > 1 and gloss.endswith("的"):
        gloss = gloss[:-1]
    return gloss


def build_examples(word: str, senses: list[dict]) -> list[dict]:
    """模板例句：curated 覆盖优先，否则按词性取模板做词形填充。每条带 origin 可溯。"""
    key = normalize_word(word)
    curated = CURATED_EXAMPLES.get(key)
    if curated:
        return [{"en": en, "zh": zh, "origin": origin} for en, zh, origin in curated]

    category = _category(senses[0]["pos"]) if senses else "default"
    templates = EXAMPLE_TEMPLATES.get(category, EXAMPLE_TEMPLATES["default"])
    fillers = {
        "word": word,
        "Word": word[:1].upper() + word[1:],
        "article": _article_for(word),
        "zh": _zh_filler(senses) if senses else word,
    }
    return [
        {"en": en.format(**fillers), "zh": zh.format(**fillers), "origin": origin}
        for en, zh, origin in templates[:MAX_SENSES]
    ]


# ---------------------------------------------------------------------------
# 补全编排
# ---------------------------------------------------------------------------


@dataclass
class EnrichedWord:
    """一词补全结果；status=missing 时 phonetic/senses/examples 一律 None（禁编造）。"""

    word: str
    entry_id: str
    status: str  # ok / missing
    phonetic_uk: str | None = None
    phonetic_us: str | None = None  # ECDICT 无美音：恒 None（R13 默认英式先行）
    senses: list[dict] | None = None
    examples: list[dict] | None = None
    phonics_split: str | None = None
    used_lemma: str | None = None
    miss_reason: str | None = None  # ecdict_miss / domain_only


class WordEnricher:
    """单词补全器：ECDICT 点查 → 屈折 lemma 救回 → 五项填充；查无进 E7。"""

    def __init__(self, lookup: EcdictLookup) -> None:
        self._lookup = lookup

    def close(self) -> None:
        self._lookup.close()

    def enrich(self, word: str) -> EnrichedWord:
        word = word.strip()
        entry_id = lexical_entry_id(word)
        entry = self._lookup.lookup(word)
        if entry is None:
            curated = _curated_senses(word)
            if curated is None:
                return self._missing(word, entry_id, "ecdict_miss")
            # 词组 curated 通道（票 21）：ECDICT 查无但 curated 显式覆盖的词形
            # （如词组 ride a bicycle）直接装配；音标零编造留 None，emoji/senses/
            # examples/phonics 与常态路径同构（phonics_split 对词组天然不拆）。
            emoji = EMOJI_MAP.get(normalize_word(word))
            if emoji:
                curated = [dict(curated[0], emoji=emoji), *curated[1:]]
            return EnrichedWord(
                word=word,
                entry_id=entry_id,
                status="ok",
                phonetic_uk=None,
                phonetic_us=None,
                senses=curated,
                examples=build_examples(word, curated),
                phonics_split=phonics_split(word),
            )

        lines = clean_translation(entry.translation)
        used_lemma: str | None = None
        if not lines or looks_inflected_only(lines):
            lemma = lemma_of(entry.exchange)
            if lemma:
                base = self._lookup.lookup(lemma)
                if base is not None:
                    base_lines = clean_translation(base.translation)
                    if base_lines and not looks_inflected_only(base_lines):
                        entry, lines, used_lemma = base, base_lines, lemma

        if not lines:
            # 纯领域释义（裁后无行）或屈折无可用 lemma：有 translation 文本＝domain_only，
            # 否则＝ecdict_miss。两种都进 E7 待补队列，音标/释义零编造（WRONG 红线）。
            # curated 通道扩展（票 43）：domain_only 但 curated 显式覆盖时同样直接装配
            # （curated 是更优先的校对事实源，与 miss 分支同构；音标零编造留 None）。
            curated = _curated_senses(word)
            if curated is not None:
                emoji = EMOJI_MAP.get(normalize_word(word))
                if emoji:
                    curated = [dict(curated[0], emoji=emoji), *curated[1:]]
                return EnrichedWord(
                    word=word,
                    entry_id=entry_id,
                    status="ok",
                    phonetic_uk=None,
                    phonetic_us=None,
                    senses=curated,
                    examples=build_examples(word, curated),
                    phonics_split=phonics_split(word),
                )
            reason = "domain_only" if (entry.translation or "").strip() else "ecdict_miss"
            return self._missing(word, entry_id, reason)

        senses = _curated_senses(word) or build_senses(lines)
        emoji = EMOJI_MAP.get(normalize_word(word))
        if emoji and senses:
            senses[0] = {**senses[0], "emoji": emoji}
        return EnrichedWord(
            word=word,
            entry_id=entry_id,
            status="ok",
            phonetic_uk=normalize_phonetic(entry.phonetic),
            phonetic_us=None,
            senses=senses,
            examples=build_examples(word, senses),
            phonics_split=phonics_split(word),
            used_lemma=used_lemma,
        )

    @staticmethod
    def _missing(word: str, entry_id: str, reason: str) -> EnrichedWord:
        return EnrichedWord(word=word, entry_id=entry_id, status="missing", miss_reason=reason)
