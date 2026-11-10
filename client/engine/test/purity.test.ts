/**
 * 包结构纯度（票面验收「零依赖纯函数可被任意调用方 import（包结构可证）」）：
 * - package.json 零运行时依赖（dependencies/peerDependencies 不存在）
 * - src 全部 import 都是相对导入（不引任何包：无框架、无 I/O 库）
 * - src 源码（剥离注释后）无浏览器/Node 全局与时钟、随机源
 * - tsconfig 编译面无 DOM lib、无全局类型注入（浏览器 API 用了就编不过）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(?<=[^:])\/\/.*$/gm, '');
}

describe('包纯度（spec S2 铁律的机器可验证面）', () => {
  it('package.json 无 dependencies / peerDependencies（零运行时依赖）', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('src 全部模块导入都是相对导入（不感知 Vue/PixiJS/任何框架与 I/O 库）', () => {
    const files = readdirSync(join(pkgRoot, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, 'src', file), 'utf8');
      const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(spec.startsWith('.')).toBe(true);
      }
    }
  });

  it('src 源码（剥离注释）无浏览器/Node API、无时钟与随机源', () => {
    const files = readdirSync(join(pkgRoot, 'src')).filter((f) => f.endsWith('.ts'));
    const banned = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bnavigator\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\brequire\s*\(/,
      /\bprocess\b/,
      /\bBuffer\b/,
      /\bfs\b/,
      /\bDate\.now\b/,
      /\bnew\s+Date\s*\(\s*\)/,
      /\bMath\.random\b/,
      /\bperformance\.now\b/,
    ];
    for (const file of files) {
      const code = stripComments(readFileSync(join(pkgRoot, 'src', file), 'utf8'));
      for (const pattern of banned) {
        expect(code).not.toMatch(pattern);
      }
    }
  });

  it('tsconfig 编译面：lib 无 DOM、types 注入为空（浏览器 API 编译期即不可用）', () => {
    const tsconfig = JSON.parse(readFileSync(join(pkgRoot, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.lib).toEqual(['ES2020']);
    expect(tsconfig.compilerOptions.types).toEqual([]);
    expect(tsconfig.include).toEqual(['src']);
  });
});
