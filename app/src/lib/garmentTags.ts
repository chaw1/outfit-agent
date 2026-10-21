export interface TaggedGarment { tags?: string[] }
export interface GarmentTagCount { tag: string; count: number }
export interface GarmentTagPage { items: GarmentTagCount[] }

export function toggleGarmentTag(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

export function filterGarmentsByTag<T extends TaggedGarment>(items: readonly T[], tag: string | null): T[] {
  return items.filter(item => !tag || item.tags?.includes(tag));
}

export function garmentTagCounts(items: readonly TaggedGarment[]): GarmentTagCount[] {
  const counts = new Map<string, number>();
  for (const item of items) for (const tag of new Set(item.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
