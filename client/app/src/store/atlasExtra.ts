/**
 * 词光拓展资料查询（票 56；wordsfunny 词详情页吸收面）。
 *
 * 数据＝构建期从 word-atlas CC BY 4.0 数据集提取的本仓交集词拓展字段
 * （tip 用法提示／col 搭配／syn 同义词／ant 反义词／fam 同根词——构建脚本
 * 见票 56 工件；AI 生成未经人工审校，视图层一律标注「拓展资料」来源行）。
 * 按归一化词形查询（casefold＋空白折叠，normalize_word 同口径）；未命中
 * 返回 null＝拓展区整体不渲染（宁缺勿滥）。
 */
import atlasData from '../assets/atlas-extra.json';

/** 拓展资料记录（字段全可选——视图空段不渲染）。 */
export interface AtlasExtra {
  tip?: string;
  col?: string[];
  syn?: string[];
  ant?: string[];
  fam?: string[];
}

/** 数据集署名（详情页页脚展示面）。 */
export const ATLAS_SOURCE: string =
  typeof atlasData === 'object' && atlasData !== null && '_source' in atlasData
    ? String((atlasData as { _source: unknown })._source)
    : 'Word Atlas contributors · CC BY 4.0';

const BY_WORD: ReadonlyMap<string, AtlasExtra> = (() => {
  const words =
    typeof atlasData === 'object' && atlasData !== null && 'words' in atlasData
      ? (atlasData as { words: Record<string, AtlasExtra> }).words
      : {};
  return new Map(Object.entries(words));
})();

function norm(word: string): string {
  return word.toLowerCase().trim().split(/\s+/).join(' ');
}

/** 查拓展资料；未命中返回 null（拓展区不渲染）。 */
export function atlasExtraFor(word: string): AtlasExtra | null {
  return BY_WORD.get(norm(word)) ?? null;
}

/** 命中词数（测试/诊断面）。 */
export function atlasExtraCount(): number {
  return BY_WORD.size;
}
