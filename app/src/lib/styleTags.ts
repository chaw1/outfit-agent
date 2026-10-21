/** Section 14.5: keep these words identical to the service's style vocabulary. */
export const STYLE_TAGS = ['松弛通勤', '老钱极简', '法式慵懒', '街头胶片', '杂志大片', '咖啡馆午后', '闪光灯夜拍', '复古港风', '户外野餐', '美术馆漫步', '雨天街角', '运动机能'] as const;

export function styleBatch(batch: number): string[] {
  const start = ((Math.floor(batch) * 8) % STYLE_TAGS.length + STYLE_TAGS.length) % STYLE_TAGS.length;
  return Array.from({ length: 8 }, (_, index) => STYLE_TAGS[(start + index) % STYLE_TAGS.length]);
}

export function toggleStyleTag(selected: readonly string[], tag: string): string[] {
  if (selected.includes(tag)) return selected.filter(value => value !== tag);
  return selected.length < 6 && STYLE_TAGS.some(value => value === tag) ? [...selected, tag] : [...selected];
}
