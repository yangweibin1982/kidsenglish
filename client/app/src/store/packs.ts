/**
 * 词包数据源（spec S1「内容包不同步、只拉取」；票 22 换装＝内置官方包
 * 1上 v4 全量 bundle 副本进 app 资产；票 35 多包化＝按档案册次绑定生效）。
 *
 * - 源：server 发布的官方 bundle（沪教牛津（深圳专版），manifest.json＋
 *   units/unit-XX.json，逐文件 SHA-256 清单随包）。拷贝自
 *   server/data/packs/official/.../<版本>/，构建期内联。
 *   official-1a-v4＝票 22 模板例句 zh 本土化发布（pack_id=5）：105 词。
 *   official-2a-v2＝2 上现行发布（pack_id=6）：113 词（ride a bicycle 在包）。
 * - 完整性：内置副本随代码走 SHA 校验面（远端拉取＋校验流程归内容域票，本票
 *   不做网络取包——server /api/packs 尚为 501 桩）。
 * - 词序＝教学序：unit_no 升序 → ordinal 升序（新词队列的课程顺序依据）。
 * - 释义取 senses 首条 gloss（复习段「看词选义」的选项来源）。
 * - 票 51 词义呈现投影：phoneticUk／senses（词性+释义）／examples（双语例句）
 *   三字段随投影放行——新词读步「词性徽章＋释义＋音标＋例句」数据源；
 *   空值剔除宁缺勿滥（音标空＝null、无 gloss 义项不收录、en 空例句不收录）。
 * - unitNo：词条所属单元；buildQuestion 干扰项「先同单元」的依据。
 * - 票 35 语义分工：**绑定包**（新词队列教学序来源，按档案 startPoint 解析）
 *   与**并集包**（复习查词/出题干扰项的超集面——跨包进度保留语义下，旧包
 *   到期卡的词义查询必须可命中），二者由 learningData 分别持有。
 */

/** 词包词条（word_versions 概念字段的视图投影）。 */
export interface PackWord {
  entryId: string;
  word: string;
  /** 首义项 gloss（无义项时回退空串，出题层跳过）。 */
  meaning: string;
  /** 拼读拆分原值（"pen·cil"；null＝无拆分，整词呈现）。 */
  phonicsSplit: string | null;
  /** 所属单元号（教学单元；v3 bundle 起随单元文件自带）。 */
  unitNo: number;
  /** 英式音标原值（不带斜杠，如 "hə'ləu"；null＝无数据显示面——票 51）。 */
  phoneticUk: string | null;
  /** 义项投影（词性可空＝徽章隐藏面；gloss 非空才收录——票 51）。 */
  senses: { pos: string | null; gloss: string }[];
  /** 双语例句投影（en 空的条目剔除；zh 可空串——票 51）。 */
  examples: { en: string; zh: string }[];
}

/** 装载产物：有序词表（教学序）＋ entryId 索引。 */
export interface PackLexicon {
  packId: string;
  ordered: PackWord[];
  byId: ReadonlyMap<string, PackWord>;
}

interface UnitWordRaw {
  lexical_entry_id?: unknown;
  headword?: unknown;
  ordinal?: unknown;
  phonics_split?: unknown;
  senses?: unknown;
  phonetic_uk?: unknown;
  examples?: unknown;
}

interface UnitRaw {
  unit_no?: unknown;
  title?: unknown;
  words?: unknown;
}

/** 构建期内联全部官方包单元文件（?raw 原文，运行期解析＋轻校验；packId 取目录段）。 */
const unitModules = import.meta.glob('../assets/pack/official-*/units/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/**
 * 册次 → 包目录映射（票 44 小学扩围：'3上'~'6上' 上线课本级词表（国家智慧教育
 * 平台扫描页＋GitHub ChinaTextbook 旧版 PDF 实录，795 词）——小学主线 1上~6上
 * 全通。票 46 高中轮：'必修一'~'选必四' 上线人教版（2019年版）7 册
 * ——必修一/选必一/选必二为 v2〔v1 单元题名有缺陷：必修一 Welcome 合并、
 * 选必一 U5/选必二 U4 题名误〕，其余 v1。未上线册次走 DEFAULT_PACK_ID 回退。）
 */
/** 票 54 拼读拆分全库纠正：25 册全部重发新版本（pyphen 词典主源；词数逐册对账一致），
 *  册次指针整体 bump；旧版本目录 server 侧保留（版本化不可变），client 资产只留现行。 */
const START_POINT_TO_PACK: Record<string, string> = {
  '1上': 'official-1a-v6',
  '1下': 'official-1b-v2',
  '2上': 'official-2a-v6',
  '2下': 'official-2b-v2',
  '3上': 'official-3a-v3', // 2026-11-08 例句纠正轮（her 报障）：pron 空模板＋31 词 curated，13 册重发 v3
  '3下': 'official-3b-v3',
  '4上': 'official-4a-v3',
  '4下': 'official-4b-v3',
  '5上': 'official-5a-v3',
  '6上': 'official-6a-v3',
  '5下': 'official-5b-v3',
  '6下': 'official-6b-v3',
  '7上': 'official-7a-v2',
  '7下': 'official-7b-v3',
  '8上': 'official-8a-v2',
  '8下': 'official-8b-v2',
  '9上': 'official-9a-v2',
  '9下': 'official-9b-v3',
  '必修一': 'official-bx1-v4',
  '必修二': 'official-bx2-v2',
  '必修三': 'official-bx3-v3',
  '选必一': 'official-xb1-v4',
  '选必二': 'official-xb2-v3',
  '选必三': 'official-xb3-v2',
  '选必四': 'official-xb4-v2',
};

/** 缺省包（现行版 1上；旧档案空起点语义随版本轮切新包，旧进度词形不命中即冷启动——票 42 V4）。 */
export const DEFAULT_PACK_ID = 'official-1a-v6';

/** 从 glob key 提取包目录名：'../assets/pack/official-1a-v4/units/unit-01.json' → 'official-1a-v4'。 */
function packIdFromPath(path: string): string {
  const m = /assets\/pack\/(official-[^/]+)\/units\//.exec(path);
  return m ? m[1] : '';
}

/** 在册包 id 集（glob 实际命中的目录）。 */
const AVAILABLE_PACK_IDS = new Set(
  Object.keys(unitModules)
    .map(packIdFromPath)
    .filter((id) => id.length > 0),
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 解析单个单元 JSON（坏词条跳过不硬炸；返回空数组即整单元不可用）。 */
function parseUnit(raw: string): { unitNo: number; words: PackWord[] } {
  const unit = JSON.parse(raw) as UnitRaw;
  if (!isRecord(unit) || !Array.isArray(unit.words)) return { unitNo: 0, words: [] };
  const unitNo = typeof unit.unit_no === 'number' ? unit.unit_no : 0;
  const words: PackWord[] = [];
  for (const item of unit.words) {
    if (!isRecord(item)) continue;
    const w = item as UnitWordRaw;
    const entryId = str(w.lexical_entry_id);
    const word = str(w.headword);
    if (!entryId || !word) continue;
    const senses = Array.isArray(w.senses) ? w.senses : [];
    const first = senses.find(isRecord);
    // 票 51 词义呈现投影：义项（pos 可空、gloss 非空才收录）＋双语例句（en 空剔除）
    const projectedSenses = senses
      .filter(isRecord)
      .map((s) => ({ pos: str(s.pos).trim() || null, gloss: str(s.gloss).trim() }))
      .filter((s) => s.gloss.length > 0);
    const examples = Array.isArray(w.examples) ? w.examples : [];
    const projectedExamples = examples
      .filter(isRecord)
      .map((e) => ({ en: str(e.en).trim(), zh: str(e.zh).trim() }))
      .filter((e) => e.en.length > 0);
    const phoneticUk = str(w.phonetic_uk).trim();
    words.push({
      entryId,
      word,
      meaning: first ? str(first.gloss) : '',
      phonicsSplit: typeof w.phonics_split === 'string' && w.phonics_split.length > 0 ? w.phonics_split : null,
      unitNo,
      phoneticUk: phoneticUk.length > 0 ? phoneticUk : null,
      senses: projectedSenses,
      examples: projectedExamples,
    });
  }
  return { unitNo, words };
}

const packCache = new Map<string, PackLexicon>();

/** 组装单包（教学序去重；模块级按包缓存）。 */
function buildPack(packId: string): PackLexicon {
  const cached = packCache.get(packId);
  if (cached) return cached;
  const units = Object.entries(unitModules)
    .filter(([path]) => packIdFromPath(path) === packId)
    .map(([path, raw]) => ({
      path,
      ...parseUnit(raw),
    }));
  units.sort((a, b) => (a.unitNo !== b.unitNo ? a.unitNo - b.unitNo : a.path.localeCompare(b.path)));

  const ordered: PackWord[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    for (const w of unit.words) {
      if (seen.has(w.entryId)) continue; // 跨单元重复词只保首次引入位
      seen.add(w.entryId);
      ordered.push(w);
    }
  }
  const lexicon: PackLexicon = {
    packId,
    ordered,
    byId: new Map(ordered.map((w) => [w.entryId, w])),
  };
  packCache.set(packId, lexicon);
  return lexicon;
}

/**
 * 册次绑定解析（票 35）：startPoint → { packId, fallback }。
 * 未上线册次（0起步/1下/…/6下）或空值回退缺省包并标 fallback（首页提示面）。
 * 纯函数独立导出＝回归测试面。
 */
export function resolvePackId(startPoint: string | null | undefined): { packId: string; fallback: boolean } {
  const mapped = startPoint !== null && startPoint !== undefined ? START_POINT_TO_PACK[startPoint] : undefined;
  if (mapped !== undefined && AVAILABLE_PACK_IDS.has(mapped)) {
    return { packId: mapped, fallback: false };
  }
  // startPoint 为空＝旧档案无绑定（单孩遗留态）→ 缺省包不算 fallback（历史语义原样）
  const fallback = startPoint !== null && startPoint !== undefined && startPoint !== '';
  return { packId: DEFAULT_PACK_ID, fallback };
}

/** 按包 id 装载（未在册 id 抛错——调用面应先经 resolvePackId）。 */
export function loadPack(packId: string): PackLexicon {
  if (!AVAILABLE_PACK_IDS.has(packId)) {
    throw new Error(`词包不在册：${packId}（在册：${[...AVAILABLE_PACK_IDS].sort().join(', ')}）`);
  }
  return buildPack(packId);
}

/** 缺省包（现行版 1上；loadBuiltinPack 历史语义保持）。 */
export function loadBuiltinPack(): PackLexicon {
  return loadPack(DEFAULT_PACK_ID);
}

let unionCache: PackLexicon | null = null;

/**
 * 全包并集（复习查词/出题超集面）：ordered＝按包序拼接去重，byId＝全量索引。
 * 跨包进度保留语义：孩子换绑定包后，旧包到期卡的词义查询必须可命中。
 */
export function loadPackUnion(): PackLexicon {
  if (unionCache) return unionCache;
  const ordered: PackWord[] = [];
  const seen = new Set<string>();
  for (const packId of [...AVAILABLE_PACK_IDS].sort()) {
    for (const w of buildPack(packId).ordered) {
      if (seen.has(w.entryId)) continue;
      seen.add(w.entryId);
      ordered.push(w);
    }
  }
  unionCache = {
    packId: 'union',
    ordered,
    byId: new Map(ordered.map((w) => [w.entryId, w])),
  };
  return unionCache;
}

/** 在册包数（测试/诊断面）。 */
export function availablePackCount(): number {
  return AVAILABLE_PACK_IDS.size;
}
