/* 读样式表里的规则，给「这条规则里有没有这句」的测试用。只认顶层规则（不进 @media）。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function readStyles() {
  const css = await fs.readFile(path.join(root, 'src/ui/styles/atelier.css'), 'utf8');
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  /* 顶层规则：选择器从行首开始，右花括号也在行首。 */
  for (const match of text.matchAll(/^([^\s@}][^{}]*?)\s*\{\n([\s\S]*?)\n\}/gm)) {
    const selectors = match[1].split(',').map(item => item.trim().replace(/\s+/g, ' '));
    const declarations = new Map();
    for (const line of match[2].split('\n')) {
      const pair = /^\s*([\w-]+):\s*(.+?);?\s*$/.exec(line);
      if (pair) declarations.set(pair[1], pair[2]);
    }
    rules.push({ selectors, declarations });
  }
  return {
    css,
    /* 选择器列表里有 selector 的所有规则合起来（后写的盖住先写的）。 */
    rule(selector) {
      const merged = new Map();
      for (const item of rules) {
        if (!item.selectors.includes(selector)) continue;
        for (const [name, value] of item.declarations) merged.set(name, value);
      }
      return merged;
    },
  };
}
