import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admin_program', pathlib.Path(__file__).parents[1] / 'server/admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)

class AdminSafetyTests(unittest.TestCase):
    def test_operation_and_path_validation(self):
        for root in ['/','/etc','/srv/../etc','/srv/x\nMatch All','/srv/x*','/srv/x/']:
            with self.assertRaises(ValueError): admin.validate_request({'op':'status','root':root})
        for op in ['write','project_create','acl_set','run_shell']:
            with self.assertRaises(ValueError): admin.validate_request({'op':op,'root':'/srv/teamspace'})

    def test_client_choice_cannot_grant_root(self):
        with patch.object(admin.sys, 'platform', 'linux'), patch.object(admin.os, 'geteuid', return_value=1001, create=True):
            with self.assertRaises(PermissionError): admin.main({'op':'user_create','root':'/srv/teamspace','administrator':True})

    def test_recreated_or_root_account_cannot_be_managed(self):
        fake = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=0))
        with patch.dict(sys.modules, {'pwd': fake}):
            with self.assertRaises(ValueError): admin.ensure_user({'users':{'alice':{'uid':1001}}}, 'alice')

    def test_password_is_stdin_not_command_argument(self):
        result = types.SimpleNamespace(returncode=0,stdout='',stderr='')
        with patch.object(admin.subprocess,'run',return_value=result) as run:
            admin.run(['chpasswd'],'alice:secret\n')
            self.assertEqual(run.call_args.args[0],['chpasswd'])
            self.assertEqual(run.call_args.kwargs['input'],'alice:secret\n')
            self.assertNotIn('shell',run.call_args.kwargs)

    def test_removing_subadmin_revokes_only_managed_group_and_existing_connections(self):
        state = {'users': {'alice': {'uid': 1001}}, 'groups': {'wb_t_ocr': {'adminGroup': 'wb_t_ocr_admin'}}}
        fake_grp = types.SimpleNamespace(getgrall=lambda: [types.SimpleNamespace(gr_name=g, gr_mem=['alice']) for g in ['wb_t_ocr','wb_t_ocr_admin','external']])
        fake_pwd = types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=1001))
        import tempfile
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, {'grp':fake_grp, 'pwd':fake_pwd}), patch.object(admin.sys,'platform','linux'), patch.object(admin.os,'geteuid',return_value=0,create=True), patch.object(admin.shutil,'which',side_effect=lambda n:n), patch.object(admin,'root_directory',return_value=pathlib.Path(temp)), patch.object(admin,'load',return_value=state), patch.object(admin,'save'), patch.object(admin,'actual_state',side_effect=lambda v:v), patch.object(admin,'run') as run:
            (pathlib.Path(temp)/'.workbench/admin').mkdir(parents=True)
            admin.execute({'op':'user_groups','root':'/srv/teamspace','username':'alice','groups':['wb_t_ocr'],'contentAdminGroups':[]})
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn(['gpasswd','-d','alice','wb_t_ocr_admin'], commands)
            self.assertIn(['pkill','-KILL','-u','alice'], commands)
            self.assertFalse(any('external' in c for c in commands))
            self.assertEqual(state['users']['alice']['contentAdminGroups'],[])

if __name__ == '__main__': unittest.main()
