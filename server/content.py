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

CONTRIBUTION_FOLDERS = {
    'experiment_result': 'experiments',
    'failed_direction': 'failed-directions',
    'finding': 'findings',
    'issue': 'issues',
    'baseline_change_proposal': 'baseline-change-proposals',
}
CONTRIBUTION_FIELDS = {
    'experiment_result': {'objective', 'change', 'environment', 'baseline', 'result', 'evidence', 'scope', 'limitations', 'nextSteps'},
    'failed_direction': {'objective', 'approach', 'failure', 'evidence', 'likelyCause', 'avoidWhen', 'reusableInsight'},
    'finding': {'statement', 'evidence', 'scope', 'uncertainty', 'nextSteps'},
    'issue': {'problem', 'trigger', 'impact', 'evidence', 'reproduction', 'workaround', 'nextAction'},
    'baseline_change_proposal': {'baselineItem', 'currentValue', 'proposedValue', 'rationale', 'evidence', 'impact', 'validationNeeded'},
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
        subprocess.run(['setfacl', '-b', '-k', str(target)], check=True, capture_output=True)
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

def handle(root, state, username, request, incoming=None):
    user = member(state, username)
    op = request.get('op')
    if op == 'create_project':
        group_name = request.get('groupName')
        group = state['groups'].get(group_name)
        if group_name not in user.get('groups', []) or group_name not in user.get('contentAdminGroups', []) or not group or not group.get('workspace'):
            raise PermissionError('只有本组子管理员可以创建项目')
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
    if op == 'save_brief':
        if not admin:
            raise PermissionError('只有本组子管理员可以修改项目资料')
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
            raise PermissionError('只有子管理员可以纳入已有文件')
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
        item = dict(id=str(uuid.uuid4()), title=file.name, description=file.read_text(encoding='utf-8', errors='replace') if file.suffix.lower() in ('.md', '.txt') and size <= 512 * 1024 else '从已有公共文件纳入，由子管理员统一维护。', kind='file', path=target, author=parts[1] if len(parts) > 2 and parts[0] in ('submissions', 'trajectories') else '历史文件', state='curated', revision=1, createdAt=now(), updatedAt=now(), updatedBy=username, size=size, sha256=digest(file))
        items.insert(0, item); atom(index, items, gid)
        return item
    if op == 'publish':
        target = text(request.get('target'), 4096)
        meta = request.get('metadata') or {}
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
        item = {'id': str(uuid.uuid4()), 'title': text(meta.get('title') or file.name, 200), 'description': text(meta.get('description', '')), 'kind': meta.get('kind', 'file'), 'repoUrl': text(meta.get('repoUrl', ''), 2048), 'git': meta.get('git'), 'sourceSessionId': meta.get('sourceSessionId'), 'path': target, 'author': username, 'revision': 1, 'state': 'submitted', 'createdAt': now(), 'updatedAt': now(), 'updatedBy': username, 'sha256': request['sha256'], 'size': file.stat().st_size}
        item = {'id': str(uuid.uuid4()), 'title': text(meta.get('title') or file.name, 200), 'description': text(meta.get('description', '')), 'kind': meta.get('kind', 'file'), 'category': category, 'fields': meta.get('fields'), 'repoUrl': text(meta.get('repoUrl', ''), 2048), 'git': meta.get('git'), 'sourceSessionId': meta.get('sourceSessionId'), 'snapshotHash': meta.get('snapshotHash'), 'path': target, 'author': username, 'revision': 1, 'state': 'submitted', 'createdAt': now(), 'updatedAt': now(), 'updatedBy': username, 'sha256': request['sha256'], 'size': file.stat().st_size}
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
        raise PermissionError('只有子管理员可以整理或合并')
    merged = []
    sources = change.get('merge', [])
    if not isinstance(sources, list) or len(sources) > 100 or len({s.get('id') for s in sources}) != len(sources):
        raise ValueError('合并列表无效')
    for source in sources:
        other = next((i for i in items if i['id'] == source.get('id')), None)
        if not other or other is item or other['revision'] != source.get('revision') or other['kind'] != 'contribution':
            raise ValueError('待合并内容已改变，请刷新')
        merged.append(other)
    paths = [i['path'] for i in [item] + merged]
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
        if not title:
            raise ValueError('请填写标题')
        folder = 'curated' if admin else 'submissions/' + username
        relative = folder + '/' + item['id'] + '-v' + str(item['revision'] + 1) + '.md'
        file = safe(directory, relative)
        repo = text(change.get('repoUrl', ''), 2048)
        publish_bytes(file, ('# ' + title + '\n\n' + (repo + '\n\n' if repo else '') + description).encode(), gid)
        item.update(title=title, description=description, repoUrl=repo, path='/' + str(file.relative_to(root)).replace('\\', '/'), revision=item['revision'] + 1, state='curated' if admin else 'submitted', updatedAt=now(), updatedBy=username, sha256=digest(file), size=file.stat().st_size, sources=list(dict.fromkeys(item.get('sources', []) + [i['id'] for i in merged])))
    elif change.get('action') != 'delete':
        raise ValueError('不支持的修改操作')
    items = [i for i in items if i not in merged and (change['action'] != 'delete' or i is not item)]
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
                    if request.get('op') == 'publish' or request.get('replacement'):
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
                        subprocess.run(['setfacl', '-m', 'u:' + str(user.get('uid', 0)) + ':r--', str(receipt)], check=True, capture_output=True)
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
