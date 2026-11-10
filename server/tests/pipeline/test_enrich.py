"""补全五项（音标/释义/模板例句/emoji/拼读）：curated 优先、零编造红线、lemma 救回。"""
from __future__ import annotations

import pytest

from app.pipeline.ecdict import EcdictLookup
from app.pipeline.enrich import WordEnricher, build_senses, phonics_split


@pytest.fixture
def enricher(ecdict_db):
    lookup = EcdictLookup(ecdict_db)
    yield WordEnricher(lookup)
    lookup.close()


def test_hello_curated_example_emoji_phonics(enricher) -> None:
    result = enricher.enrich("hello")
    assert result.status == "ok"
    assert result.phonetic_uk == "hə'ləʊ"  # 西里尔 ә 规范化
    assert result.phonetic_us is None  # ECDICT 无美音，R13 默认英式
    assert result.examples[0]["origin"] == "curated:u1-greet-intro"
    assert result.examples[0]["en"] == "Hello! Hello, I'm Li Ming."
    assert result.senses[0]["pos"] == "int."
    assert result.senses[0]["emoji"] == "👋"
    assert result.phonics_split == "hel·lo"  # VCCV：hel·lo


def test_school_curated_senses_and_template_fill(enricher) -> None:
    result = enricher.enrich("school")
    assert result.status == "ok"
    # 票 17 curated 整表替换：ECDICT 垃圾尾（鱼群/门派/学派＋vt.教育）裁除，只留教材核心义
    assert result.senses == [{"pos": "n.", "gloss": "学校", "emoji": "🏫"}]
    assert all("鱼群" not in (sense.get("gloss") or "") for sense in result.senses)
    assert result.examples[0]["origin"] == "template:t-n-my"
    assert result.examples[0]["en"] == "This is my school."
    assert result.phonics_split is None  # 单元音组（oo）：不拆


def test_give_curated_sense_fix_p2(enricher) -> None:
    """票 14 P2 治本断言：give 首义＝「给」（ECDICT 名词义「弹性, 适应性」误排首被 curated 纠正）。"""
    result = enricher.enrich("give")
    assert result.status == "ok"
    assert result.senses[0]["pos"] == "vt."
    assert result.senses[0]["gloss"] == "给"
    assert result.examples[0]["en"] == "Give me the book, please."
    assert result.examples[0]["origin"] == "curated:u2-give"


def test_a_curated_sense_no_carriage_return(enricher) -> None:
    """票 17：a 冠词义「一个」，无 \\r 残留、无 [计] 域行。"""
    result = enricher.enrich("a")
    assert result.status == "ok"
    assert result.senses == [{"pos": "art.", "gloss": "一个"}]
    assert "\r" not in result.senses[0]["gloss"]


def test_build_senses_ecdict_fallback_path() -> None:
    """无 curated 词走 ECDICT 原路：build_senses 取前 MAX_SENSES 行＋词性解析（回归钉）。"""
    senses = build_senses(["vt. 谢谢, 感谢", "n. 感谢", "第三行不取"])
    assert senses == [
        {"pos": "vt.", "gloss": "谢谢, 感谢"},
        {"pos": "n.", "gloss": "感谢"},
    ]
    assert build_senses(["无词性行"]) == [{"pos": None, "gloss": "无词性行"}]


def test_apple_article_an_in_second_template(enricher) -> None:
    result = enricher.enrich("apple")
    assert result.examples[0]["en"] == "This is my apple."
    assert result.examples[1]["en"] == "I can see an apple."  # 元音开头 → an


def test_morning_phonetic_map_domain_trim_phonics(enricher) -> None:
    result = enricher.enrich("morning")
    assert result.status == "ok"
    assert result.phonetic_uk == "mɔːnɪŋ"  # ɒ: → ɔː
    assert result.phonics_split == "morn·ing"  # 票 54 pyphen 词典标准（旧 VCCV mor·ning 非标准）
    assert result.examples[0]["origin"] == "curated:u1-greet-morning"
    assert len(result.senses) == 2  # curated 两义（早晨/上午）；ECDICT 领域行裁剪路径由非 curated 词回归钉
    assert result.senses[0]["gloss"] == "早晨"


def test_licked_lemma_rescue(enricher) -> None:
    result = enricher.enrich("licked")
    assert result.status == "ok"
    assert result.used_lemma == "lick"  # exchange 0:lemma 救回
    assert result.phonetic_uk == "lɪk"  # 音标取自基词，不编造
    assert result.senses[0]["gloss"] == "舔"


def test_missing_zero_fabrication(enricher) -> None:
    zorblat = enricher.enrich("zorblat")
    assert zorblat.status == "missing"
    assert zorblat.miss_reason == "ecdict_miss"
    assert zorblat.phonetic_uk is None and zorblat.senses is None
    assert zorblat.examples is None
    assert zorblat.phonics_split is None  # missing 词不装配任何字段（票 19 零编造守卫原样）

    onlydomain = enricher.enrich("onlydomain")
    assert onlydomain.status == "missing"
    assert onlydomain.miss_reason == "domain_only"  # 纯领域释义：同样不编造
    assert onlydomain.senses is None


def test_phonics_pyphen_primary() -> None:
    # 票 54：pyphen 词典主源（用户实测 registration 无拆分→全库纠正）
    assert phonics_split("goodbye") == "good·bye"  # override 优先
    assert phonics_split("father") == "fa·ther"  # 词典标准（旧 VCCV digraph 门不切＝漏拆）
    assert phonics_split("registration") == "reg·is·tra·tion"  # VC/CV 模式（VCCV 盲区）
    assert phonics_split("exchange") == "ex·change"  # digraph 跨切（VCCV 盲区）
    assert phonics_split("grandma") == "grand·ma"  # 三辅音串（VCCV 盲区）
    assert phonics_split("begin") == "be·gin"  # 单辅音 V/CV（VCCV 盲区）
    assert phonics_split("morning") == "morn·ing"  # 词典标准归位
    assert phonics_split("cat") is None  # 单音节
    assert phonics_split("school") is None  # 单音节（oo 单元音组）
    assert phonics_split("licked") is None  # 单音节
    assert phonics_split("good-bye") is None  # 含符号：不拆
    assert phonics_split("how many") is None  # 词组：不拆


# --- 票 19：2 上 curated 滚动轮抽样（夹具释义行抄自真实 ECDICT 2026-11-01 实勘）---


def test_g2a_curated_senses_mum_old_white(enricher) -> None:
    """票 19 三锚词 curated 整表替换：mum 垃圾首义裁除／old 名词义误排首重排／white 颜色词形状。"""
    mum = enricher.enrich("mum")
    assert mum.status == "ok"
    assert mum.senses == [{"pos": "n.", "gloss": "妈妈"}]  # ECDICT「菊花, 沉默」等全裁
    assert all("菊花" not in (sense.get("gloss") or "") for sense in mum.senses)

    old = enricher.enrich("old")
    assert old.senses[0] == {"pos": "a.", "gloss": "老的"}  # ECDICT n.「以前, 往昔」误排首纠正
    assert [sense["gloss"] for sense in old.senses] == ["老的", "旧的"]

    white = enricher.enrich("white")
    assert [(sense["pos"], sense["gloss"]) for sense in white.senses] == [
        ("a.", "白色的"),
        ("n.", "白色"),
    ]  # 颜色词首义统一形容词，与 1 上 yellow/red/blue/green 同款
    assert all("眼白" not in (sense.get("gloss") or "") for sense in white.senses)


def test_g2a_curated_sense_has_inflection_string(enricher) -> None:
    """票 19：has 释义＝「have的第三人称单数现在式」（非 _INFLECTION_RE 全串形态，lemma
    救回不触发）——curated 直给儿童义「有」，屈折串不落包。"""
    result = enricher.enrich("has")
    assert result.status == "ok"
    assert result.used_lemma is None
    assert result.senses == [{"pos": None, "gloss": "有"}]
    assert "第三人称" not in (result.senses[0]["gloss"])


def test_g2a_curated_examples_dont_cant(enricher) -> None:
    """票 19：2 上功能词 curated 例句（don't/can't 模板 default 句不可用）。"""
    dont = enricher.enrich("don't")
    assert dont.senses[0]["gloss"] == "不要"  # ECDICT n.「禁忌」尾义被裁
    assert dont.examples[0]["en"] == "Don't climb the tree!"
    assert dont.examples[0]["origin"] == "curated:g2u12-dont"

    cant = enricher.enrich("can't")
    assert cant.senses == [{"pos": "abbr.", "gloss": "不能"}]  # ECDICT pos「vi.」误标被矫正
    assert cant.examples[0]["en"] == "I can't swim."
    assert cant.examples[0]["origin"] == "curated:g2u4-cant"


def test_g2a_phrase_curated_channel(enricher) -> None:
    """票 21：词组 curated 通道——ride a bicycle ECDICT 查无但 curated 显式覆盖，
    enrich miss 分支前置 curated 判定直接装配（取代票 19「进 E7」定案，用户授权
    改状态机）。音标零编造留 None；例句走 curated examples；phonics 词组不拆。
    其余查无词不受影响（test_missing_zero_fabrication 守卫 zorblat 仍 ecdict_miss）。"""
    result = enricher.enrich("ride a bicycle")
    assert result.status == "ok"
    assert result.miss_reason is None
    assert result.entry_id == "w_ride_a_bicycle"
    assert result.phonetic_uk is None and result.phonetic_us is None
    assert result.senses == [{"pos": "v.", "gloss": "骑自行车"}]
    assert result.examples[0]["en"] == "I can ride a bicycle."
    assert result.examples[0]["zh"] == "我会骑自行车。"
    assert result.examples[0]["origin"] == "curated:g2u4-phrase-ride-bike"
    assert result.phonics_split is None  # 词组不拆（非纯字母）


def test_g2b_template_zh_localized(enricher) -> None:
    """票 22：模板例句 zh 本土化——中文侧嵌首义 gloss 清洗形（{zh}），不再混排
    英文原词。覆盖 n（{zh} 直嵌＋多义「、」取首段）/v/adj（去尾「的」）三类模板
    与清洗规则；default/int 引号说词形保留 {word}（语义正确形态，票面豁免）；
    curated 例句优先级不变（family 票 22 核验兜底）。"""
    mum = enricher.enrich("mum")
    assert mum.examples[0] == {
        "en": "This is my mum.",
        "zh": "这是我的妈妈。",
        "origin": "template:t-n-my",
    }
    assert mum.examples[1]["zh"] == "我能看到妈妈。"  # 「一个」量词硬编码随之移除

    swim = enricher.enrich("swim")
    assert swim.examples[0]["zh"] == "我会游泳。"
    assert swim.examples[1]["zh"] == "我们一起游泳吧。"

    beautiful = enricher.enrich("beautiful")
    assert beautiful.examples[0]["zh"] == "它非常美丽。"  # adj gloss「美丽的」去尾「的」

    brother = enricher.enrich("brother")
    assert brother.examples[0]["zh"] == "这是我的哥哥。"  # 「哥哥、弟弟」取首段

    family = enricher.enrich("family")
    assert family.examples[0]["origin"] == "curated:g2u5-family"  # curated 优先不变
    assert family.examples[0]["zh"] == "这是我的家人。"


def test_g2b_zh_filler_rules() -> None:
    """票 22：_zh_filler 清洗规则单测（句号/多义并列/尾「的」/空 gloss 回退）。"""
    from app.pipeline.enrich import _zh_filler

    assert _zh_filler([{"gloss": "铅笔"}]) == "铅笔"
    assert _zh_filler([{"gloss": "美丽的"}]) == "美丽"  # adj 形态去尾
    assert _zh_filler([{"gloss": "的"}]) == "的"  # 单字不去（长度守卫）
    assert _zh_filler([{"gloss": "哥哥、弟弟"}]) == "哥哥"
    assert _zh_filler([{"gloss": "弹性， 适应性"}]) == "弹性"
    assert _zh_filler([{"gloss": "跑。"}]) == "跑"
    assert _zh_filler([{"gloss": ""}]) == ""
