"""Root-owned storage worker. Authentication is the SSH-created file's OS UID.

No network listener, model, application password, or arbitrary command execution.
Canonical public files are read-only to SFTP users; all writes pass this allowlist.
"""
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid

if "acl_apply" not in globals():
    exec(compile(pathlib.Path(__file__).with_name("acl_support.py").read_text(encoding="utf-8"), "acl_support.py", "exec"))

CONTRIBUTION_FOLDERS = {
    'experiment_result': 'experiments',
    'failed_direction': 'failed-directions',
    'finding': 'findings',
    'project_standard': 'project-standards',
    'method_exploration': 'method-explorations',
    'issue': 'issues',
    'baseline_change_proposal': 'baseline-change-proposals',
    'requirement': 'requirements', 'design': 'designs', 'verification': 'verifications',
    'troubleshooting': 'troubleshooting', 'guide': 'guides', 'research': 'research', 'comparison': 'comparisons',
}
CONTRIBUTION_FIELDS = {
    'experiment_result': {'objective', 'change', 'environment', 'baseline', 'result', 'evidence', 'scope', 'limitations', 'nextSteps'},
    'failed_direction': {'objective', 'approach', 'failure', 'evidence', 'likelyCause', 'avoidWhen', 'reusableInsight'},
    'finding': {'statement', 'evidence', 'scope', 'uncertainty', 'nextSteps'},
    'project_standard': {'statement', 'evidence', 'scope'},
    'method_exploration': {'approach', 'uncertainty', 'nextSteps'},
    'issue': {'problem', 'trigger', 'impact', 'evidence', 'reproduction', 'workaround', 'nextAction'},
    'baseline_change_proposal': {'baselineItem', 'currentValue', 'proposedValue', 'rationale', 'evidence', 'impact', 'validationNeeded'},
    'requirement': {'statement', 'scope', 'evidence'}, 'design': {'approach', 'rationale', 'limitations'},
    'verification': {'result', 'evidence', 'limitations'}, 'troubleshooting': {'problem', 'likelyCause', 'workaround'},
    'guide': {'scope', 'approach', 'result'}, 'research': {'statement', 'evidence', 'scope'}, 'comparison': {'approach', 'evidence', 'limitations'},
}

MAX_FILE = 2 * 1024 ** 3
BRIEF_FIELDS = [('background', '项目背景'), ('objectives', '项目目标'), ('acceptance', '验收标准'), ('scope', '范围与非目标'), ('deliverables', '交付物与里程碑'), ('resources', '现有资料与入口'), ('constraints', '约束与风险'), ('collaboration', '协作约定')]

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def safe(root, relative):
    if not isinstance(relative, str) or '\\' in relative or any(ord(c) < 32 for c in relative):
        raise ValueError('非法文件路径')
    parts = relative.lstrip('/').split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('非法文件路径')
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise PermissionError('不允许符号链接')
    return current

def atom(file, data, gid=None):
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.parent / ('.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as handle:
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, 0o600 if gid is None else 0o640)
        if gid is not None:
            os.chown(temp, 0, gid)
        os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)

def read_json(file, default=None):
    try:
        return json.loads(file.read_text(encoding='utf-8'))
    except FileNotFoundError:
        if default is not None:
            return default
        raise

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def text(value, maximum=2 * 1024 * 1024):
    if not isinstance(value, str) or len(value) > maximum or '\x00' in value:
        raise ValueError('无效文本或内容过长')
    return value

def brief_value(value):
    if not isinstance(value, dict):
        raise ValueError('请填写项目资料')
    result = {key: text(value.get(key, ''), 6000).strip() for key, _ in BRIEF_FIELDS}
    if any(not result[key] for key, _ in BRIEF_FIELDS[:3]):
        raise ValueError('项目背景、目标、验收标准不能为空')
    return result

def public_dir(directory, gid):
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    for target in list(reversed(missing)) + ([] if directory in missing else [directory]):
        target.mkdir(exist_ok=True)
        os.chown(target, 0, gid)
        acl_apply(['-b', '-k', str(target)])
        os.chmod(target, 0o2750)


def publish_bytes(file, payload, gid):
    public_dir(file.parent, gid)
    temp = file.parent / ('.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('xb') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temp, 0, gid)
        os.chmod(temp, 0o640)
        os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)

def member(state, username):
    user = state['users'].get(username)
    if not user or not user.get('enabled') or user.get('missing') or user.get('provisioning'):
        raise PermissionError('账号已停用或身份已改变，请重新登录')
    return user

def locate(root, state, user, project_id):
    for group_name in user.get('groups', []):
        group = state['groups'].get(group_name)
        if not group or not group.get('workspace') or group.get('provisioning'):
            continue
        base = safe(root, group['workspace'])
        for directory in base.iterdir():
            if directory.is_symlink() or not directory.is_dir() or directory.name.startswith('.'):
                continue
            marker = safe(root, directory.relative_to(root).as_posix() + '/.workbench-project.json')
            data = read_json(marker, {})
            if data.get('id') == project_id:
                return directory, data, group_name, group
    raise PermissionError('项目不存在或当前账号不属于此组')

def assignment_hashes(file):
    sha, md5, size = hashlib.sha256(), hashlib.md5(usedforsecurity=False), 0
    with file.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            sha.update(chunk); md5.update(chunk); size += len(chunk)
    return dict(sha256=sha.hexdigest(), md5=md5.hexdigest(), size=size)


def assignment_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def assignment_stage(root, project_id, username, task_id, file_id):
    for identifier in [task_id, file_id]:
        if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
            raise ValueError('任务附件编号无效')
    owner = hashlib.sha256(username.encode()).hexdigest()
    return safe(root, f'.workbench/admin/assignment-stage/{project_id}/{owner}/{task_id}/{file_id}')


def assignment_blob(root, project_id, assignee, file):
    if not re.fullmatch(r'[a-f0-9]{32}', file.get('md5', '')) or not re.fullmatch(r'[a-f0-9]{64}', file.get('sha256', '')) or type(file.get('size')) is not int or not 0 <= file['size'] <= MAX_FILE:
        raise ValueError('任务附件身份无效')
    scope = assignment_digest([project_id, assignee, 'group-admins'])
    return safe(root, f'.workbench/admin/assignment-blobs/{scope}/{file["md5"]}/{file["sha256"]}-{file["size"]}')


def assignment_clear_stages(root, project_id, username, task_id, upload_ids):
    for identifier in upload_ids:
        staged = assignment_stage(root, project_id, username, task_id, identifier)
        for file in [staged, staged.with_name(staged.name + '.json')]:
            with contextlib.suppress(OSError):
                file.unlink(missing_ok=True)


def assignment_resolve(root, project_id, assignee, task_id, file):
    identifier = file.get('id', '')
    if not re.fullmatch(r'[a-f0-9]{64}', identifier):
        raise ValueError('任务附件编号无效')
    parent = safe(root, f'.workbench/admin/assignment-links/{project_id}/{task_id}')
    link, blob = parent / identifier, assignment_blob(root, project_id, assignee, file)
    if file.get('path') != '/' + link.relative_to(root).as_posix():
        raise ValueError('任务附件路径无效')
    # Only this root-owned leaf link may resolve; generic safe() remains symlink-denying.
    if link.is_symlink():
        if link.resolve() != blob.resolve():
            raise PermissionError('任务附件链接越界')
    elif os.name != 'nt' or not link.is_file() or not os.path.samefile(link, blob):
        raise PermissionError('任务附件链接无效')
    if assignment_hashes(blob) != {key: file[key] for key in ['sha256', 'md5', 'size']}:
        raise ValueError('任务附件存储校验失败')
    return blob


def assignment_store(root, project_id, assignee, task_id, source, name, sha, size, origin):
    name = text(name, 240)
    if not name or re.search(r'[/\\\x00-\x1f]', name):
        raise ValueError('附件名称无效')
    hashes = assignment_hashes(source)
    if hashes['sha256'] != sha or hashes['size'] != size or size > MAX_FILE:
        raise ValueError('任务附件快照校验失败')
    blob = assignment_blob(root, project_id, assignee, hashes)
    blob.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(blob.parent, 0o700)
    if not blob.exists():
        temp = blob.parent / ('.' + uuid.uuid4().hex)
        try:
            shutil.copyfile(source, temp); os.chmod(temp, 0o600); os.replace(temp, blob)
        finally:
            temp.unlink(missing_ok=True)
    if assignment_hashes(blob) != hashes:
        raise ValueError('去重文件已损坏，不会覆盖')
    identifier = assignment_digest([name, sha])
    parent = safe(root, f'.workbench/admin/assignment-links/{project_id}/{task_id}')
    parent.mkdir(parents=True, exist_ok=True); os.chmod(parent, 0o700)
    link = parent / identifier
    if not link.exists() and not link.is_symlink():
        if os.name == 'nt':
            os.link(blob, link)  # Windows business-rule tests; deployed Linux always uses symlinks.
        else:
            os.symlink(os.path.relpath(blob, parent), link)
    result = dict(id=identifier, name=name, **hashes, path='/' + link.relative_to(root).as_posix(), source=origin)
    assignment_resolve(root, project_id, assignee, task_id, result)
    return result


def assignment_snapshot(root, directory, project_id, assignee, identifier, username, selections, upload_ids, origin):
    content = read_json(directory / '.workbench-content.json', [])
    references = []
    candidates = []
    for selection in selections:
        item = next((value for value in content if value['id'] == selection['id'] and value['revision'] == selection['revision'] and value['kind'] in ('contribution', 'file')), None)
        if not item:
            raise ValueError('关联结论已更新或移除，请刷新后重新选择')
        if item['kind'] == 'file':
            source_file = safe(root, item['path'])
            relative = source_file.relative_to(directory)
            if any(part.startswith('.') for part in relative.parts):
                raise PermissionError('关联共享文件路径无效')
            candidates.append((source_file, source_file.name, item['sha256'], item['size'], item['title']))
        selected_hashes = selection.get('attachmentHashes')
        attachments = item.get('attachments', [])
        if selected_hashes is not None and (not isinstance(selected_hashes, list) or len(selected_hashes) > 30 or any(not any(entry['sha256'] == sha for entry in attachments) for sha in selected_hashes)):
            raise ValueError('关联附件已变化，请刷新后重新选择')
        for entry in attachments:
            if selected_hashes is not None and entry['sha256'] not in selected_hashes:
                continue
            expected = '/' + directory.relative_to(root).as_posix() + '/.workbench-attachments/'
            if not entry['path'].startswith(expected):
                raise PermissionError('关联附件路径无效')
            candidates.append((safe(root, entry['path']), entry['name'], entry['sha256'], entry['size'], item['title']))
        references.append(dict(id=item['id'], revision=item['revision'], title=item['title'], category=item.get('category'), kind=item['kind'], content=item['description'], author=item['author'], updatedAt=item['updatedAt']))
    for upload_id in upload_ids:
        staged = assignment_stage(root, project_id, username, identifier, upload_id)
        receipt = read_json(staged.with_name(staged.name + '.json'))
        if receipt['id'] != upload_id:
            raise ValueError('任务附件回执无效')
        candidates.append((staged, receipt['name'], receipt['sha256'], receipt['size'], origin))
    unique = {(entry[1], entry[2]): entry for entry in candidates}
    if len(unique) > 30:
        raise ValueError('单个任务最多关联 30 个文件')
    files = [assignment_store(root, project_id, assignee, identifier, *entry) for entry in unique.values()]
    return references, files


def assignment_all_files(task):
    return task.get('files', []) + [file for submission in task.get('submissions', []) for file in submission.get('files', [])]


def assignment_release(root, task, tasks):
    retained = [file for other in tasks if not other.get('purgedAt') and other['assignee'] == task['assignee'] and other['projectId'] == task['projectId'] for file in assignment_all_files(other)]
    unused = set()
    for file in {file['id']: file for file in assignment_all_files(task)}.values():
        blob = assignment_resolve(root, task['projectId'], task['assignee'], task['id'], file)
        parent = safe(root, f".workbench/admin/assignment-links/{task['projectId']}/{task['id']}")
        (parent / file['id']).unlink()
        if not any(all(other[key] == file[key] for key in ('sha256', 'md5', 'size')) for other in retained):
            unused.add(blob)
    for blob in unused:
        blob.unlink()


def assignment_operation(root, state, username, request, directory, project, group_name, admin, incoming=None):
    op = request['op']
    eligible = {name: user for name, user in state['users'].items() if user.get('enabled') and not user.get('missing') and not user.get('provisioning') and group_name in user.get('groups', [])}
    if op == 'assignment_members':
        if not admin:
            raise PermissionError('只有本组组管理员可以选择任务负责人')
        return [dict(username=name, name=user.get('name') or name) for name, user in eligible.items()]
    if not re.fullmatch(r'project_[a-f0-9]{32}', project['id']):
        raise ValueError('项目身份无效')
    # Task records stay outside group-readable project folders. Only the worker exposes them.
    file = safe(root, '.workbench/admin/assignments/' + project['id'] + '.json')
    tasks = read_json(file, [])
    if op == 'assignment_file_upload':
        task = next((item for item in tasks if item['id'] == request.get('taskId')), None)
        if (task and (task.get('deletedAt') or task.get('purgedAt') or task['assignee'] != username or task['status'] != 'in_progress')) or (not task and not admin):
            raise PermissionError('只有组管理员可以添加派发附件，负责人可在进行中的任务里上传验收附件')
        data = request.get('file', {})
        staged = assignment_stage(root, project['id'], username, request.get('taskId'), data.get('id'))
        name = text(data.get('name'), 240)
        if not name or re.search(r'[/\\\x00-\x1f]', name) or not incoming or not incoming.is_file():
            raise ValueError('任务附件无效')
        hashes = assignment_hashes(incoming)
        if hashes['size'] > MAX_FILE or hashes['sha256'] != data.get('sha256') or hashes['size'] != data.get('size'):
            raise ValueError('任务附件快照校验失败')
        staged.parent.mkdir(parents=True, exist_ok=True); os.chmod(staged.parent, 0o700)
        if not staged.exists():
            shutil.copyfile(incoming, staged); os.chmod(staged, 0o600)
        if assignment_hashes(staged) != hashes:
            raise ValueError('附件编号已使用')
        receipt = dict(id=data['id'], name=name, **hashes); atom(staged.with_name(staged.name + '.json'), receipt)
        return receipt
    if op == 'assignment_file_download':
        task = next((item for item in tasks if item['id'] == request.get('taskId')), None)
        if not task or task.get('purgedAt') or not admin and (task.get('deletedAt') or task['assignee'] != username):
            raise PermissionError('任务不存在或无权读取附件')
        attachment = next((item for item in assignment_all_files(task) if item['id'] == request.get('fileId')), None)
        if not attachment:
            raise ValueError('任务附件不存在')
        blob = assignment_resolve(root, project['id'], task['assignee'], task['id'], attachment)
        download_id = uuid.uuid4().hex; user = state['users'][username]
        outgoing = safe(root, '.workbench/outbox/' + user.get('systemUsername', username) + '/' + attachment['sha256'] + '-' + download_id + '.file')
        outgoing.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(blob, outgoing); os.chmod(outgoing, 0o600)
        acl_apply(['-m', 'u:' + str(user['uid']) + ':r--', str(outgoing)])
        return dict(attachment, downloadId=download_id)
    if op == 'assignment_list':
        return [task for task in tasks if not task.get('purgedAt') and (admin or not task.get('deletedAt') and task['assignee'] == username)]
    if op == 'assignment_create':
        if not admin:
            raise PermissionError('只有本组组管理员可以派发任务')
        raw = request.get('task')
        if not isinstance(raw, dict):
            raise ValueError('任务格式无效')
        identifier = text(raw.get('id'), 36)
        if not re.fullmatch(r'[a-fA-F0-9-]{36}', identifier) or str(uuid.UUID(identifier)) != identifier.lower():
            raise ValueError('任务编号无效')
        values = {key: text(raw.get(key, ''), limit).strip() for key, limit in [('title', 200), ('description', 12000), ('acceptance', 6000), ('assignee', 160)]}
        if not values['title'] or not values['description']:
            raise ValueError('请填写任务标题和任务说明')
        assignee = eligible.get(values['assignee'])
        if not assignee:
            raise ValueError('负责人已停用或不属于此项目组，请刷新成员')
        selections = raw.get('references', [])
        if not isinstance(selections, list) or len(selections) > 20 or any(not isinstance(item, dict) or not isinstance(item.get('id'), str) or type(item.get('revision')) is not int or item['revision'] < 1 for item in selections) or len({item['id'] for item in selections}) != len(selections):
            raise ValueError('关联结论列表无效')
        existing = next((task for task in tasks if task['id'] == identifier), None)
        upload_ids = raw.get('uploadIds', [])
        if not isinstance(upload_ids, list) or len(upload_ids) > 30 or any(not isinstance(value, str) for value in upload_ids) or len(set(upload_ids)) != len(upload_ids):
            raise ValueError('任务附件列表无效')
        for upload_id in upload_ids:
            assignment_stage(root, project['id'], username, identifier, upload_id)
        if existing:
            if existing.get('deletedAt') or existing.get('purgedAt'):
                raise ValueError('任务已删除，不能重新派发同一编号')
            if existing['createdBy'] != username or any(existing[key] != value for key, value in values.items()) or existing.get('referenceSelections', [dict(id=item['id'], revision=item['revision']) for item in existing['references']]) != selections or existing.get('uploadIds', []) != upload_ids:
                raise ValueError('任务编号已使用，请重新派发')
            assignment_clear_stages(root, project['id'], username, identifier, upload_ids)
            return existing
        references, files = assignment_snapshot(root, directory, project['id'], values['assignee'], identifier, username, selections, upload_ids, '派发人上传')
        stamp = now()
        task = dict(id=identifier, projectId=project['id'], **values, assigneeName=assignee.get('name') or values['assignee'], createdBy=username, createdAt=stamp, updatedAt=stamp, revision=1, status='assigned', references=references, referenceSelections=selections, files=files, uploadIds=upload_ids)
        tasks.insert(0, task); atom(file, tasks)
        assignment_clear_stages(root, project['id'], username, identifier, upload_ids)
        return task
    if op in ('assignment_status', 'assignment_lifecycle'):
        change = request.get('change', {})
        if not isinstance(change, dict):
            raise ValueError('任务操作格式无效')
        task = next((item for item in tasks if item['id'] == change.get('id')), None)
        if not task or task.get('purgedAt') or (not admin and task['assignee'] != username):
            raise PermissionError('任务不存在或无权访问')
        status = change.get('status')
        if status not in ('in_progress', 'pending_review', 'completed', 'cancelled', 'deleted', 'restored', 'purged'):
            raise ValueError('任务状态无效')
        if type(change.get('revision')) is not int or task['revision'] != change['revision']:
            raise ValueError('任务状态已更新，请刷新后重试')
        reason = text(change.get('reason', ''), 6000).strip()
        submission = change.get('submission')
        if submission is not None and not (status == 'pending_review' or status == 'completed' and task['status'] == 'in_progress'):
            raise ValueError('当前操作不能修改已提交的验收结果')
        if submission is not None:
            if not isinstance(submission, dict):
                raise ValueError('验收结果格式无效')
            summary = text(submission.get('summary', ''), 6000).strip()
            selections, upload_ids = submission.get('references', []), submission.get('uploadIds', [])
            if not summary:
                raise ValueError('请填写结果说明')
            if not isinstance(selections, list) or len(selections) > 20 or any(not isinstance(item, dict) or not isinstance(item.get('id'), str) or type(item.get('revision')) is not int or item['revision'] < 1 for item in selections) or len({item['id'] for item in selections}) != len(selections):
                raise ValueError('关联成果列表无效')
            if not isinstance(upload_ids, list) or len(upload_ids) > 30 or any(not isinstance(item, str) for item in upload_ids) or len(set(upload_ids)) != len(upload_ids):
                raise ValueError('验收附件列表无效')
            for upload_id in upload_ids:
                assignment_stage(root, project['id'], username, task['id'], upload_id)
        next_task = json.loads(json.dumps(task))
        terminal = task['status'] in ('completed', 'cancelled')
        action, stamp = status, now()
        def require_admin():
            if not admin:
                raise PermissionError('只有本组组管理员可以执行此操作')
        def require_assignee():
            if task['assignee'] != username:
                raise PermissionError('只有负责人可以提交任务结果或开始工作')
        def invalid():
            raise ValueError('当前任务状态不允许此操作')
        if status in ('deleted', 'restored', 'purged'):
            require_admin()
            if not terminal or (bool(task.get('deletedAt')) if status == 'deleted' else not task.get('deletedAt')):
                invalid()
            if status == 'deleted':
                next_task.update(deletedAt=stamp, deletedBy=username)
            elif status == 'restored':
                next_task.pop('deletedAt', None); next_task.pop('deletedBy', None)
            else:
                next_task.update(purgedAt=stamp, title='', description='', acceptance='', references=[], files=[], submissions=[], history=[])
                next_task.pop('referenceSelections', None); next_task.pop('uploadIds', None)
        else:
            if task.get('deletedAt') or terminal:
                invalid()
            if status == 'cancelled':
                require_admin()
                if not reason:
                    raise ValueError('请填写取消原因')
            elif status == 'pending_review':
                require_assignee()
                if task['status'] != 'in_progress' or submission is None:
                    invalid()
            elif status == 'completed':
                require_admin()
                if not (task['status'] == 'pending_review' or task['status'] == 'in_progress' and task['assignee'] == username and task['createdBy'] == username and submission is not None):
                    invalid()
            elif task['status'] == 'pending_review':
                require_admin()
                if not reason:
                    raise ValueError('请填写退回原因')
                action = 'rejected'
            else:
                require_assignee()
                if task['status'] == 'in_progress':
                    return task
            next_task['status'] = status
        if submission is not None:
            references, files = assignment_snapshot(root, directory, project['id'], task['assignee'], task['id'], username, selections, upload_ids, '负责人提交')
            next_task.setdefault('submissions', []).append(dict(summary=summary, references=references, files=files, submittedBy=username, submittedAt=stamp))
        next_task.update(revision=task['revision'] + 1, updatedAt=stamp)
        if status != 'purged':
            next_task.setdefault('history', []).append(dict(action=action, by=username, at=stamp, **({'note': reason} if reason else {})))
        tasks[tasks.index(task)] = next_task
        atom(file, tasks)
        if submission is not None:
            assignment_clear_stages(root, project['id'], username, task['id'], upload_ids)
        if status == 'purged':
            # Persist first; interrupted cleanup can leak storage but never deletes a live reference.
            with contextlib.suppress(OSError, ValueError):
                assignment_release(root, task, tasks)
        return next_task
    raise ValueError('不支持的任务操作')


def handle(root, state, username, request, incoming=None):
    user = member(state, username)
    op = request.get('op')
    if op in ('account_read', 'account_write', 'account_file_upload', 'account_file_download'):
        identity = hashlib.sha256(json.dumps([username, user.get('uid'), user.get('marker')]).encode()).hexdigest()
        file = safe(root, '.workbench/admin/accounts/' + identity + '.json')
        if op in ('account_file_upload', 'account_file_download'):
            sha = request.get('sha256')
            if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha):
                raise ValueError('附件身份无效')
            blob = safe(root, '.workbench/admin/account-files/' + identity + '/' + sha)
            if op == 'account_file_upload':
                if not incoming or not incoming.is_file() or incoming.stat().st_size > MAX_FILE or digest(incoming) != sha:
                    raise ValueError('账号附件校验失败')
                blob.parent.mkdir(parents=True, exist_ok=True)
                os.chmod(blob.parent.parent, 0o700); os.chmod(blob.parent, 0o700)
                if not blob.exists():
                    temp = blob.parent / ('.' + uuid.uuid4().hex)
                    try:
                        shutil.copyfile(incoming, temp); os.chmod(temp, 0o600); os.replace(temp, blob)
                    finally:
                        temp.unlink(missing_ok=True)
                if digest(blob) != sha:
                    raise ValueError('账号附件存储校验失败')
                return dict(sha256=sha, size=blob.stat().st_size)
            if not blob.is_file():
                raise ValueError('账号附件不存在')
            login = user.get('systemUsername', username)
            download_id = uuid.uuid4().hex
            outgoing = safe(root, '.workbench/outbox/' + login + '/' + sha + '-' + download_id + '.file')
            outgoing.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(blob, outgoing)
            os.chmod(outgoing, 0o600)
            acl_apply(['-m', 'u:' + str(user['uid']) + ':r--', str(outgoing)])
            return dict(sha256=sha, size=blob.stat().st_size, downloadId=download_id)
        current = read_json(file, dict(revision=0, records={}))
        if op == 'account_read':
            return current
        records = request.get('records')
        if not isinstance(records, dict) or len(json.dumps(records, ensure_ascii=False).encode('utf-8')) > 2 * 1024 * 1024 or any(not re.fullmatch(r'(material|draft|alias|update|seen|dismissed|result-rules):[^\x00-\x1f]{1,500}', key) for key in records):
            raise ValueError('账号资料格式无效或超过 2 MB')
        if type(request.get('revision')) is not int or request['revision'] != current['revision']:
            return dict(current, conflict=True)
        result = dict(revision=current['revision'] + 1, records=records)
        file.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(file.parent, 0o700)
        atom(file, result)
        return result
    if op == 'create_project':
        group_name = request.get('groupName')
        group = state['groups'].get(group_name)
        if group_name not in user.get('groups', []) or group_name not in user.get('contentAdminGroups', []) or not group or not group.get('workspace'):
            raise PermissionError('只有本组组管理员可以创建项目')
        name = text(request.get('name'), 180).strip()
        if not name or name.startswith('.') or name.endswith('.') or '/' in name or '\\' in name or len(name.encode()) > 180:
            raise ValueError('项目名不合法')
        brief = brief_value(request['brief']) if request.get('brief') is not None else None
        directory = safe(root, group['workspace'] + '/' + name)
        directory.mkdir(mode=0o700)  # Never adopt/overwrite a pre-existing project.
        project = {'version': 1, 'id': 'project_' + uuid.uuid4().hex, 'name': name, 'createdBy': username, 'createdAt': now(), 'briefRevision': 1 if brief else 0, 'brief': brief}
        try:
            for folder in ('submissions', 'trajectories', 'curated'):
                public_dir(directory / folder, group['gid'])
            if brief:
                save_brief_file(directory, project, brief, username, group['gid'])
            atom(directory / '.workbench-project.json', project, group['gid'])
            public_dir(directory, group['gid'])
        except Exception:
            # The root-reserved directory is not visible to members until complete.
            shutil.rmtree(directory)
            raise
        return {'projectId': project['id']}
    directory, project, group_name, group = locate(root, state, user, request.get('projectId'))
    admin = group_name in user.get('contentAdminGroups', [])
    gid = group['gid']
    if op == 'publish_attachment':
        sha = request.get('sha256')
        if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha) or not incoming or not incoming.is_file() or incoming.stat().st_size > MAX_FILE or digest(incoming) != sha:
            raise ValueError('附件快照校验失败')
        file = safe(directory, '.workbench-attachments/' + username + '/' + sha)
        if file.exists():
            if digest(file) != sha:
                raise ValueError('附件存储校验失败，不会覆盖')
        else:
            public_dir(file.parent.parent, gid)
            public_dir(file.parent, gid)
            temp = file.parent / ('.' + uuid.uuid4().hex + '.tmp')
            try:
                shutil.copyfile(incoming, temp)
                os.chown(temp, 0, gid)
                os.chmod(temp, 0o640)
                os.replace(temp, file)
            finally:
                temp.unlink(missing_ok=True)
        return dict(path='/' + file.relative_to(root).as_posix(), sha256=sha, size=file.stat().st_size)
    if isinstance(op, str) and op.startswith('assignment_'):
        return assignment_operation(root, state, username, request, directory, project, group_name, admin, incoming)
    if op == 'save_brief':
        if not admin:
            raise PermissionError('只有本组组管理员可以修改项目资料')
        if request.get('revision') != project.get('briefRevision', 0):
            raise ValueError('项目资料已更新，请刷新后再保存')
        brief = brief_value(request.get('brief'))
        project['briefRevision'] = project.get('briefRevision', 0) + 1
        project['brief'] = brief
        project['briefUpdatedAt'] = now()
        save_brief_file(directory, project, brief, username, gid)
        atom(directory / '.workbench-project.json', project, gid)
        return project
    index = directory / '.workbench-content.json'
    items = read_json(index, [])
    if op == 'adopt_content':
        if not admin:
            raise PermissionError('只有组管理员可以纳入已有文件')
        target = request.get('target')
        file = safe(root, target)
        relative = file.relative_to(directory).as_posix()
        if any(p.startswith('.') for p in relative.split('/')) or relative == '项目说明.md' or not file.is_file():
            raise ValueError('请选择普通公共文件，管理文件请使用对应入口维护')
        existing = next((i for i in items if i['path'] == target), None)
        if existing:
            return existing
        size = file.stat().st_size
        parts = relative.split('/')
        item = dict(id=str(uuid.uuid4()), title=file.name, description=file.read_text(encoding='utf-8', errors='replace') if file.suffix.lower() in ('.md', '.txt') and size <= 512 * 1024 else '从已有公共文件纳入，由组管理员统一维护。', kind='file', path=target, author=parts[1] if len(parts) > 2 and parts[0] in ('submissions', 'trajectories') else '历史文件', state='curated', revision=1, createdAt=now(), updatedAt=now(), updatedBy=username, size=size, sha256=digest(file))
        items.insert(0, item); atom(index, items, gid)
        return item
    if op == 'publish':
        target = text(request.get('target'), 4096)
        meta = request.get('metadata') or {}
        attachments = meta.get('attachments', [])
        if not isinstance(attachments, list) or len(attachments) > 30 or (attachments and meta.get('kind') != 'contribution'):
            raise ValueError('附件列表无效')
        for attachment in attachments:
            if not isinstance(attachment, dict):
                raise ValueError('附件格式无效')
            name = text(attachment.get('name'), 240)
            sha = attachment.get('sha256')
            if not name or re.search(r'[/\\\x00-\x1f]', name) or not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha):
                raise ValueError('附件格式无效')
            file = safe(directory, '.workbench-attachments/' + username + '/' + sha)
            if attachment.get('path') != '/' + file.relative_to(root).as_posix():
                raise PermissionError('附件不属于当前提交账号')
            if not file.is_file() or type(attachment.get('size')) is not int or file.stat().st_size != attachment['size'] or digest(file) != sha:
                raise ValueError('附件尚未上传成功或校验失败')
        prefix = '/' + str(directory.relative_to(root)).replace('\\', '/') + '/'
        if not target.startswith(prefix):
            raise PermissionError('上传目标不属于项目')
        relative = target[len(prefix):]
        if any(p.startswith('.') for p in relative.split('/')):
            raise PermissionError('不可写入管理记录')
        if not admin and not any(relative.startswith(folder + '/' + username + '/') for folder in ('submissions', 'trajectories')):
            raise PermissionError('只能写入自己的公共提交目录')
        category = meta.get('category')
        if meta.get('kind') == 'contribution' and category:
            if category not in CONTRIBUTION_FOLDERS:
                raise ValueError('不支持的成果类别')
            expected = 'submissions/' + username + '/' + CONTRIBUTION_FOLDERS[category] + '/'
            if not relative.startswith(expected) or '/' in relative[len(expected):]:
                raise PermissionError('成果类别与上传目录不一致')
            fields = meta.get('fields') or {}
            if not isinstance(fields, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in fields.items()):
                raise ValueError('成果字段格式无效')
            if any(key not in CONTRIBUTION_FIELDS[category] for key in fields):
                raise ValueError('成果字段与类别不一致')
        if not incoming or digest(incoming) != request.get('sha256'):
            raise ValueError('上传内容校验失败')
        receipt_file = safe(root, '.workbench/admin/uploads.json')
        receipts = read_json(receipt_file, {})
        key = hashlib.sha256(json.dumps([project['id'], username, target, request['sha256']]).encode()).hexdigest()
        if key in receipts:
            return receipts[key]
        previous = next((item for item in items if item['path'] == target), None)
        if previous:
            if previous['author'] == username and previous['sha256'] == request['sha256']:
                return previous
            raise ValueError('目标已存在，请从公共成果中修订并核对版本')
        file = safe(root, target)
        if file.exists() and digest(file) != request['sha256']:
            raise ValueError('目标已有其他内容，不会覆盖')
        public_dir(file.parent, gid)
        temp = file.parent / ('.' + uuid.uuid4().hex + '.tmp')
        try:
            shutil.copyfile(incoming, temp)
            os.chown(temp, 0, gid)
            os.chmod(temp, 0o640)
            os.replace(temp, file)
        finally:
            temp.unlink(missing_ok=True)
        item = {'id': str(uuid.uuid4()), 'title': text(meta.get('title') or file.name, 200), 'description': text(meta.get('description', '')), 'kind': meta.get('kind', 'file'), 'category': category, 'fields': meta.get('fields'), 'repoUrl': text(meta.get('repoUrl', ''), 2048), 'git': meta.get('git'), 'sourceSessionId': meta.get('sourceSessionId'), 'sourceSessionTitle': text(meta.get('sourceSessionTitle'), 120) if meta.get('sourceSessionTitle') else None, 'snapshotHash': meta.get('snapshotHash'), 'path': target, 'author': username, 'revision': 1, 'state': 'submitted', 'createdAt': now(), 'updatedAt': now(), 'updatedBy': username, 'sha256': request['sha256'], 'size': file.stat().st_size}
        if attachments:
            item['attachments'] = [{k: a[k] for k in ('name', 'path', 'sha256', 'size')} for a in attachments]
        if meta.get('sourceDetails'):
            item['sourceDetails'] = text(meta['sourceDetails'], 8000)
        items.insert(0, item)
        atom(index, items, gid)
        receipts[key] = item
        atom(receipt_file, receipts)
        return item
    if op != 'edit_content':
        raise ValueError('不支持的内容操作')
    change = request.get('change', {})
    item = next((i for i in items if i['id'] == change.get('id')), None)
    if not item or item['revision'] != change.get('revision'):
        raise ValueError('内容已更新或删除，请刷新后再操作')
    if not admin and (item['author'] != username or item['state'] == 'curated'):
        raise PermissionError('只能修改自己尚未被整理的提交；可另提补充')
    if not admin and (change.get('curate') or change.get('merge')):
        raise PermissionError('只有组管理员可以整理或合并')
    merged = []
    sources = change.get('merge', [])
    if not isinstance(sources, list) or len(sources) > 100 or len({s.get('id') for s in sources}) != len(sources):
        raise ValueError('合并列表无效')
    for source in sources:
        other = next((i for i in items if i['id'] == source.get('id')), None)
        if not other or other is item or other['revision'] != source.get('revision') or other['kind'] != 'contribution':
            raise ValueError('待合并内容已改变，请刷新')
        merged.append(other)
    provenance = list(item.get('provenance', [])) + [dict(id=item['id'], revision=item['revision'], title=item['title'], author=item['author'], updatedAt=item['updatedAt'])]
    for source in merged:
        provenance += list(source.get('provenance', [])) + [dict(id=source['id'], revision=source['revision'], title=source['title'], author=source['author'], updatedAt=source['updatedAt'])]
    provenance = list({(source['id'], source['revision']): source for source in provenance}.values())
    paths = [i['path'] for i in [item] + merged]
    attachments = list({a['sha256']: a for source in [item] + merged for a in source.get('attachments', [])}.values())
    if len(attachments) > 30:
        raise ValueError('合并后的附件超过 30 个，请分批整理')
    if change.get('action') == 'save' and item['kind'] != 'contribution':
        if merged:
            raise ValueError('文件不能按文字成果合并')
        replacement = request.get('replacement')
        if replacement:
            extension = replacement.get('extension', '')
            if extension and not re.fullmatch(r'\.[a-zA-Z0-9]{1,20}', extension):
                raise ValueError('文件扩展名不合法')
            if not incoming or digest(incoming) != replacement.get('sha256'):
                raise ValueError('替换文件校验失败')
            folder = 'curated' if admin else 'submissions/' + username
            file = safe(directory, folder + '/' + item['id'] + '-v' + str(item['revision'] + 1) + extension)
            public_dir(file.parent, gid)
            shutil.copyfile(incoming, file)
            os.chown(file, 0, gid)
            os.chmod(file, 0o640)
            item.update(path='/' + str(file.relative_to(root)).replace('\\', '/'), sha256=digest(file), size=file.stat().st_size)
        item.update(title=text(change.get('title'), 200), description=text(change.get('description')), revision=item['revision'] + 1, state='curated' if admin else item['state'], updatedAt=now(), updatedBy=username)
    elif change.get('action') == 'save':
        title = text(change.get('title'), 200).strip()
        description = text(change.get('description'))
        category = change.get('category')
        if category is not None and category not in CONTRIBUTION_FOLDERS:
            raise ValueError('成果类别无效')
        source_details = text(change.get('sourceDetails'), 8000) if 'sourceDetails' in change else None
        if not title:
            raise ValueError('请填写标题')
        folder = 'curated' if admin else 'submissions/' + username
        relative = folder + '/' + item['id'] + '-v' + str(item['revision'] + 1) + '.md'
        file = safe(directory, relative)
        repo = text(change.get('repoUrl', ''), 2048)
        publish_bytes(file, ('# ' + title + '\n\n' + (repo + '\n\n' if repo else '') + description).encode(), gid)
        if category is not None:
            item.update(category=category, fields={})
        if source_details is not None:
            item['sourceDetails'] = source_details
        item.update(title=title, description=description, repoUrl=repo, **({'sourceSessionTitle': text(change.get('sourceSessionTitle'), 120)} if change.get('sourceSessionTitle') else {}), path='/' + str(file.relative_to(root)).replace('\\', '/'), revision=item['revision'] + 1, state='curated' if admin else 'submitted', updatedAt=now(), updatedBy=username, sha256=digest(file), size=file.stat().st_size, sources=list(dict.fromkeys(item.get('sources', []) + [i['id'] for i in merged])), **({'provenance': provenance} if merged else {}))
    elif change.get('action') != 'delete':
        raise ValueError('不支持的修改操作')
    items = [i for i in items if i not in merged and (change['action'] != 'delete' or i is not item)]
    if change['action'] == 'save' and attachments:
        item['attachments'] = attachments
    atom(index, items, gid)
    for old in paths:
        if change['action'] == 'delete' or old != item['path']:
            safe(root, old).unlink(missing_ok=True)
    return item if change['action'] == 'save' else None

def save_brief_file(directory, project, brief, username, gid):
    body = '# ' + project['name'] + ' · 项目说明\n\n' + '由 ' + username + ' 更新于 ' + now() + '。\n\n'
    body += '\n'.join('## ' + label + '\n\n' + (brief[key] or '待补充。') + '\n' for key, label in BRIEF_FIELDS)
    # Immutable numbered snapshot is authoritative; compatibility Markdown is refreshed.
    history = directory / '.brief-versions'
    public_dir(history, gid)
    publish_bytes(history / (str(project['briefRevision']) + '.md'), body.encode(), gid)
    publish_bytes(directory / '项目说明.md', body.encode(), gid)

def owned_read(file, uid, maximum):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or info.st_size > maximum:
            raise PermissionError('请求或上传文件身份不符')
        data = handle.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError('请求过大')
        return data

def tick(root):
    import pwd
    import fcntl
    state_file = safe(root, '.workbench/admin/state.json')
    state = read_json(state_file)
    for username, user in state['users'].items():
        login = user.get('systemUsername', username)
        inbox = safe(root, '.workbench/inbox/' + login)
        outbox = safe(root, '.workbench/outbox/' + login)
        if not inbox.is_dir() or not outbox.is_dir():
            continue
        for request_file in list(inbox.glob('*.request.json'))[:25]:
            identifier = request_file.name[:-13]
            if not re.fullmatch(r'[a-f0-9-]{36}', identifier):
                continue
            # Serialize with administrator changes; permissions are read again under the lock.
            lockdir = pathlib.Path('/run/team-agent-admin')
            lockdir.mkdir(mode=0o700, exist_ok=True)
            info = lockdir.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
                raise PermissionError('文件操作锁目录必须由 root 独占')
            with (lockdir / hashlib.sha256(str(root).encode()).hexdigest()).open('a') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                receipt = outbox / (identifier + '.json')
                staging = None
                try:
                    state = read_json(state_file)
                    user = member(state, username)
                    account = pwd.getpwnam(login)
                    if account.pw_uid != user['uid'] or account.pw_gecos != user['marker']:
                        raise PermissionError('系统账号身份已改变')
                    gids = set(os.getgrouplist(login, account.pw_gid))
                    user['groups'] = [g for g in user.get('groups', []) if state['groups'].get(g, {}).get('gid') in gids]
                    user['contentAdminGroups'] = [g for g in user.get('contentAdminGroups', []) if g in user['groups'] and state['groups'][g].get('adminGid') in gids]
                    raw = owned_read(request_file, user['uid'], 3 * 1024 * 1024)
                    request_hash = hashlib.sha256(raw).hexdigest()
                    if receipt.exists():
                        old = read_json(receipt)
                        if old.get('requestHash') != request_hash:
                            raise ValueError('请求 ID 已使用，不允许更换请求内容')
                        continue
                    request = json.loads(raw)
                    if request.get('op') in ('publish', 'publish_attachment', 'account_file_upload', 'assignment_file_upload') or request.get('replacement'):
                        filename = request.get('staging')
                        if not isinstance(filename, str) or not re.fullmatch(r'[a-f0-9-]{36}\.upload', filename):
                            raise ValueError('上传暂存路径无效')
                        source = safe(inbox, filename)
                        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        staging = safe(root, '.workbench/admin/' + str(uuid.uuid4()) + '.upload')
                        with os.fdopen(fd, 'rb') as stream, staging.open('xb') as output:
                            info = os.fstat(stream.fileno())
                            if not stat.S_ISREG(info.st_mode) or info.st_uid != user['uid'] or info.st_nlink != 1 or info.st_size > MAX_FILE:
                                raise PermissionError('上传文件身份不符或超过 2 GB')
                            count = 0
                            while chunk := stream.read(1024 * 1024):
                                count += len(chunk)
                                if count > MAX_FILE:
                                    raise ValueError('上传过大')
                                output.write(chunk)
                    value = handle(root, state, username, request, staging)
                    atom(receipt, {'ok': True, 'value': value, 'requestHash': request_hash})
                except Exception as error:
                    if not receipt.exists():
                        atom(receipt, {'ok': False, 'error': str(error)})
                finally:
                    if receipt.exists():
                        os.chown(receipt, 0, 0)
                        os.chmod(receipt, 0o600)
                        acl_apply(['-m', 'u:' + str(user.get('uid', 0)) + ':r--', str(receipt)])
                    request_file.unlink(missing_ok=True)
                    if staging:
                        staging.unlink(missing_ok=True)

if __name__ == '__main__':
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise PermissionError('文件操作器必须由 Linux root 运行')
    root = pathlib.Path(sys.argv[1]).resolve(strict=True)
    while True:
        try:
            tick(root)
        except Exception as error:
            print(str(error), file=sys.stderr, flush=True)
        time.sleep(0.5)
