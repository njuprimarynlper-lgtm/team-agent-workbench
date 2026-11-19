"""Privileged integration probe: run ONLY inside the disposable CI container.

Uses the unchanged production admin/worker, real Unix identities, Supervisor,
OpenSSH and member SFTP. Faults are executable wrappers, not mocked business code.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import re
import subprocess
import time
import uuid
import zlib

import paramiko

REPO = pathlib.Path(__file__).resolve().parents[3]
EVIDENCE = pathlib.Path('/var/lib/workbench-probe')
ROOT = pathlib.Path('/srv/issue5-space')
PASSWORD = 'fixture-initial-password'
CHANGED_PASSWORD = 'fixture-changed-password'


def run(*command):
    return subprocess.run(command, check=True, text=True, capture_output=True, timeout=40).stdout.strip()


def wait(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, paramiko.SSHException):
            pass
        time.sleep(0.2)
    raise AssertionError('Container service did not become ready')


def load_admin():
    spec = importlib.util.spec_from_file_location('issue5_admin', REPO / 'server/admin.py')
    admin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admin)
    # Exactly the worker bundle layout used by AdminConnection.loadCode.
    body = b'\n'.join((REPO / ('server/' + name)).read_bytes() for name in ['acl_support.py', 'group_ops.py', 'content.py'])
    admin.CONTENT_WORKER_ZLIB_BASE64 = base64.b64encode(zlib.compress(body)).decode()
    return admin


def operation(admin, op, root=ROOT, **fields):
    return admin.main(dict(root=str(root), op=op, **fields))


def connect(username, password):
    client = paramiko.SSHClient()
    # Disposable, loopback-only test identity; never used with a real central node.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect('127.0.0.1', port=22, username=username, password=password,
                   allow_agent=False, look_for_keys=False, timeout=10, auth_timeout=10)
    return client


def request(sftp, login, body):
    identifier = str(uuid.uuid4())
    base = '/.workbench/inbox/' + login + '/' + identifier
    with sftp.open(base + '.tmp', 'w') as output:
        output.write(json.dumps(body).encode())
    sftp.rename(base + '.tmp', base + '.request.json')
    target = '/.workbench/outbox/' + login + '/' + identifier + '.json'

    def received():
        try:
            with sftp.open(target) as stream:
                return json.load(stream)
        except FileNotFoundError:
            return None

    result = wait(received)
    assert result.get('ok'), 'Worker rejected the controlled probe: ' + str(result.get('error'))
    return result['value']


def worker_status(admin, root=ROOT):
    state = admin.load(root)
    name = 'team-agent-storage-' + state['teamId']
    status = run('supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'status', name)
    assert re.search(r'\bRUNNING\b', status), status
    return state, name


def environment(admin):
    assert pathlib.Path('/proc/1/comm').read_text().strip() == 'bash'
    assert not admin.systemd_running()
    backend = wait(lambda: admin.service_backend())
    assert backend['kind'] == 'supervisor'
    assert admin.ssh_reload_command(backend)[-2:] == ['ssh', 'reload']
    wait(lambda: run('supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'status', 'sshd').split()[1] == 'RUNNING')


def check_member(admin, username, password, root=ROOT):
    state, _ = worker_status(admin, root)
    user = state['users'][username]
    assert not user.get('provisioning')
    login = user.get('systemUsername', username)
    assert pwd.getpwnam(login).pw_uid == user['uid']
    client = connect(login, password)
    return client, client.open_sftp(), login


def create(admin):
    environment(admin)
    keeper = connect('issue5_keeper', 'fixture-keeper-password')
    channel = keeper.get_transport().open_session()
    channel.exec_command('cat')
    channel.settimeout(10)
    channel.sendall(b'BEFORE_RELOAD\n')
    assert b'BEFORE_RELOAD' in channel.recv(1024)
    try:
        operation(admin, 'initialize')
        operation(admin, 'group_create', label='issue5_research')
        group = next(iter(admin.load(ROOT)['groups']))
        operation(admin, 'user_create', username='issue5_member', password=PASSWORD,
                  groups=[group], contentAdminGroups=[group])
        state, name = worker_status(admin)
        assert state['sftpConfigured'] and state['storageVersion'] == 1
        assert state['storageServiceManager'] == 'supervisor'
        channel.sendall(b'AFTER_RELOAD\n')
        assert b'AFTER_RELOAD' in channel.recv(1024), 'SSH reload must retain an existing SSH connection'
        client, sftp, login = check_member(admin, 'issue5_member', PASSWORD)
        try:
            assert request(sftp, login, {'op': 'password_status'})['required']
            assert request(sftp, login, {'op': 'password_change', 'oldPassword': PASSWORD, 'newPassword': CHANGED_PASSWORD}) is True
            initial = request(sftp, login, {'op': 'account_read'})
            records = {'material:issue5': {'title': 'persistent service probe'}}
            assert request(sftp, login, {'op': 'account_write', 'revision': initial['revision'], 'records': records})['records'] == records
        finally:
            sftp.close(); client.close()

        # A real command failure after useradd must recover the same identity.
        fault = pathlib.Path('/root/issue5-command-fault'); fault.mkdir()
        wrapper = fault / 'chpasswd'; wrapper.write_text('#!/bin/sh\nexit 73\n'); wrapper.chmod(0o755)
        previous_path = os.environ['PATH']
        try:
            os.environ['PATH'] = str(fault) + ':' + previous_path
            try:
                operation(admin, 'user_create', username='issue5_recover', password=PASSWORD, groups=[group])
                raise AssertionError('Injected chpasswd failure was not observed')
            except RuntimeError:
                pass
        finally:
            os.environ['PATH'] = previous_path
        failed = admin.load(ROOT)
        pending = failed['users']['issue5_recover']
        assert pending['provisioning']
        uid = pending['uid']; recovered_login = pending['systemUsername']
        job = failed['operations'][failed['activeOperation']]
        assert job['status'] == 'failed'
        operation(admin, 'recover', operationId=failed['activeOperation'], password=PASSWORD)
        recovered = admin.load(ROOT)
        assert recovered['users']['issue5_recover']['uid'] == uid
        assert not recovered['users']['issue5_recover']['provisioning']
        assert recovered['operations'][failed['activeOperation']]['status'] == 'done'
        assert len([account for account in pwd.getpwall() if account.pw_name == recovered_login]) == 1
        recover_client, recover_sftp, recover_login = check_member(admin, 'issue5_recover', PASSWORD)
        try:
            assert request(recover_sftp, recover_login, {'op': 'password_status'})['required']
        finally:
            recover_sftp.close(); recover_client.close()

        # A genuinely unstartable worker may not set the ready flags.
        bad_root = pathlib.Path('/srv/issue5-worker-failure')
        operation(admin, 'initialize', root=bad_root)
        false_python = fault / 'python3'; false_python.write_text('#!/bin/sh\nexit 74\n'); false_python.chmod(0o755)
        try:
            os.environ['PATH'] = str(fault) + ':' + previous_path
            try:
                operation(admin, 'user_create', root=bad_root, username='issue5_worker_recover', password=PASSWORD)
                raise AssertionError('Injected worker startup failure was not observed')
            except RuntimeError:
                pass
        finally:
            os.environ['PATH'] = previous_path
        failed_worker = admin.load(bad_root)
        assert not failed_worker.get('sftpConfigured') and failed_worker.get('storageVersion', 0) != 1
        assert failed_worker['operations'][failed_worker['activeOperation']]['status'] == 'failed'
        false_python.unlink(); wrapper.unlink()
        operation(admin, 'recover', root=bad_root, operationId=failed_worker['activeOperation'], password=PASSWORD)
        assert admin.load(bad_root)['sftpConfigured']
        worker_status(admin, bad_root)

        user = admin.load(ROOT)['users']['issue5_member']
        report = dict(phase='create', passed=True, pid1='bash', serviceManager='supervisor',
                      uid=user['uid'], login=login, worker=name, starts=int((EVIDENCE / 'start-count').read_text()),
                      checks=['first member creation', 'sshd validation and safe reload', 'existing SSH connection retained',
                              'real member SFTP', 'password change through worker', 'controlled account write',
                              'partial account creation recovery without duplicate UID', 'worker startup failure remains unready',
                              'failed worker provisioning recovery'])
        (EVIDENCE / 'report.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    finally:
        channel.close(); keeper.close()


def restarted(admin):
    environment(admin)
    old = json.loads((EVIDENCE / 'report.json').read_text())
    assert int((EVIDENCE / 'start-count').read_text()) > old['starts']
    state, _ = worker_status(admin)
    assert state['users']['issue5_member']['uid'] == old['uid']
    client, sftp, login = check_member(admin, 'issue5_member', CHANGED_PASSWORD)
    try:
        value = request(sftp, login, {'op': 'account_read'})
        assert value['records']['material:issue5']['title'] == 'persistent service probe'
        assert request(sftp, login, {'op': 'password_status'})['required'] is False
    finally:
        sftp.close(); client.close()
    worker_status(admin, pathlib.Path('/srv/issue5-worker-failure'))
    print(json.dumps(dict(phase='restart', passed=True, pid1='bash', serviceManager='supervisor',
                         checks=['container restarted', 'Supervisor automatically started both file workers',
                                 'same member UID and changed password', 'real SSH and SFTP restored', 'stored content retained'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=['create', 'restart'], required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and pathlib.Path('/opt/workbench/server/admin.py').is_file(), 'Disposable Linux container required'
    admin = load_admin()
    (create if args.phase == 'create' else restarted)(admin)
