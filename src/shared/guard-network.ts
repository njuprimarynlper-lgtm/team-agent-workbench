export const guardNetworkStages = ['certificate', 'proxy_connect', 'target_tls', 'upstream'] as const;
export type GuardNetworkStage = typeof guardNetworkStages[number];
const certificateCodes = ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'];
const knownCodes = [...certificateCodes, 'CA_FILE_UNREADABLE', 'CA_FILE_INVALID', 'SYSTEM_CA_UNAVAILABLE', 'PROXY_403', 'PROXY_407', 'PROXY_REJECTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO', 'ABORT_ERR', 'NETWORK_ERROR'];
export interface GuardNetworkProblem { stage: GuardNetworkStage; code: string; viaProxy: boolean; }
export function guardNetworkCode(code: unknown) { return typeof code === 'string' && knownCodes.includes(code) ? code : 'NETWORK_ERROR'; }
export function guardCertificateProblem(problem: GuardNetworkProblem) { return certificateCodes.includes(problem.code) || problem.stage === 'certificate'; }
export function guardNetworkMessage(problem: GuardNetworkProblem) {
  if (problem.code === 'CA_FILE_UNREADABLE') return '无法读取指定的企业证书，请重新选择证书文件。';
  if (problem.code === 'CA_FILE_INVALID') return '企业证书文件无效，请选择有效的 CA 证书文件。';
  if (problem.code === 'SYSTEM_CA_UNAVAILABLE') return '无法读取系统信任证书，请更新工作台运行环境后重试。';
  if (problem.code === 'CERT_HAS_EXPIRED') return '连接使用的证书已过期，请联系网络管理员更新证书。';
  if (problem.code === 'CERT_NOT_YET_VALID') return '连接使用的证书尚未生效，请检查电脑时间或联系网络管理员。';
  if (problem.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return '连接使用的证书与目标地址不匹配，请联系网络管理员。';
  if (guardCertificateProblem(problem)) return problem.viaProxy ? '无法验证代理连接提供的证书，请检查企业证书设置。' : '无法验证模型服务的证书，请检查企业证书设置。';
  if (problem.code === 'PROXY_407') return '代理要求身份验证，请检查本机代理的账号配置。';
  if (problem.code === 'PROXY_403' || problem.code === 'PROXY_REJECTED') return '代理拒绝访问模型服务，请联系网络管理员确认访问权限。';
  if (problem.code === 'ETIMEDOUT') return problem.stage === 'proxy_connect' ? '连接代理超时，请检查本机代理是否可用。' : '连接模型服务超时，请检查当前网络出口。';
  if (problem.code === 'ABORT_ERR') return '连接检测或请求已取消。';
  if (problem.code === 'ENOTFOUND' || problem.code === 'EAI_AGAIN') return '无法解析连接地址，请检查网络或代理地址。';
  return problem.stage === 'proxy_connect' ? '无法连接代理，请检查本机代理是否可用。' : '连接模型服务失败，请检查当前网络出口。';
}
export function guardNetworkMarker(problem: GuardNetworkProblem) { return `[WB_NET|${problem.stage}|${guardNetworkCode(problem.code)}|${problem.viaProxy ? 'proxy' : 'local'}]`; }
export function parseGuardNetworkProblem(text: string): GuardNetworkProblem | undefined {
  const match = /\[WB_NET\|(certificate|proxy_connect|target_tls|upstream)\|([A-Z0-9_]+)\|(proxy|local)\]/.exec(text);
  if (match) return { stage: match[1] as GuardNetworkStage, code: guardNetworkCode(match[2]), viaProxy: match[3] === 'proxy' };
}
export const guardNetworkStageLabels: Record<GuardNetworkStage, string> = { certificate: '读取信任证书', proxy_connect: '连接代理', target_tls: '验证模型服务证书', upstream: '访问模型服务' };
export type GuardConnectionCheck = { ok: boolean; viaProxy?: boolean; problem?: GuardNetworkProblem; message: string };
