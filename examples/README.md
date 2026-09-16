# 运维配置说明

0.2.0 会在创建组时准备工作目录，子管理员在用户版创建项目和轨迹目录。以下是旧版手动目录/自定义存储策略的可选运维示例，不要对已经由 0.2.0 管理的工作目录直接重复执行。示例中的组名、用户名、路径必须替换为实际值；不要将示例密码写进脚本。

总管理员在界面创建 `ocr` 组后，会得到 `wb_<团队ID>_ocr` 和 `wb_<团队ID>_ocr_admin` 两个 Linux 组。普通成员加入前者，项目内容子管理员同时加入后者。0.2.0 为项目组父目录配置创建权限；下列示例则展示单独维护的旧目录。

例如，把参考资料设为成员可读、项目子管理员可维护；成果允许维护者整理，而会话归档只给本人读写：

```bash
# 由已有 Linux 管理员执行，示例路径和名称需要替换。
# 先确保已安装发行版的 acl 包。
ROOT=/srv/teamspace
READ_GROUP=wb_实际团队ID_ocr
CONTENT_GROUP=wb_实际团队ID_ocr_admin
MEMBER=alice

install -d -o root -g root -m 0711 "$ROOT/projects"
install -d -o root -g root -m 0700 "$ROOT/projects/ocr"
setfacl -m "g:$READ_GROUP:r-x,g:$CONTENT_GROUP:r-x" "$ROOT/projects/ocr"

install -d -o root -g root -m 0700 "$ROOT/projects/ocr/reference"
setfacl -m "g:$READ_GROUP:r-x,g:$CONTENT_GROUP:rwx" "$ROOT/projects/ocr/reference"
setfacl -d -m "u::rwx,g::---,o::---,g:$READ_GROUP:r-x,g:$CONTENT_GROUP:rwx" "$ROOT/projects/ocr/reference"

install -d -o root -g root -m 0711 "$ROOT/projects/ocr/submissions" "$ROOT/projects/ocr/sessions"
install -d -o root -g root -m 0700 "$ROOT/projects/ocr/submissions/$MEMBER" "$ROOT/projects/ocr/sessions/$MEMBER"
setfacl -m "u:$MEMBER:rwx,g:$CONTENT_GROUP:rwx" "$ROOT/projects/ocr/submissions/$MEMBER"
setfacl -d -m "u::rwx,g::---,o::---,u:$MEMBER:rwx,g:$CONTENT_GROUP:rwx" "$ROOT/projects/ocr/submissions/$MEMBER"
setfacl -m "u:$MEMBER:rwx" "$ROOT/projects/ocr/sessions/$MEMBER"
setfacl -d -m "u::rwx,g::---,o::---,u:$MEMBER:rwx" "$ROOT/projects/ocr/sessions/$MEMBER"
```

普通文件通常以非执行权限创建，默认 ACL 会与创建模式共同计算。目录写权限包含创建、重命名和删除目录项的能力；不能把“文件只读”当作“不可被父目录维护者删除”。若需不可变成果、删除隔离或管理员无权查看个人会话，应另行制定存储策略；Linux root 始终拥有系统级权限。

上例让项目根目录可列出子目录名称，个人会话目录由本人 ACL 控制内容访问。若连名称也需隐藏，运维应改用仅可穿过的目录和各人的精确入口清单，而不是让客户端列表过滤承担安全职责。

`member-connection.json` 是用户版可导入的示例。修改服务器地址、账号和路径；密码由用户在连接对话框填写。启用 chroot 后，路径从 `/projects/...` 开始。
