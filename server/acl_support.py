"""ACL command compatibility shared by the SSH administrator and file worker.

Only dependency absence permits fallback; a denied/unsupported ACL write does not.
This source is embedded into both remote programs by AdminConnection.
"""
import ctypes
import os
import pathlib
import shutil
import subprocess
import sys


def _acl_library():
    if sys.platform != 'linux':
        raise OSError('libacl requires Linux')
    lib = ctypes.CDLL('libacl.so.1', use_errno=True)
    signatures = {
        'acl_get_file': ([ctypes.c_char_p, ctypes.c_int], ctypes.c_void_p),
        'acl_to_text': ([ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)], ctypes.c_void_p),
        'acl_from_text': ([ctypes.c_char_p], ctypes.c_void_p),
        'acl_set_file': ([ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
        'acl_delete_def_file': ([ctypes.c_char_p], ctypes.c_int),
        'acl_calc_mask': ([ctypes.POINTER(ctypes.c_void_p)], ctypes.c_int),
        'acl_valid': ([ctypes.c_void_p], ctypes.c_int),
        'acl_free': ([ctypes.c_void_p], ctypes.c_int),
    }
    for name, (args, result) in signatures.items():
        function = getattr(lib, name); function.argtypes = args; function.restype = result
    return lib


def acl_backend():
    if shutil.which('setfacl'):
        return 'setfacl'
    try:
        _acl_library()
        return 'libacl'
    except (OSError, AttributeError):
        return None


def _acl_check(result, path):
    if result == -1:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(path))


def _acl_entries(text):
    result = {}
    aliases = {'u': 'user', 'g': 'group', 'm': 'mask', 'o': 'other'}
    for line in text.replace(',', '\n').splitlines():
        line = line.split('#', 1)[0].strip()
        if not line: continue
        tag, qualifier, permissions = line.split(':')
        tag = aliases.get(tag, tag)
        if qualifier and tag in ('user', 'group'):
            if qualifier.isdigit(): qualifier = str(int(qualifier))
            else:
                import pwd, grp
                qualifier = str(pwd.getpwnam(qualifier).pw_uid if tag == 'user' else grp.getgrnam(qualifier).gr_gid)
        result[(tag, qualifier)] = permissions
    return result


def _acl_read(lib, path, kind):
    acl = lib.acl_get_file(os.fsencode(path), kind)
    if not acl:
        _acl_check(-1, path)
    try:
        text = lib.acl_to_text(acl, None)
        if not text: _acl_check(-1, path)
        try: return _acl_entries(ctypes.string_at(text).decode('utf-8'))
        finally: lib.acl_free(text)
    finally: lib.acl_free(acl)


def _acl_write(lib, path, kind, entries, calculate_mask=False):
    raw = '\n'.join(':'.join((*key, value)) for key, value in entries.items()).encode('utf-8')
    acl = ctypes.c_void_p(lib.acl_from_text(raw))
    if not acl.value: _acl_check(-1, path)
    try:
        if calculate_mask: _acl_check(lib.acl_calc_mask(ctypes.byref(acl)), path)
        _acl_check(lib.acl_valid(acl), path)
        _acl_check(lib.acl_set_file(os.fsencode(path), kind, acl), path)
    finally: lib.acl_free(acl)


def acl_apply(arguments):
    arguments = [str(value) for value in arguments]
    executable = shutil.which('setfacl')
    if executable:
        result = subprocess.run([executable, *arguments], check=True, capture_output=True, text=True, timeout=30)
        return result.stdout.strip()
    # The application only uses these fixed operations; do not interpret arbitrary flags.
    options, path = arguments[:-1], pathlib.Path(arguments[-1])
    if options not in (['-b'], ['-b', '-k'], ['-k']) and not (len(options) == 2 and options[0] == '-m') and not (len(options) == 3 and options[:2] == ['-d', '-m']):
        raise ValueError('不支持的 ACL 操作')
    if path.is_symlink(): raise ValueError('ACL 路径不能是符号链接')
    lib = _acl_library()
    if '-b' in options:
        base = {key: value for key, value in _acl_read(lib, path, 0x8000).items() if key in (('user', ''), ('group', ''), ('other', ''))}
        _acl_write(lib, path, 0x8000, base)
    if '-k' in options:
        _acl_check(lib.acl_delete_def_file(os.fsencode(path)), path)
    if '-m' in options:
        kind = 0x4000 if '-d' in options else 0x8000
        entries = _acl_read(lib, path, kind)
        if not entries and kind == 0x4000:
            entries = {key: value for key, value in _acl_read(lib, path, 0x8000).items() if key in (('user', ''), ('group', ''), ('other', ''))}
        changes = _acl_entries(options[-1]); entries.update(changes)
        _acl_write(lib, path, kind, entries, ('mask', '') not in changes)
    return ''
