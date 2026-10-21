export function errorText(error: unknown): string { return error instanceof Error ? error.message : '连接有点问题，请稍后重试。'; }
export const stageNames: Record<string, string> = { brief: '整理需求', direction: '选择方向', script: '打磨脚本', images: '挑选图片', note: '笔记就绪', video: '制作视频', done: '已完成' };
