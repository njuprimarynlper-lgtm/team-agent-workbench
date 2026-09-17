"""Run on demand over SSH, as an already authorized Linux administrator.

No daemon, application passwords or model credentials are installed on the server.
The Windows admin app sends this fixed program and a JSON request on stdin.
"""
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
import uuid
import contextlib
import unicodedata

OPS = {"probe", "initialize", "status", "user_create", "user_password", "user_enabled", "group_create", "user_groups", "group_member", "configure_sftp", "workspace_prepare", "recover"}

def validate_request(request):
    if not isinstance(request, dict) or request.get("op") not in OPS:
        raise ValueError("不支持的管理操作")
    value = request.get("root", "")
    if not isinstance(value, str) or not value.startswith("/") or any(c in value for c in "\x00\n\r\\\""):
        raise ValueError("共享根路径必须是 Linux 绝对路径")
    parts = pathlib.PurePosixPath(value).parts
    if ".." in parts or len(parts) < 3:
        raise ValueError("请选择专用的共享子目录，例如 /srv/teamspace")
    if str(pathlib.PurePosixPath(value)) != value or any(c in value for c in "\t*"):
        raise ValueError("根路径格式不规范")
    return request

def identifier(value, maximum=24):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0," + str(maximum-1) + r"}", value):
        raise ValueError("标识只能由小写字母、数字、下划线和短横线组成，并以字母开头")
    return value

def account_name(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 64
            or unicodedata.category(value[0])[0] not in 'LN'
            or any(unicodedata.category(c)[0] not in 'LN' and c not in '_·-' for c in value)):
        raise ValueError('账号支持中文姓名、数字工号、大小写字母、下划线、短横线和间隔号，最多 64 个字符')
    if re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])', value, re.IGNORECASE):
        raise ValueError('此账号是系统保留名称，请换一个姓名或工号')
    return value

def system_username(username):
    # Keep legacy Linux identities; the Windows SSH client uses this same mapping.
    return username if re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', username) else 'wbu_' + hashlib.sha256(username.encode('utf-8')).hexdigest()[:28]

def user_login(state, username):
    record = state['users'][username]
    return identifier(record.get('systemUsername', username), 32)

def check_password(password):
    if not isinstance(password, str) or not 1 <= len(password) <= 4096 or any(c in password for c in '\r\n\x00:'):
        raise ValueError('密码不能为空，不能含换行、冒号或空字符；恢复时请重新输入')
    return password

def run(args, data=None, allowed=(0,)):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=30)
    if result.returncode not in allowed:
        # The command payload can contain an initial password on stdin; never log stdin.
        raise RuntimeError(args[0] + " 执行失败：" + result.stderr.strip()[:1500])
    return result.stdout.strip()

def atomic_json(file, value):
    temp = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("x", encoding="utf-8") as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
    os.replace(temp, file)

def child(root, relative):
    if not isinstance(relative, str) or relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts or any(c in relative for c in "\x00\n\r\\"):
        raise ValueError("路径必须位于共享根目录内")
    target = root.joinpath(relative)
    if not target.is_relative_to(root):
        raise ValueError("路径越界")
    cursor = root
    for part in pathlib.PurePosixPath(relative).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("管理操作不允许穿过符号链接")
    return target

def root_directory(request):
    root = pathlib.Path(request["root"])
    if str(root.resolve()) != str(root):
        raise ValueError("共享根路径及其上级不得包含符号链接或不规范路径")
    return root

def allocate_id(records, field, reserved=()):
    used = {getattr(r, field) for r in records} | set(reserved)
    for value in range(1000, 60000):
        if value not in used:
            return value
    raise ValueError("没有可用的专用 UID/GID")

def checkpoint(root, state, step):
    job = state.get("operations", {}).get(state.get("activeOperation"))
    if job and step not in job["completed"]:
        job["completed"].append(step)
    save(root, state)

def provision_group(root, state, record, field, name, step):
    import grp
    if field not in record:
        try:
            grp.getgrnam(name)
        except KeyError:
            pass
        else:
            raise ValueError("同名 Linux 用户组已存在，不能接管：" + name)
        reserved = [state.get("loginGid")] + [g.get(k) for g in state["groups"].values() for k in ["gid", "adminGid"]]
        record[field] = allocate_id(grp.getgrall(), "gr_gid", reserved)
        save(root, state)  # Reserve identity before the mutating command.
    try:
        existing = grp.getgrnam(name)
    except KeyError:
        run(["groupadd", "-g", str(record[field]), name])
        existing = grp.getgrnam(name)
    if existing.gr_gid != record[field]:
        raise ValueError("用户组 GID 已变化，拒绝恢复：" + name)
    checkpoint(root, state, step)

BOOTSTRAP_DIR = pathlib.Path("/var/lib/team-agent-workbench/bootstrap")

def bootstrap_file(root):
    BOOTSTRAP_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    for directory in [BOOTSTRAP_DIR, BOOTSTRAP_DIR.parent]:
        info = directory.stat()
        if directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("初始化恢复记录目录权限不安全")
    return BOOTSTRAP_DIR / (hashlib.sha256(str(root).encode()).hexdigest() + ".json")

def initialize(root, request):
    journal = bootstrap_file(root)
    if journal.exists():
        state = json.loads(journal.read_text(encoding="utf-8"))
        if state.get("root") != str(root):
            raise ValueError("初始化恢复记录与路径不一致")
    else:
        if root.exists() and any(root.iterdir()):
            raise ValueError("初始化只接受不存在或空的专用目录；不会接管已有非空目录")
        team_id = uuid.uuid4().hex[:8]
        state = {"version": 1, "root": str(root), "teamId": team_id, "name": "团队空间", "loginGroup": "wb_" + team_id + "_members", "users": {}, "initialized": False, "groups": {}, "sftpConfigured": False}
        atomic_json(journal, state)
    root.mkdir(parents=True, exist_ok=True)
    for parent in [root] + list(root.parents)[:-1]:
        info = parent.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("SFTP 根路径及上级必须由 root 拥有且不可被组或其他用户写入")
    os.chmod(root, 0o755)
    for relative in ["projects", ".workbench", ".workbench/users", ".workbench/admin"]:
        directory = child(root, relative)
        directory.mkdir(exist_ok=True)
        os.chmod(directory, 0o700 if relative.endswith("/admin") else 0o711)
    # Once the ordinary registry exists it is the authoritative recovery record.
    if child(root, ".workbench/admin/state.json").exists():
        state = load(root)
        if state.get("initialized"):
            return state
    state.setdefault("operations", {})["initialize"] = {"id": "initialize", "op": "initialize", "request": {"op": "initialize"}, "status": "running", "completed": ["专用目录已建立"]}
    state["activeOperation"] = "initialize"
    save(root, state)
    provision_group(root, state, state, "loginGid", state["loginGroup"], "成员登录组已建立")
    state["initialized"] = True
    state["operations"]["initialize"]["status"] = "done"
    checkpoint(root, state, "团队登记已完成")
    journal.unlink(missing_ok=True)
    return state

def operation_key(request):
    if request['op'] == 'group_member':
        return 'group_member:' + str(request.get('username')) + ':' + str(request.get('group'))
    return request["op"] + (":" + str(request.get("username") or request.get("label") or request.get("group")) if any(request.get(k) for k in ["username", "label", "group"]) else "")

def start_operation(root, state, request):
    key = operation_key(request)
    previous = state.setdefault("operations", {}).get(key)
    if previous and previous.get("status") == "done" and request["op"] in ["user_create", "group_create"]:
        raise ValueError("创建已经完成，请刷新查看已有资源")
    sanitized = {k: request[k] for k in ["op", "username", "name", "groups", "contentAdminGroups", "label", "group", "enabled", "role"] if k in request}
    state["operations"][key] = {"id": key, "op": request["op"], "request": sanitized, "status": "running", "completed": previous.get("completed", []) if previous and previous.get("status") != "done" else []}
    state["activeOperation"] = key
    save(root, state)

def assign_groups(root, state, request):
    username = request.get("username")
    ensure_user(state, username)
    login = user_login(state, username)
    groups = request.get("groups", [])
    if not isinstance(groups, list) or any(g not in state["groups"] or not state["groups"][g].get("workspace") for g in groups):
        raise ValueError("仅可分配已准备好工作目录的团队用户组")
    content_admin_groups = request.get("contentAdminGroups", [])
    if not isinstance(content_admin_groups, list) or any(g not in groups for g in content_admin_groups):
        raise ValueError("子管理员必须是对应项目组成员")
    desired = set(groups) | {state["groups"][g]["adminGroup"] for g in content_admin_groups}
    managed = set(state["groups"]) | {g["adminGroup"] for g in state["groups"].values()}
    import grp
    current = {g.gr_name for g in grp.getgrall() if login in g.gr_mem}
    for group in managed & current - desired:
        run(["gpasswd", "-d", login, group])
    if desired:
        run(["usermod", "-a", "-G", ",".join(sorted(desired)), login])
    state["users"][username]["groups"] = list(groups)
    state["users"][username]["contentAdminGroups"] = content_admin_groups
    checkpoint(root, state, "成员组与子管理员角色已设置")
    terminate_connections(login)
    checkpoint(root, state, "旧连接已失效")


def load(root):
    file = child(root, ".workbench/admin/state.json")
    if not file.is_file():
        raise ValueError("此目录尚未初始化为团队空间")
    return json.loads(file.read_text(encoding="utf-8"))

def write_roles(root, state):
    roles = {"version": 1, "membershipVersion": 1, "root": str(root), "users": {}}
    for username, user in state["users"].items():
        if user["enabled"] and not user.get("missing") and not user.get("provisioning"):
            groups = [{"id": name, "name": state["groups"][name]["label"], "workspace": state["groups"][name].get("workspace") if not state["groups"][name].get("provisioning") else None} for name in user.get("groups", []) if name in state["groups"]]
            assigned = [group for group in groups if group["id"] in user.get("contentAdminGroups", [])]
            roles["users"][username] = {"groups": groups, "contentGroups": assigned}
    role_file = child(root, ".workbench/roles.json")
    atomic_json(role_file, roles)
    os.chmod(role_file, 0o644)


def save(root, state):
    atomic_json(child(root, ".workbench/admin/state.json"), state)
    # Legacy state files did not persist ordinary memberships. Always publish
    # the current OS assignments, including during unrelated password/group edits.
    write_roles(root, actual_state(state))


def prepare_workspace(root, state, group_name):
    import grp
    group = state["groups"].get(group_name)
    if not group:
        raise ValueError("用户组不属于此团队")
    if not shutil.which("setfacl"):
        raise ValueError("服务器缺少 setfacl，请先安装发行版的 acl 软件包")
    target = child(root, "projects/" + identifier(group["label"], 14))
    if target.exists() and not group.get("workspace") and any(target.iterdir()):
        raise ValueError("工作目录已存在且非空，不会接管，请运维检查：" + str(target))
    if target.exists() and target.stat().st_uid != 0:
        raise ValueError("工作目录必须由 root 拥有")
    target.mkdir(mode=0o700, exist_ok=True)
    os.chown(target, 0, grp.getgrnam(group_name).gr_gid)
    os.chmod(target, 0o2770)
    # Members can enter/list this parent; only the content-admin group can create projects.
    run(["setfacl", "-b", "-k", str(target)])
    run(["setfacl", "-m", "u::rwx,g::r-x,g:" + group["adminGroup"] + ":rwx,m::rwx,o::---", str(target)])
    # New project content is collaborative, submissions are group-readable and trajectories remain private.
    run(["setfacl", "-d", "-m", "u::rwx,g::rwx,g:" + group["adminGroup"] + ":rwx,m::rwx,o::---", str(target)])
    group["workspace"] = "/projects/" + group["label"]

def ensure_user(state, username):
    account_name(username)
    if username not in state["users"]:
        raise ValueError("只允许操作由此团队空间创建的成员账号")
    import pwd
    current = pwd.getpwnam(user_login(state, username))
    if current.pw_uid == 0 or current.pw_uid != state["users"][username]["uid"]:
        raise ValueError("Linux 账号身份已被外部修改，拒绝操作")

def terminate_connections(username):
    # All accounts created by this application are dedicated SFTP accounts.
    run(["pkill", "-KILL", "-u", username], allowed=(0, 1))

def actual_state(state):
    import grp, pwd, copy
    result = copy.deepcopy(state)
    today = (datetime.datetime.now(datetime.timezone.utc).date() - datetime.date(1970, 1, 1)).days
    shadows = {line.split(":")[0]: line.split(":") for line in pathlib.Path("/etc/shadow").read_text().splitlines()}
    for name, user in result["users"].items():
        try:
            login = user_login(state, name)
            record = pwd.getpwnam(login)
            shadow = shadows[login]
            expires = int(shadow[7]) if shadow[7] else -1
            user["missing"] = record.pw_uid != user["uid"]
            user["enabled"] = not user["missing"] and not shadow[1].startswith(("!", "*")) and (expires < 0 or expires > today)
            user["groups"] = [g.gr_name for g in grp.getgrall() if login in g.gr_mem or g.gr_gid == record.pw_gid]
        except KeyError:
            user["missing"] = True
            user["enabled"] = False
            user["groups"] = []
    return result

@contextlib.contextmanager
def state_lock(request):
    import fcntl
    # Shared by all administrators; this file cannot be replaced by ordinary users.
    directory = pathlib.Path("/run/team-agent-admin")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != 0 or directory.stat().st_mode & 0o077:
        raise PermissionError("管理锁目录权限不安全")
    key = hashlib.sha256(request["root"].encode()).hexdigest()
    with (directory / key).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield

def _execute(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有的 Linux root 或 sudo 管理权限；安装管理员版不赋予服务器权限")
    root = root_directory(request)
    actor = os.environ.get("SUDO_USER") or "root"
    required = ["useradd", "usermod", "groupadd", "gpasswd", "chpasswd", "pkill", "sshd"]
    missing = [name for name in required if not shutil.which(name)]
    if request["op"] == "probe":
        return {"administrator": True, "actor": actor, "root": str(root), "missingCommands": missing, "initialized": (root / ".workbench/admin/state.json").is_file()}
    if request["op"] == "status" and not (root / ".workbench/admin/state.json").is_file():
        journal = bootstrap_file(root)
        return {"initialized": False, "users": {}, "groups": {}, "bootstrapPending": journal.exists()}
    if missing:
        raise ValueError("服务器缺少命令：" + ", ".join(missing) + "。请先安装发行版的 OpenSSH、shadow/passwd、procps 软件包。")
    op = request["op"]
    if op == "initialize":
        state = initialize(root, request)
    else:
        state = load(root)
        if op != "status":
            if not state.get("initialized"):
                raise ValueError("请先恢复并完成初始化")
            start_operation(root, state, request)
    result = None
    if op == "status":
        current = actual_state(state)
        write_roles(root, current)
        return current
    if op == "user_create":
        import pwd, grp
        username = account_name(request.get("username"))
        login = system_username(username)
        password = check_password(request.get("password", ""))
        groups = request.get("groups", [])
        if any(g not in state["groups"] or not state["groups"][g].get("workspace") for g in groups) or any(g not in groups for g in request.get("contentAdminGroups", [])):
            raise ValueError("请选择已准备好的用户组，子管理员须属于对应组")
        record = state["users"].get(username)
        if not record:
            if any(n.lower() == username.lower() or user_login(state, n) == login for n in state['users']):
                raise ValueError('账号已存在（不允许创建仅大小写不同的重名账号）')
            try:
                pwd.getpwnam(login)
            except KeyError:
                pass
            else:
                raise ValueError("Linux 账号已存在，工具不会接管已有系统账号")
            record = {"username": username, "systemUsername": login, "uid": allocate_id(pwd.getpwall(), "pw_uid", [u.get("uid") for u in state["users"].values()]), "name": str(request.get("name", username))[:120], "enabled": True, "provisioning": True, "marker": "workbench-" + state["teamId"] + "-" + login}
            state["users"][username] = record
            save(root, state)
        elif not record.get("provisioning"):
            raise ValueError("账号已创建完成，请使用重置密码或组管理入口")
        login = user_login(state, username)
        shell = shutil.which("nologin") or "/usr/sbin/nologin"
        try:
            current = pwd.getpwnam(login)
        except KeyError:
            run(["useradd", "-M", "-u", str(record["uid"]), "-c", record["marker"], "-d", "/", "-s", shell, "-g", state["loginGroup"], login])
            current = pwd.getpwnam(login)
        if current.pw_uid != record["uid"] or current.pw_gecos != record["marker"] or current.pw_gid != grp.getgrnam(state["loginGroup"]).gr_gid:
            raise ValueError("账号身份与创建记录不符，拒绝恢复")
        checkpoint(root, state, "专用账号已创建")
        run(["chpasswd"], login + ":" + password + "\n")
        checkpoint(root, state, "初始密码已设置")
        assign_groups(root, state, request)
        record["provisioning"] = False
    elif op == "user_password":
        username = request.get("username")
        ensure_user(state, username)
        login = user_login(state, username)
        password = check_password(request.get("password", ""))
        run(["chpasswd"], login + ":" + password + "\n")
        terminate_connections(login)
    elif op == "user_enabled":
        username = request.get("username")
        ensure_user(state, username)
        login = user_login(state, username)
        enabled = request.get("enabled") is True
        run(["usermod", "--expiredate", "" if enabled else "1", login])
        state["users"][username]["enabled"] = enabled
        if not enabled:
            terminate_connections(login)
    elif op == "group_create":
        label = identifier(request.get("label"), 14)
        name = "wb_" + state["teamId"] + "_" + label
        import grp
        if not shutil.which("setfacl"):
            raise ValueError("创建项目组工作目录需要 setfacl，请先安装发行版的 acl 软件包")
        record = state["groups"].get(name)
        if not record:
            target = child(root, "projects/" + label)
            if target.exists() and any(target.iterdir()):
                raise ValueError("同名工作目录已存在且非空，不能自动接管")
            for candidate in [name, name + "_admin"]:
                try:
                    grp.getgrnam(candidate)
                except KeyError:
                    continue
                raise ValueError("同名 Linux 用户组已存在，不能接管：" + candidate)
            record = {"name": name, "label": label, "adminGroup": name + "_admin", "provisioning": True}
            state["groups"][name] = record
            save(root, state)
        elif not record.get("provisioning"):
            raise ValueError("用户组已存在且创建完成")
        provision_group(root, state, record, "gid", name, "成员用户组已创建")
        provision_group(root, state, record, "adminGid", record["adminGroup"], "子管理员用户组已创建")
        prepare_workspace(root, state, name)
        record["provisioning"] = False
        checkpoint(root, state, "工作目录与 ACL 已配置")
    elif op == "workspace_prepare":
        prepare_workspace(root, state, request.get("group"))
        checkpoint(root, state, "工作目录与 ACL 已配置")
    elif op == "user_groups":
        assign_groups(root, state, request)
    elif op == "group_member":
        username = request.get('username')
        ensure_user(state, username)
        group = request.get('group')
        record = state['groups'].get(group)
        role = request.get('role')
        if not record or not record.get('workspace') or record.get('provisioning'):
            raise ValueError('项目组不存在或工作目录尚未准备好')
        if role not in ['member', 'admin', 'remove']:
            raise ValueError('无效成员操作')
        if state['users'][username].get('provisioning'):
            raise ValueError('请先完成用户开通')
        import grp
        # Read current OS membership while holding the team lock. A group-level
        # change must not overwrite assignments made from another admin window.
        login = user_login(state, username)
        current = {g.gr_name for g in grp.getgrall() if login in g.gr_mem}
        groups = set(state['groups']) & current
        admins = {name for name, g in state['groups'].items() if g['adminGroup'] in current and name in groups}
        if role == 'remove': groups.discard(group)
        else: groups.add(group)
        if role == 'admin': admins.add(group)
        else: admins.discard(group)
        assign_groups(root, state, {**request, 'groups': sorted(groups), 'contentAdminGroups': sorted(admins)})
    elif op == "configure_sftp":
        config_dir = pathlib.Path("/etc/ssh/sshd_config.d")
        config_dir.mkdir(exist_ok=True)
        if "sshd_config.d" not in pathlib.Path("/etc/ssh/sshd_config").read_text():
            raise ValueError("sshd_config 未启用 drop-in Include，请运维先启用；工具不会改写主配置")
        file = config_dir / ("80-workbench-" + state["teamId"] + ".conf")
        config = ('Match Group ' + state["loginGroup"] + '\n    ChrootDirectory "' + str(root) + '"\n    ForceCommand internal-sftp\n    PasswordAuthentication yes\n    AuthenticationMethods password\n    PubkeyAuthentication no\n    DisableForwarding yes\n    PermitTTY no\nMatch all\n')
        previous = file.read_text() if file.exists() else None
        file.write_text(config)
        try:
            run([shutil.which("sshd") or "/usr/sbin/sshd", "-t"])
            unit = "sshd" if subprocess.run(["systemctl", "is-active", "--quiet", "sshd"]).returncode == 0 else "ssh"
            run(["systemctl", "reload", unit])
        except Exception:
            if previous is None:
                file.unlink(missing_ok=True)
            else:
                file.write_text(previous)
            raise
        state["sftpConfigured"] = True
    if op != "status":
        job = state.get("operations", {}).get(state.get("activeOperation"))
        if job:
            job["status"] = "done"
            job.pop("error", None)
        save(root, state)
        with child(root, ".workbench/admin/audit.jsonl").open("a", encoding="utf-8") as audit:
            json.dump({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "actor": actor, "operation": op, "username": request.get("username"), "groups": request.get("groups"), "label": request.get("label"), "group": request.get("group"), "role": request.get("role")}, audit, ensure_ascii=False)
            audit.write("\n")
    return {"state": actual_state(state), "value": result}

def execute(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有 Linux root 或 sudo 管理权限")
    root = root_directory(request)
    if request["op"] == "recover":
        state = load(root)
        job = state.get("operations", {}).get(request.get("operationId"))
        if not job or job.get("status") == "done":
            raise ValueError("没有可恢复的未完成操作")
        request = {**job["request"], "root": request["root"], "password": request.get("password", "")}
    try:
        return _execute(request)
    except Exception as error:
        if request["op"] not in ["status", "probe"]:
            try:
                state = load(root)
                key = operation_key(request)
                job = state.get("operations", {}).get(key)
                if job and job.get("status") != "done":
                    job["status"] = "failed"
                    job["error"] = str(error)[:1500]
                    save(root, state)
            except Exception:
                pass
        raise

def main(request):
    validate_request(request)
    if sys.platform != "linux" or os.geteuid() != 0:
        raise PermissionError("需要已有 Linux root 或 sudo 管理权限")
    if request["op"] == "probe":
        return execute(request)
    with state_lock(request):
        return execute(request)

if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print("WORKBENCH_READY", flush=True)
    try:
        request = json.loads(sys.stdin.readline())
        result = main(request)
        print(json.dumps({"ok": True, "value": result}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
