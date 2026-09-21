import base64
import configparser
import importlib.util
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admin_environment', pathlib.Path(__file__).parents[1] / 'server/admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class EnvironmentTests(unittest.TestCase):
    def test_libacl_satisfies_missing_setfacl_during_probe(self):
        with patch.object(admin.shutil, 'which', side_effect=lambda name: None if name == 'setfacl' else name), patch.object(admin, 'acl_backend', return_value='libacl'), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}):
            result = admin.environment_probe()
        self.assertEqual(result['missingCommands'], []); self.assertEqual(result['aclBackend'], 'libacl')

    def test_online_preparation_installs_only_missing_optional_components(self):
        with patch.object(admin, 'acl_backend', return_value=None), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(admin, 'systemd_running', return_value=True), patch.object(admin.shutil, 'which', return_value='/usr/bin/apt-get'), patch.object(admin, 'environment_command') as command, patch.object(admin, 'environment_probe', return_value={'setupIssues': []}):
            result = admin.prepare_environment({'source': 'online'})
        self.assertEqual(result['preparedPackages'], ['acl'])
        self.assertEqual(command.call_count, 2)
        self.assertEqual(command.call_args.args[0][-2:], ['install', 'acl'])
        self.assertIn('--no-remove', command.call_args.args[0])

    def test_ready_environment_does_not_install_or_restart_anything(self):
        with patch.object(admin, 'acl_backend', return_value='libacl'), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(admin, 'systemd_running', return_value=True), patch.object(admin, 'environment_command') as command, patch.object(admin, 'environment_probe', return_value={}):
            for _ in range(2): self.assertEqual(admin.prepare_environment({'source': 'online'})['preparedPackages'], [])
        command.assert_not_called()

    def test_offline_preparation_never_updates_or_downloads_from_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / 'acl.deb').write_bytes(b'fixture'); (root / 'dependency.deb').write_bytes(b'fixture')
            with patch.object(admin, 'acl_backend', return_value=None), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(admin, 'systemd_running', return_value=True), patch.object(admin.shutil, 'which', return_value='apt-get'), patch.object(admin, 'trusted_service_path'), patch.object(admin, 'environment_command') as command, patch.object(admin, 'environment_probe', return_value={}), patch.object(admin.pathlib, 'Path', wraps=pathlib.Path) as constructor:
                constructor.side_effect = lambda value: root if value == '/opt/packages' else pathlib.Path(value)
                admin.prepare_environment({'source': 'offline', 'packageDirectory': '/opt/packages'})
            self.assertEqual(command.call_count, 1)
            args = command.call_args.args[0]; self.assertIn('--no-download', args); self.assertNotIn('update', args)
            self.assertIn(str(root / 'dependency.deb'), args)

    def test_offline_untrusted_directory_fails_before_package_execution(self):
        with patch.object(admin, 'acl_backend', return_value=None), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(admin.shutil, 'which', return_value='apt-get'), patch.object(admin, 'trusted_service_path', side_effect=ValueError('untrusted')), patch.object(admin, 'environment_command') as command:
            with self.assertRaisesRegex(ValueError, 'untrusted'): admin.prepare_environment({'source': 'offline', 'packageDirectory': '/tmp/packages'})
            command.assert_not_called()

    def test_package_failure_does_not_start_supervisor_and_retry_rechecks_dependencies(self):
        with patch.object(admin, 'acl_backend', return_value=None) as acl, patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(admin, 'systemd_running', return_value=True), patch.object(admin.shutil, 'which', return_value='apt-get'), patch.object(admin, 'environment_command', side_effect=RuntimeError('package lock')) as command, patch.object(admin, 'prepare_supervisor') as supervisor, patch.object(admin, 'environment_probe', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'package lock'): admin.prepare_environment({'source': 'online'})
            supervisor.assert_not_called()
            acl.return_value = 'libacl'; command.reset_mock()
            admin.prepare_environment({'source': 'online'}); command.assert_not_called()

    def test_existing_supervisor_is_reused_without_restarting(self):
        backend = {'kind': 'supervisor', 'config': '/etc/supervisor/supervisord.conf'}
        with patch.object(admin, 'service_backend', return_value=backend), patch.object(admin, 'environment_command') as command:
            self.assertEqual(admin.prepare_supervisor(), backend); command.assert_not_called()

    def test_dedicated_supervisor_setup_is_repeatable_and_preserves_modified_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); managed = root / 'managed'; runtime = root / 'run'
            path_class = pathlib.Path
            with patch.object(admin, 'MANAGED_SUPERVISOR', managed), patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', side_effect=lambda name: '/usr/bin/' + name), patch.object(admin, 'service_backend', side_effect=[ValueError('none'), {'kind': 'supervisor'}, ValueError('none'), {'kind': 'supervisor'}]), patch.object(admin, 'environment_command') as command, patch.object(admin.pathlib, 'Path', side_effect=lambda value: runtime if value == '/run/team-agent-workbench' else path_class(value)):
                admin.prepare_supervisor(); first = (managed / 'supervisord.conf').read_bytes()
                admin.prepare_supervisor(); self.assertEqual((managed / 'supervisord.conf').read_bytes(), first)
                self.assertEqual(command.call_count, 2)
                script = (managed / 'start-supervisor.sh').read_text(encoding='utf-8')
                self.assertIn('pid >/dev/null 2>&1 && exit 0', script)
                self.assertNotIn('restart', script)
                self.assertNotIn('/etc/ssh', script)
            (managed / 'supervisord.conf').write_text('external modification', encoding='utf-8')
            with patch.object(admin, 'MANAGED_SUPERVISOR', managed), patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='supervisord'), patch.object(admin, 'service_backend', side_effect=ValueError('none')), patch.object(admin, 'environment_command') as command, patch.object(admin.pathlib, 'Path', side_effect=lambda value: runtime if value == '/run/team-agent-workbench' else path_class(value)):
                with self.assertRaisesRegex(ValueError, '已被修改'): admin.prepare_supervisor()
                command.assert_not_called()

    def test_preparation_of_running_dedicated_supervisor_keeps_startup_note(self):
        with patch.object(admin.shutil, 'which', return_value='command'), patch.object(admin, 'service_backend', return_value={'kind': 'supervisor', 'managed': True}), patch.object(admin, 'ssh_reload_command', return_value=['service', 'ssh', 'reload']):
            probe = admin.environment_probe()
        self.assertEqual(probe['setupIssues'], [])
        self.assertIn('当前仅确认本次运行可用', probe['setupNotes'][0])

    def test_acl_is_reported_at_probe_with_distribution_install_command(self):
        with patch.object(admin.shutil, 'which', side_effect=lambda name: None if name == 'setfacl' else name), patch.object(admin, 'service_backend', return_value={'kind': 'systemd'}), patch.object(pathlib.Path, 'read_text', return_value='ID=ubuntu\nID_LIKE=debian\n'):
            result = admin.environment_probe()
        self.assertEqual(result['missingCommands'], ['setfacl'])
        self.assertIn('apt-get install -y acl', result['setupIssues'][0])
        self.assertEqual(result['serviceManager'], 'systemd')

    def test_missing_acl_blocks_before_initialization_or_group_mutation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(admin.sys, 'platform', 'linux'), patch.object(admin.os, 'geteuid', return_value=0, create=True), patch.object(admin.shutil, 'which', side_effect=lambda name: None if name == 'setfacl' else name), patch.object(admin, 'root_directory', return_value=pathlib.Path(directory)), patch.object(admin, 'initialize') as initialize, patch.object(admin, 'start_operation') as operation:
            for op in ('initialize', 'group_create'):
                with self.assertRaisesRegex(ValueError, 'setfacl.*ACL'):
                    admin._execute({'op': op, 'root': '/srv/test', 'label': 'ocr'})
            initialize.assert_not_called()
            operation.assert_not_called()

    def test_status_remains_readable_when_acl_was_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / '.workbench/admin').mkdir(parents=True); (root / '.workbench/admin/state.json').write_text('{}')
            state = {'initialized': True, 'users': {}, 'groups': {}}
            with patch.object(admin.sys, 'platform', 'linux'), patch.object(admin.os, 'geteuid', return_value=0, create=True), patch.object(admin.shutil, 'which', side_effect=lambda name: None if name == 'setfacl' else name), patch.object(admin, 'root_directory', return_value=root), patch.object(admin, 'load', return_value=state), patch.object(admin, 'actual_state', return_value=state), patch.object(admin, 'member_access_ready', return_value=False), patch.object(admin, 'write_roles') as write:
                self.assertTrue(admin._execute({'op': 'status', 'root': '/srv/test'})['initialized'])
                write.assert_not_called()

    def test_systemctl_binary_does_not_mean_systemd_is_running(self):
        with patch.object(admin.shutil, 'which', return_value='/bin/systemctl'), patch.object(pathlib.Path, 'read_text', return_value='bash\n'):
            self.assertFalse(admin.systemd_running())
        with patch.object(admin, 'systemd_running', return_value=False), patch.object(admin, 'SUPERVISOR_CONFIGS', []), patch.object(admin.shutil, 'which', return_value='supervisorctl'):
            with self.assertRaisesRegex(ValueError, '未检测到运行中的'):
                admin.service_backend()

    def test_root_controlled_system_links_are_allowed_but_writable_targets_are_rejected(self):
        modes = {'/var/run': (0, stat.S_IFLNK | 0o777)}
        links = {'/var/run': '/run'}
        checked = set()

        class ServicePath(pathlib.PurePosixPath):
            def lstat(self):
                checked.add(str(self))
                uid, mode = modes.get(str(self), (0, stat.S_IFDIR | 0o755))
                return types.SimpleNamespace(st_uid=uid, st_mode=mode)

            def readlink(self):
                return ServicePath(links[str(self)])

            def resolve(self, strict=False):
                return self

        admin.trusted_service_path(ServicePath('/var/run/supervisor.sock'))
        self.assertIn('/run', checked)
        links['/var/run'] = '/home/member/locked'
        modes['/home/member'] = (1000, stat.S_IFDIR | 0o755)
        with self.assertRaisesRegex(ValueError, '/home/member'):
            admin.trusted_service_path(ServicePath('/var/run/supervisor.sock'))
        modes['/home/member'] = (0, stat.S_IFDIR | 0o777)
        with self.assertRaisesRegex(ValueError, '/home/member'):
            admin.trusted_service_path(ServicePath('/var/run/supervisor.sock'))

    def test_supervisor_requires_running_local_socket_and_included_config_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / 'conf.d').mkdir(); socket = root / 'supervisor.sock'; socket.touch()
            config = root / 'supervisord.conf'
            config.write_text('[supervisorctl]\nserverurl=unix://' + str(socket) + '\n[include]\nfiles=conf.d/*.conf\n', encoding='utf-8')
            original_stat = pathlib.Path.stat
            def stats(file, *args, **kwargs):
                return types.SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600) if file == socket else original_stat(file, *args, **kwargs)
            with patch.object(admin, 'systemd_running', return_value=False), patch.object(admin, 'SUPERVISOR_CONFIGS', [config]), patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='/usr/bin/supervisorctl'), patch.object(admin.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout='123\n')) as run, patch.object(pathlib.Path, 'stat', stats):
                backend = admin.service_backend()
                self.assertEqual(backend['kind'], 'supervisor'); self.assertEqual(backend['directory'], str(root / 'conf.d'))
                self.assertEqual(run.call_args.args[0], ['/usr/bin/supervisorctl', '-c', str(config), 'pid'])
                config.write_text('[supervisorctl]\nserverurl=http://remote:9001\n[include]\nfiles=conf.d/*.conf\n', encoding='utf-8')
                run.reset_mock()
                with self.assertRaises(ValueError): admin.service_backend()
                run.assert_not_called()

    def test_non_systemd_ssh_reload_uses_existing_service_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / 'ssh').write_text('fixture')
            with patch.object(admin, 'INIT_SCRIPTS', root), patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='/usr/sbin/service'):
                self.assertEqual(admin.ssh_reload_command({'kind': 'supervisor'}), ['/usr/sbin/service', 'ssh', 'reload'])
            with patch.object(admin.shutil, 'which', return_value=None):
                with self.assertRaisesRegex(ValueError, '重载入口'): admin.ssh_reload_command({'kind': 'supervisor'})

    def test_systemd_selects_the_active_ssh_unit(self):
        with patch.object(admin.subprocess, 'run', side_effect=[types.SimpleNamespace(returncode=1), types.SimpleNamespace(returncode=0)]):
            self.assertEqual(admin.ssh_reload_command({'kind': 'systemd'}), ['systemctl', 'reload', 'ssh'])

    def test_supervisor_registration_restarts_only_our_service_and_checks_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'space % root'; root.mkdir(); program = root / 'content.py'; name = 'team-agent-storage-test'
            backend = {'kind': 'supervisor', 'directory': str(root), 'suffix': '.conf', 'command': 'supervisorctl', 'config': str(root / 'supervisord.conf')}
            with patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='/usr/bin/python3'), patch.object(admin, 'run', return_value=name + ' RUNNING pid 123, uptime 0:00:02') as run:
                admin.activate_content_worker(root, program, name, backend)
                self.assertEqual([call.args[0][3:] for call in run.call_args_list], [['reread'], ['update', name], ['restart', name], ['status', name]])
                parser = configparser.RawConfigParser(); parser.read(root / (name + '.conf'), encoding='utf-8')
                section = parser['program:' + name]
                self.assertEqual(section['autostart'], 'true'); self.assertEqual(section['autorestart'], 'true')
                self.assertEqual(section['stopasgroup'], 'true'); self.assertIn('%%', section['command'])
            with patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='/usr/bin/python3'), patch.object(admin, 'run', return_value=name + ' FATAL failed'):
                with self.assertRaisesRegex(RuntimeError, '未进入 RUNNING'): admin.activate_content_worker(root, program, name, backend)

    def test_systemd_registration_keeps_enable_restart_and_health_check(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(admin, 'trusted_service_path'), patch.object(admin.shutil, 'which', return_value='/usr/bin/python3'), patch.object(admin, 'run') as run:
            root = pathlib.Path(directory)
            with patch.object(admin, 'SYSTEMD_UNITS', root): admin.activate_content_worker(root, root / 'content.py', 'team-agent-storage-test', {'kind': 'systemd'})
            self.assertEqual([call.args[0][1] for call in run.call_args_list], ['daemon-reload', 'enable', 'restart', 'is-active'])
            self.assertIn('Restart=on-failure', (root / 'team-agent-storage-test.service').read_text())

    def test_failed_worker_start_does_not_mark_storage_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); (root / '.workbench/admin').mkdir(parents=True)
            state = {'teamId': 'test', 'storageVersion': 0, 'users': {}, 'groups': {}}
            with patch.object(admin, 'CONTENT_WORKER_BASE64', base64.b64encode(b'print("fixture")').decode(), create=True), patch.object(admin.os, 'chown', create=True), patch.object(admin, 'prepare_request_directories'), patch.object(admin, 'protect_public_tree'), patch.object(admin, 'activate_content_worker', side_effect=RuntimeError('service failed')):
                with self.assertRaisesRegex(RuntimeError, 'service failed'): admin.install_content_worker(root, state, backend={'kind': 'supervisor'})
            self.assertEqual(state['storageVersion'], 0); self.assertNotIn('storageServiceManager', state)

    def test_unsupported_manager_is_rejected_before_ssh_configuration_changes(self):
        with patch.object(admin, 'service_backend', side_effect=ValueError('unsupported')), patch.object(admin, 'member_access_file') as file:
            with self.assertRaises(ValueError): admin.configure_member_access(pathlib.Path('/srv/test'), {})
            file.assert_not_called()

    def test_invalid_sshd_configuration_rolls_back_without_reloading_or_starting_worker(self):
        for previous in (None, 'previous rule\n'):
            with self.subTest(previous=previous), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory); rule = root / 'member.conf'
                if previous is not None: rule.write_text(previous, encoding='utf-8')
                state = {'loginGroup': 'test-members', 'sftpConfigured': False}
                with patch.object(admin, 'service_backend', return_value={'kind': 'supervisor'}), patch.object(admin, 'ssh_reload_command', return_value=['service', 'ssh', 'reload']), patch.object(admin, 'member_access_file', return_value=rule), patch.object(admin, 'enable_member_access_include', return_value=None), patch.object(admin.shutil, 'which', return_value='/usr/sbin/sshd'), patch.object(admin, 'run', side_effect=RuntimeError('invalid sshd config')) as run, patch.object(admin, 'install_content_worker') as install:
                    with self.assertRaisesRegex(RuntimeError, 'invalid sshd config'):
                        admin.configure_member_access(root, state)
                    run.assert_called_once_with(['/usr/sbin/sshd', '-t'])
                    install.assert_not_called()
                self.assertEqual(rule.read_text(encoding='utf-8') if rule.exists() else None, previous)
                self.assertFalse(state['sftpConfigured'])

    def test_sshd_validation_precedes_reload_and_worker_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); state = {'loginGroup': 'test-members'}; calls = []
            backend = {'kind': 'supervisor'}
            with patch.object(admin, 'service_backend', return_value=backend), patch.object(admin, 'ssh_reload_command', return_value=['service', 'ssh', 'reload']), patch.object(admin, 'member_access_file', return_value=root / 'member.conf'), patch.object(admin, 'enable_member_access_include', return_value=None), patch.object(admin.shutil, 'which', return_value='/usr/sbin/sshd'), patch.object(admin, 'run', side_effect=lambda command: calls.append(command)), patch.object(admin, 'install_content_worker', side_effect=lambda *args, **kwargs: calls.append(['worker', kwargs['backend']])):
                admin.configure_member_access(root, state)
            self.assertEqual(calls, [['/usr/sbin/sshd', '-t'], ['service', 'ssh', 'reload'], ['worker', backend]])
            self.assertTrue(state['sftpConfigured'])


if __name__ == '__main__':
    unittest.main()
