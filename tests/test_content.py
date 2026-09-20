"""Real worker business rules on disk; Linux-only case also tests kernel ACL denial.

Windows mocks ownership/chmod only. It is not a substitute for the Linux case.
"""
import copy
import importlib.util
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('content', pathlib.Path(__file__).parents[1] / 'server/content.py')
content = importlib.util.module_from_spec(spec)
spec.loader.exec_module(content)

BRIEF = dict(background='项目背景', objectives='提升质量', acceptance='指标验收')

class ContentRules(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        for folder in ['projects/relation', 'projects/ocr', '.workbench/admin']:
            (self.root / folder).mkdir(parents=True)
        self.state = {'users': {
            'alice': {'enabled': True, 'groups': ['relation', 'ocr'], 'contentAdminGroups': ['relation']},
            'bob': {'enabled': True, 'groups': ['relation', 'ocr'], 'contentAdminGroups': ['ocr']},
            'carol': {'enabled': True, 'groups': ['ocr'], 'contentAdminGroups': []}},
            'groups': {g: {'workspace': 'projects/' + g, 'gid': 100} for g in ['relation', 'ocr']}}
        for mock in [patch.object(content.os, 'chown', create=True), patch.object(content.os, 'chmod'), patch.object(content.subprocess, 'run')]:
            mock.start(); self.addCleanup(mock.stop)
        self.project = self.call('alice', op='create_project', name='实体抽取', groupName='relation', brief=BRIEF)['projectId']
        self.directory = self.root / 'projects/relation/实体抽取'
        self.incoming = self.root / 'incoming.bin'; self.incoming.write_bytes(b'original')

    def call(self, actor, **request):
        return content.handle(self.root, self.state, actor, {'projectId': getattr(self, 'project', None), **request}, getattr(self, 'incoming', None))

    def publish(self, actor='bob', name='result.zip', kind='contribution'):
        return self.call(actor, op='publish', target='/projects/relation/实体抽取/submissions/' + actor + '/' + name, sha256=content.digest(self.incoming), metadata={'title': '方案结论', 'description': '已验证内容', 'kind': kind})

    def edit(self, actor, item, **change):
        return self.call(actor, op='edit_content', change={'id': item['id'], 'revision': item['revision'], 'action': 'save', 'title': '新标题', 'description': '新证据', **change})

    def test_owner_updates_then_admin_locks(self):
        item = self.edit('bob', self.publish())
        self.assertEqual(item['revision'], 2)
        curated = self.edit('alice', item, curate=True)
        self.assertEqual(curated['author'], 'bob'); self.assertEqual(curated['state'], 'curated')
        for action in ['save', 'delete']:
            with self.assertRaises(PermissionError): self.edit('bob', curated, action=action)

    def test_group_scope_and_distinct_roles(self):
        with self.assertRaises(PermissionError): self.publish('carol')
        with self.assertRaises(PermissionError): self.call('bob', op='save_brief', brief=BRIEF, revision=1)
        project = self.call('bob', op='create_project', name='OCR', groupName='ocr')
        with self.assertRaises(PermissionError): self.call('alice', op='save_brief', projectId=project['projectId'], brief=BRIEF, revision=0)

    def test_other_member_cannot_update_or_claim_curation(self):
        self.state['users']['carol']['groups'].append('relation')
        item = self.publish()
        with self.assertRaises(PermissionError): self.edit('carol', item)
        with self.assertRaises(PermissionError): self.edit('bob', item, curate=True)
        with self.assertRaises(PermissionError): self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/alice/injected', sha256=content.digest(self.incoming))

    def test_retry_does_not_duplicate_or_restore_curated_item(self):
        original = self.publish(); curated = self.edit('alice', original)
        retry = self.publish()
        self.assertEqual(retry['id'], original['id'])
        items = content.read_json(self.directory / '.workbench-content.json')
        self.assertEqual(len(items), 1); self.assertEqual(items[0]['path'], curated['path'])
        self.assertFalse((self.directory / 'submissions/bob/result.zip').exists())

    def test_stale_revision_rejected_and_merge_removes_source_files(self):
        one = self.publish(); two = self.publish(name='second.zip')
        updated = self.edit('bob', one)
        with self.assertRaises(ValueError): self.edit('alice', one)
        result = self.edit('alice', updated, merge=[{'id': two['id'], 'revision': two['revision']}])
        self.assertEqual(result['sources'], [two['id']])
        self.assertEqual({source['id'] for source in result['provenance']}, {updated['id'], two['id']})
        self.assertFalse((self.directory / 'submissions/bob/second.zip').exists())
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)

    def test_author_can_delete_only_pending(self):
        item = self.publish()
        self.assertIsNone(self.edit('bob', item, action='delete'))
        self.assertEqual(content.read_json(self.directory / '.workbench-content.json'), [])

    def test_replacement_creates_new_revision_and_locks_for_admin(self):
        item = self.publish(kind='file'); self.incoming.write_bytes(b'replacement')
        request = dict(op='edit_content', change={'id': item['id'], 'revision': 1, 'action': 'save', 'title': '文件', 'description': '已替换'}, replacement={'extension': '.bin', 'sha256': content.digest(self.incoming)})
        result = self.call('alice', **request)
        self.assertEqual(content.safe(self.root, result['path']).read_bytes(), b'replacement')
        self.assertEqual(result['state'], 'curated')
        self.assertFalse(content.safe(self.root, item['path']).exists())
        request['change']['revision'] = 2
        with self.assertRaises(PermissionError): self.call('bob', **request)

    def test_project_lifecycle_uses_marker_not_empty_directory(self):
        (self.root / 'projects/relation/.keep').write_text('keep')
        other = self.call('alice', op='create_project', name='另一个项目', groupName='relation')['projectId']
        self.assertNotEqual(other, self.project)
        self.assertTrue((self.directory / 'trajectories').is_dir())
        with self.assertRaises(FileExistsError): self.call('alice', op='create_project', name='实体抽取', groupName='relation')

    def test_brief_versions_reject_stale_saves(self):
        result = self.call('alice', op='save_brief', brief={**BRIEF, 'objectives': '新目标'}, revision=1)
        self.assertEqual(result['briefRevision'], 2)
        self.assertIn('新目标', (self.directory / '.brief-versions/2.md').read_text(encoding='utf-8'))
        with self.assertRaises(ValueError): self.call('alice', op='save_brief', brief=BRIEF, revision=1)
        with self.assertRaises(ValueError): self.call('alice', op='save_brief', brief={}, revision=2)

    def test_live_revocation_disabled_identity_and_checksum(self):
        item = self.publish()
        self.state['users']['bob']['groups'] = []
        with self.assertRaises(PermissionError): self.edit('bob', item)
        self.state['users']['bob']['groups'] = ['relation']; self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.edit('bob', item)
        with self.assertRaises(ValueError): self.call('alice', op='publish', target='/projects/relation/实体抽取/submissions/alice/bad', sha256='0' * 64)

    def test_path_escape_and_management_file_writes_rejected(self):
        for target in ['/projects/relation/实体抽取/../outside', '/projects/relation/实体抽取/.workbench-project.json', '/projects/ocr/a']:
            with self.assertRaises((PermissionError, ValueError)): self.call('alice', op='publish', target=target, sha256=content.digest(self.incoming))

    def test_categorized_contribution_is_bound_to_its_server_path(self):
        metadata = {'title': '覆盖率结论', 'description': '有证据的结论', 'kind': 'contribution', 'category': 'finding', 'fields': {'statement': '覆盖不足'}}
        with self.assertRaises(PermissionError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/issues/wrong.zip', sha256=content.digest(self.incoming), metadata=metadata)
        item = self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/right.zip', sha256=content.digest(self.incoming), metadata=metadata)
        self.assertEqual(item['category'], 'finding'); self.assertEqual(item['fields']['statement'], '覆盖不足')
        with self.assertRaises(ValueError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/bad.zip', sha256=content.digest(self.incoming), metadata={**metadata, 'fields': ['wrong']})
        with self.assertRaises(ValueError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/extra.zip', sha256=content.digest(self.incoming), metadata={**metadata, 'fields': {'problem': '属于 issue 的字段'}})

    def test_legacy_files_can_be_adopted_and_maintained_only_by_subadmin(self):
        file = self.directory / 'legacy.txt'; file.write_text('历史内容', encoding='utf-8')
        target = '/projects/relation/实体抽取/legacy.txt'
        with self.assertRaises(PermissionError): self.call('bob', op='adopt_content', target=target)
        item = self.call('alice', op='adopt_content', target=target)
        self.assertEqual(item['state'], 'curated'); self.assertEqual(item['description'], '历史内容')
        self.assertEqual(self.call('alice', op='adopt_content', target=target)['id'], item['id'])
        with self.assertRaises(ValueError): self.call('alice', op='adopt_content', target='/projects/relation/实体抽取/.workbench-project.json')
        with self.assertRaises(ValueError): self.call('alice', op='adopt_content', target='/projects/ocr')

@unittest.skipUnless(sys.platform == 'linux' and getattr(os, 'geteuid', lambda: 1)() == 0 and shutil.which('setfacl'), 'requires Linux root and acl tools; Windows does not verify kernel permissions')
class LinuxKernelPermissions(unittest.TestCase):
    def test_members_read_but_cannot_chmod_write_unlink_or_cross_groups(self):
        # No host accounts are created. Fork drops to unused numerical UID/GIDs.
        with tempfile.TemporaryDirectory(prefix='team-agent-acl-') as temp:
            root = pathlib.Path(temp); os.chmod(root, 0o755)
            one, two = root / 'one', root / 'two'
            gid, uid = 300000 + os.getpid(), 400000 + os.getpid()
            content.public_dir(one, gid); content.public_dir(two, gid + 1)
            content.publish_bytes(one / 'result', b'team result', gid)
            content.publish_bytes(two / 'result', b'other team', gid + 1)
            for both in [False, True]:
                pid = os.fork()
                if pid == 0:
                    try:
                        os.setgroups([gid, gid + 1] if both else [gid]); os.setgid(gid); os.setuid(uid)
                        assert (one / 'result').read_bytes() == b'team result'
                        for action in [lambda: (one / 'result').write_bytes(b'hack'), lambda: os.chmod(one / 'result', 0o666), lambda: (one / 'result').unlink()]:
                            try: action(); os._exit(2)
                            except PermissionError: pass
                        if both: assert (two / 'result').read_bytes() == b'other team'
                        else:
                            try: (two / 'result').read_bytes(); os._exit(3)
                            except PermissionError: pass
                        os._exit(0)
                    except BaseException: os._exit(4)
                _, status = os.waitpid(pid, 0); self.assertEqual(os.waitstatus_to_exitcode(status), 0)

if __name__ == '__main__': unittest.main()
