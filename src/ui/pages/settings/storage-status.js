/* 设置页「数据文件」那两行：画廊索引、生成记录现在是拆开存的还是整份存的。
   手机上看不到控制台，拆分没成功时这里是唯一能看到原因的地方。 */
function line(name, unit, status) {
  if (!status || status.mode === 'unloaded') return '';
  const total = `${status.records} ${unit}`;
  if (status.mode === 'segmented') {
    const problem = status.error ? `；最近一次后台写入没成功（${status.error}），下次写入时再试` : '';
    return `${name}：已拆成 ${status.segments} 份小文件，共 ${total}${problem}`;
  }
  if (status.migrating) return `${name}：还是一整份文件，正在后台拆成小文件（共 ${total}），拆完之前照旧能用`;
  if (status.error) return `${name}：还是一整份文件，拆分没成功（${status.error}）。照旧能用，过一会儿或下次打开页面再试`;
  return `${name}：还是一整份文件（共 ${total}），等着拆分`;
}

export function describeStorage({ gallery = null, attempts = null } = {}) {
  return [line('画廊索引', '张图的记录', gallery), line('生成记录', '条', attempts)].filter(Boolean);
}
