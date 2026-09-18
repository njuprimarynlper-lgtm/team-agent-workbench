import { ZodError } from 'zod';

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const labels: Record<string, string> = { username: '登录账号', password: '密码', label: '用户组名称', host: '服务器地址', port: '端口', root: '共享根路径', name: '名称' };
    return [...new Set(error.issues.map(issue => /[\u4e00-\u9fff]/.test(issue.message) ? issue.message
      : `${labels[String(issue.path.at(-1))] || '输入内容'}填写不正确，请检查后重试`))].join('；');
  }
  return error instanceof Error ? error.message : String(error);
}
