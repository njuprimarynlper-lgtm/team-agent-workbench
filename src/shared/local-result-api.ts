import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectConclusion } from './types';
import { resultCategories, resultStatusSchema } from './result-model';
import { resultFolderIdSchema, resultDirectoryCommandSchema } from './result-directories';

const fields = {
  title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(2 * 1024 * 1024),
  category: z.enum(resultCategories), resultStatus: resultStatusSchema, resultOwner: z.string().max(160),
};
export const resultCreateSchema = z.object({ ...fields, category: fields.category.default('exploration'), resultStatus: fields.resultStatus.optional(), resultOwner: fields.resultOwner.optional(), folderId: resultFolderIdSchema.optional() }).strict();
export const resultUpdateSchema = z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0, '至少提供一个更新字段');
export const resultArchiveSchema = z.object({ archived: z.boolean() }).strict();
export const resultMoveSchema = z.object({ folderId: resultFolderIdSchema }).strict();
export const resultUploadNameSchema = z.string().min(1).max(120).refine(name => !/[<>:"|?*\x00-\x1f/\\]/u.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), '请使用普通文件名，不包含目录、控制字符或系统保留名称');
export const localResultSchemas = { CreateResult: resultCreateSchema, UpdateResult: resultUpdateSchema, ArchiveResult: resultArchiveSchema, MoveResult: resultMoveSchema, DirectoryCommand: resultDirectoryCommandSchema };

/** Includes attachments and directory changes, whose revision is independent of body version. */
export function localResultEtag(item: ProjectConclusion) {
  return '"' + createHash('sha256').update(JSON.stringify([item.id, item.version, item.title, item.content, item.category, item.resultStatus, item.resultOwner,
    item.archived, item.deletedAt, item.folderId, item.folderVersion, item.updatedAt,
    (item.localFiles || []).map(file => [file.id, file.name, file.sha256, file.size])])).digest('hex') + '"';
}

export class LocalResultPreconditionError extends Error {
  constructor() { super('成果已更新，请重新读取后再修改；本次操作未覆盖新版本'); }
}
export function assertLocalResultEtag(item: ProjectConclusion, expected?: string) {
  if (expected !== undefined && localResultEtag(item) !== expected) throw new LocalResultPreconditionError();
}

export interface LocalResultApiConfig {
  version: 1; baseUrl: string; token: string; projectId: string; projectName: string;
  skillPath: string; clientPath: string;
}

export function localResultOpenApi() {
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const error = { description: '操作失败；JSON 包含 error.code 和 error.message' };
  const operation = (id: string, schema?: string, mutation = false, conditional = false) => ({
    operationId: id, security: [{ bearerAuth: [] }],
    parameters: [
      ...(mutation ? [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }] : []),
      ...(conditional ? [{ in: 'header', name: 'If-Match', required: true, description: '读取成果返回的完整 ETag，包含引号', schema: { type: 'string' } }] : []),
    ],
    ...(schema ? { requestBody: { required: true, content: json({ $ref: '#/components/schemas/' + schema }) } } : {}),
    responses: { '200': { description: '成功；写入返回 id、version、etag 等轻量回执，读取返回成果或分页列表' }, '400': error, '401': error, '403': error, '404': error, '409': error, '412': error, '413': error, '415': error, '428': error, '500': error },
  });
  const pathId = (name: string) => ({ in: 'path', name, required: true, schema: { type: 'string', format: 'uuid' } });
  return {
    openapi: '3.1.0', info: { title: '工作台个人成果 API', version: '1.0.0', description: '当前账号、当前项目的本机接口。所有请求需 Bearer Token。写入需幂等键，已有成果修改需 If-Match。不会修改团队成果。' },
    servers: [{ url: './' }],
    paths: {
      '/context': { get: operation('getContext') }, '/openapi.json': { get: operation('getOpenApi') },
      '/results': { get: { ...operation('listResults'), parameters: [{ in: 'query', name: 'q', schema: { type: 'string' } }, { in: 'query', name: 'includeArchived', schema: { type: 'boolean', default: false } }, { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0, default: 0 } }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }] }, post: operation('createResult', 'CreateResult', true) },
      '/results/{id}': { parameters: [pathId('id')], get: operation('getResult'), patch: operation('updateResult', 'UpdateResult', true, true), delete: operation('deleteLocalResult', undefined, true, true) },
      '/results/{id}/archive': { parameters: [pathId('id')], post: operation('archiveResult', 'ArchiveResult', true, true) },
      '/results/{id}/move': { parameters: [pathId('id')], post: operation('moveResult', 'MoveResult', true, true) },
      '/results/{id}/attachments': { parameters: [pathId('id')], post: { ...operation('uploadAttachment', undefined, true, true), parameters: [...operation('', undefined, true, true).parameters, { in: 'query', name: 'name', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary', description: '文件原始字节，最大 2 GiB' } } } } } },
      '/results/{id}/attachments/{fileId}': { parameters: [pathId('id'), pathId('fileId')], get: { ...operation('downloadAttachment'), responses: { '200': { description: '文件字节流', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, '404': error, '409': error } }, delete: operation('removeAttachment', undefined, true, true) },
      '/directories': { get: operation('listDirectories'), post: operation('changeDirectory', 'DirectoryCommand', true) },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: Object.fromEntries(Object.entries(localResultSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })])) },
  };
}
