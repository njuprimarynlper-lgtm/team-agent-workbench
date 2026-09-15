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

OPS = {"probe", "initialize", "status", "user_create", "user_password", "user_enabled", "group_create", "user_groups", "configure_sftp"}

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

def group_create(name):
    import grp
    try:
        grp.getgrnam(name)
    except KeyError:
        run(["groupadd", name])

def load(root):
    file = child(root, ".workbench/admin/state.json")
    if not file.is_file():
        raise ValueError("此目录尚未初始化为团队空间")
    return json.loads(file.read_text(encoding="utf-8"))

def save(root, state):
    atomic_json(child(root, ".workbench/admin/state.json"), state)
    roles = {"version": 1, "root": str(root), "users": {}}
    for username, user in state["users"].items():
        if user["enabled"]:
            assigned = [{"id": name, "name": state["groups"][name]["label"]} for name in user.get("contentAdminGroups", []) if name in state["groups"]]
            if assigned:
                roles["users"][username] = {"contentGroups": assigned}
    role_file = child(root, ".workbench/roles.json")
    atomic_json(role_file, roles)
    os.chmod(role_file, 0o644)

def ensure_user(state, username):
    identifier(username, 32)
    if username not in state["users"]:
        raise ValueError("只允许操作由此团队空间创建的成员账号")
    import pwd
    current = pwd.getpwnam(username)
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
            record = pwd.getpwnam(name)
            shadow = shadows[name]
            expires = int(shadow[7]) if shadow[7] else -1
            user["missing"] = record.pw_uid != user["uid"]
            user["enabled"] = not user["missing"] and not shadow[1].startswith(("!", "*")) and (expires < 0 or expires > today)
            user["groups"] = [g.gr_name for g in grp.getgrall() if name in g.gr_mem or g.gr_gid == record.pw_gid]
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

def execute(request):
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
        return {"initialized": False, "users": {}, "groups": {}}
    if missing:
        raise ValueError("服务器缺少命令：" + ", ".join(missing) + "。请先安装发行版的 OpenSSH、shadow/passwd、procps 软件包。")
    op = request["op"]
    if op == "initialize":
        if root.exists() and any(root.iterdir()):
            raise ValueError("初始化只接受不存在或空的专用目录；不会接管已有非空目录")
        root.mkdir(parents=True, exist_ok=True)
        for parent in [root] + list(root.parents)[:-1]:
            info = parent.stat()
            if parent != root and (info.st_uid != 0 or info.st_mode & 0o022):
                raise ValueError("SFTP 根路径的上级必须由 root 拥有且不可被组或其他用户写入")
        os.chown(root, 0, 0)
        os.chmod(root, 0o755)
        for relative in ["projects", ".workbench", ".workbench/users"]:
            directory = child(root, relative)
            directory.mkdir(exist_ok=True)
            os.chmod(directory, 0o711)
        admin = child(root, ".workbench/admin")
        admin.mkdir()
        os.chmod(admin, 0o700)
        team_id = uuid.uuid4().hex[:8]
        login_group = "wb_" + team_id + "_members"
        group_create(login_group)
        state = {"version": 1, "teamId": team_id, "name": str(request.get("name", "团队空间"))[:120], "loginGroup": login_group, "users": {}, "initialized": True, "groups": {}, "sftpConfigured": False}
        save(root, state)
    else:
        state = load(root)
    result = None
    if op == "status":
        return actual_state(state)
    if op == "user_create":
        import pwd
        username = identifier(request.get("username"), 32)
        password = request.get("password", "")
        if not isinstance(password, str) or len(password) < 8 or any(c in password for c in "\r\n\x00:"):
            raise ValueError("初始密码至少 8 位，不能含换行、冒号或空字符")
        try:
            pwd.getpwnam(username)
        except KeyError:
            pass
        else:
            raise ValueError("Linux 账号已存在，工具不会接管已有系统账号")
        shell = shutil.which("nologin") or "/usr/sbin/nologin"
        run(["useradd", "-M", "-d", "/", "-s", shell, "-g", state["loginGroup"], username])
        # Record before setting password so a failed password step can be retried via user_password.
        state["users"][username] = {"username": username, "uid": pwd.getpwnam(username).pw_uid, "name": str(request.get("name", username))[:120], "enabled": True}
        save(root, state)
        run(["chpasswd"], username + ":" + password + "\n")
    elif op == "user_password":
        username = request.get("username")
        ensure_user(state, username)
        password = request.get("password", "")
        if not isinstance(password, str) or len(password) < 8 or any(c in password for c in "\r\n\x00:"):
            raise ValueError("密码至少 8 位，且不能含换行、冒号或空字符")
        run(["chpasswd"], username + ":" + password + "\n")
        terminate_connections(username)
    elif op == "user_enabled":
        username = request.get("username")
        ensure_user(state, username)
        enabled = request.get("enabled") is True
        run(["usermod", "--expiredate", "" if enabled else "1", username])
        state["users"][username]["enabled"] = enabled
        if not enabled:
            terminate_connections(username)
    elif op == "group_create":
        label = identifier(request.get("label"), 14)
        name = "wb_" + state["teamId"] + "_" + label
        if name in state["groups"]:
            raise ValueError("用户组已存在")
        import grp
        try:
            grp.getgrnam(name)
        except KeyError:
            run(["groupadd", name])
        else:
            raise ValueError("同名 Linux 用户组已存在，不能接管")
        admin_group = name + "_admin"
        run(["groupadd", admin_group])
        state["groups"][name] = {"name": name, "label": label, "adminGroup": admin_group}
    elif op == "user_groups":
        username = request.get("username")
        ensure_user(state, username)
        groups = request.get("groups", [])
        if not isinstance(groups, list) or any(g not in state["groups"] for g in groups):
            raise ValueError("仅可分配当前团队创建的用户组")
        content_admin_groups = request.get("contentAdminGroups", [])
        if not isinstance(content_admin_groups, list) or any(g not in groups for g in content_admin_groups):
            raise ValueError("子管理员必须是对应项目组成员")
        desired = set(groups) | {state["groups"][g]["adminGroup"] for g in content_admin_groups}
        managed = set(state["groups"]) | {g["adminGroup"] for g in state["groups"].values()}
        import grp
        current = {g.gr_name for g in grp.getgrall() if username in g.gr_mem}
        for group in managed & current - desired:
            run(["gpasswd", "-d", username, group])
        if desired:
            run(["usermod", "-a", "-G", ",".join(sorted(desired)), username])
        state["users"][username]["contentAdminGroups"] = content_admin_groups
        save(root, state)
        terminate_connections(username)
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
        save(root, state)
        with child(root, ".workbench/admin/audit.jsonl").open("a", encoding="utf-8") as audit:
            json.dump({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "actor": actor, "operation": op, "username": request.get("username"), "groups": request.get("groups"), "label": request.get("label")}, audit, ensure_ascii=False)
            audit.write("\n")
    return {"state": actual_state(state), "value": result}

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
