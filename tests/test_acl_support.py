import ctypes
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('acl_support', pathlib.Path(__file__).parents[1] / 'server/acl_support.py')
acl = importlib.util.module_from_spec(spec); spec.loader.exec_module(acl)
BASE = {('user', ''): 'rw-', ('group', ''): '---', ('other', ''): '---'}


class AclFallbackTests(unittest.TestCase):
    def test_missing_command_uses_library_but_missing_both_is_reported(self):
        with patch.object(acl.shutil, 'which', return_value=None), patch.object(acl, '_acl_library') as library:
            self.assertEqual(acl.acl_backend(), 'libacl')
            library.side_effect = OSError('unavailable')
            self.assertIsNone(acl.acl_backend())

    def test_denied_command_does_not_fall_back_or_weaken_permissions(self):
        with patch.object(acl.shutil, 'which', return_value='/bin/setfacl'), patch.object(acl.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'setfacl')), patch.object(acl, '_acl_library') as library:
            with self.assertRaises(subprocess.CalledProcessError): acl.acl_apply(['-m', 'u:123:r--', '/srv/file'])
            library.assert_not_called()

    def test_clear_removes_named_entries_and_mask_and_default_acl(self):
        lib = Mock(); lib.acl_delete_def_file.return_value = 0
        with patch.object(acl.shutil, 'which', return_value=None), patch.object(acl, '_acl_library', return_value=lib), patch.object(acl, '_acl_read', return_value={**BASE, ('user', '123'): 'rwx', ('mask', ''): 'rwx'}), patch.object(acl, '_acl_write') as write:
            acl.acl_apply(['-b', '-k', '/srv/file'])
            self.assertEqual(write.call_args.args[3], BASE)
            lib.acl_delete_def_file.assert_called_once()

    def test_add_member_read_permission_preserves_other_entries_and_recalculates_mask(self):
        with patch.object(acl.shutil, 'which', return_value=None), patch.object(acl, '_acl_library'), patch.object(acl, '_acl_read', return_value={**BASE, ('group', '100'): 'r-x'}), patch.object(acl, '_acl_write') as write:
            acl.acl_apply(['-m', 'u:123:r--', '/srv/receipt'])
            self.assertEqual(write.call_args.args[3], {**BASE, ('group', '100'): 'r-x', ('user', '123'): 'r--'})
            self.assertTrue(write.call_args.args[4])

    def test_default_acl_seeds_base_entries_and_respects_explicit_mask(self):
        with patch.object(acl.shutil, 'which', return_value=None), patch.object(acl, '_acl_library'), patch.object(acl, '_acl_read', side_effect=[{}, BASE]), patch.object(acl, '_acl_write') as write:
            acl.acl_apply(['-d', '-m', 'g:100:rwx,m::r-x', '/srv/directory'])
            self.assertEqual(write.call_args.args[2], 0x4000)
            self.assertEqual(write.call_args.args[3][('mask', '')], 'r-x')
            self.assertFalse(write.call_args.args[4])

    def test_ffi_write_frees_acl_and_propagates_unsupported_filesystem(self):
        lib = Mock(); lib.acl_from_text.return_value = 123; lib.acl_valid.return_value = 0; lib.acl_set_file.return_value = -1
        ctypes.set_errno(95)
        with self.assertRaises(OSError) as error: acl._acl_write(lib, '/srv/file', 0x8000, BASE)
        self.assertEqual(error.exception.errno, 95)
        self.assertEqual(lib.acl_free.call_args.args[0].value, 123)

    def test_ffi_read_frees_both_text_and_acl(self):
        raw = ctypes.create_string_buffer(b'user::rw-\ngroup::---\nother::---\n')
        lib = Mock(); lib.acl_get_file.return_value = 123; lib.acl_to_text.return_value = ctypes.addressof(raw)
        self.assertEqual(acl._acl_read(lib, '/srv/file', 0x8000), BASE)
        self.assertEqual(lib.acl_free.call_count, 2)

    @unittest.skipUnless(sys.platform == 'linux', 'requires a Linux kernel and libacl')
    def test_real_library_acl_round_trip_without_setfacl(self):
        lib = acl._acl_library()
        with tempfile.TemporaryDirectory() as directory, patch.object(acl.shutil, 'which', return_value=None):
            file = pathlib.Path(directory) / 'test'; file.write_text('test'); os.chmod(file, 0o600)
            acl.acl_apply(['-m', 'u:65534:r--', str(file)])
            self.assertEqual(acl._acl_read(lib, file, 0x8000)[('user', '65534')], 'r--')
            acl.acl_apply(['-b', str(file)])
            self.assertNotIn(('user', '65534'), acl._acl_read(lib, file, 0x8000))
            acl.acl_apply(['-d', '-m', 'u::rwx,g::r-x,o::---', directory])
            acl.acl_apply(['-k', directory])
            self.assertEqual(acl._acl_read(lib, directory, 0x4000), {})
