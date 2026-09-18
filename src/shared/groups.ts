// Workgroup naming rule, shared by the admin app and the member app, and mirrored by
// group_label() in server/admin.py: the local display name may be Chinese, while the
// Linux group name and the workspace path are derived from it.
export const groupLabelPattern = /^[\p{L}\p{N}][\p{L}\p{N}_·-]{0,23}$/u;
export const groupWorkspacePattern = /^\/projects\/[\p{L}\p{N}][\p{L}\p{N}_·-]{0,23}$/u;
export const groupLabelMessage = '用户组名称支持中文、字母、数字、下划线、短横线和间隔号，最多 24 个字符';
