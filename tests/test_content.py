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
import uuid
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
        for mock in [patch.object(content.os, 'chown', create=True), patch.object(content.os, 'chmod'), patch.object(content.shutil, 'which', return_value='setfacl'), patch.object(content.subprocess, 'run')]:
            mock.start(); self.addCleanup(mock.stop)
        self.project = self.call('alice', op='create_project', name='实体抽取', groupName='relation', brief=BRIEF)['projectId']
        self.directory = self.root / 'projects/relation/实体抽取'
        self.incoming = self.root / 'incoming.bin'; self.incoming.write_bytes(b'original')

    def call(self, actor, **request):
        return content.handle(self.root, self.state, actor, {'projectId': getattr(self, 'project', None), **request}, getattr(self, 'incoming', None))

    def publish(self, actor='bob', name='result.zip', kind='contribution'):
        return self.call(actor, op='publish', target='/projects/relation/实体抽取/submissions/' + actor + '/' + name, sha256=content.digest(self.incoming), metadata={'title': '方案结论', 'description': '已验证内容', 'kind': kind})

    def test_private_account_data_is_isolated_versioned_and_not_public(self):
        self.assertEqual(self.call('bob', op='account_read')['records'], {})
        data = {'material:one': {'title': 'private'}, 'result-rules:preferences': {'combinations': [], 'projects': {self.project: 'development'}}}
        first = self.call('bob', op='account_write', revision=0, records=data, username='alice')
        self.assertEqual(first['revision'], 1)
        self.assertEqual(self.call('alice', op='account_read')['records'], {})
        self.assertTrue(self.call('bob', op='account_write', revision=0, records={})['conflict'])
        self.assertEqual(self.call('bob', op='account_read')['records'], data)
        with self.assertRaises(ValueError): self.call('bob', op='account_write', revision=1, records={'sessions:x': 'forbidden'})
        self.assertFalse(list(self.directory.glob('*account*')))
        self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.call('bob', op='account_read')

    def test_attachments_are_deduplicated_authorized_and_required_before_publication(self):
        sha = content.digest(self.incoming)
        blob = self.call('bob', op='publish_attachment', sha256=sha)
        self.assertEqual(blob, self.call('bob', op='publish_attachment', sha256=sha))
        attachment = dict(blob, name='result.csv')
        metadata = dict(kind='contribution', title='with evidence', description='summary', attachments=[attachment])
        target = '/projects/relation/实体抽取/submissions/bob/result.zip'
        item = self.call('bob', op='publish', target=target, sha256=sha, metadata=metadata)
        self.assertEqual(item['attachments'], [attachment])
        with self.assertRaises(PermissionError): self.call('alice', op='publish', target=target + '2', sha256=sha, metadata=metadata)
        with self.assertRaises(ValueError): self.call('bob', op='publish', target=target + '2', sha256=sha, metadata=dict(metadata, attachments=[dict(attachment, size=999)]))
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)
        self.assertEqual(self.edit('alice', item)['attachments'], [attachment])

    def test_account_files_are_private_and_downloads_are_independent(self):
        self.state['users']['bob']['uid'] = 1001
        sha = content.digest(self.incoming)
        self.call('bob', op='account_file_upload', sha256=sha)
        with self.assertRaises(ValueError): self.call('alice', op='account_file_download', sha256=sha)
        first = self.call('bob', op='account_file_download', sha256=sha)
        second = self.call('bob', op='account_file_download', sha256=sha)
        self.assertNotEqual(first['downloadId'], second['downloadId'])
        self.assertEqual(first['sha256'], sha)
        with self.assertRaises(ValueError): self.call('bob', op='account_file_upload', sha256='../escape')

    def test_assignment_roles_snapshots_status_and_retries(self):
        source = self.publish()
        task = dict(id=str(uuid.uuid4()), title='排查失败样本', description='分析低清晰度识别失败', acceptance='提供回归报告', assignee='bob', references=[dict(id=source['id'], revision=source['revision'])])
        self.assertEqual({item['username'] for item in self.call('alice', op='assignment_members')}, {'alice', 'bob'})
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_members')
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_create', task=task)
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'assignee': 'carol'})
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'references': [dict(id=source['id'], revision=99)]})
        saved = self.call('alice', op='assignment_create', task=task)
        self.assertEqual(self.call('alice', op='assignment_create', task=task), saved)
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task={**task, 'title': '不同任务'})
        self.assertEqual(len(self.call('bob', op='assignment_list')), 1)
        self.assertFalse((self.directory / '.workbench-assignments.json').exists(), 'task records must not be group-readable')
        self.edit('alice', source, action='delete')
        self.assertEqual(self.call('bob', op='assignment_list')[0]['references'][0]['content'], '已验证内容')
        own = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'assignee': 'alice', 'references': []})
        self.assertEqual(len(self.call('bob', op='assignment_list')), 1)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_status', change=dict(id=own['id'], revision=1, status='in_progress'))
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='cancelled'))
        active = self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='in_progress'))
        with self.assertRaises(ValueError): self.call('bob', op='assignment_status', change=dict(id=saved['id'], revision=1, status='completed'))
        review = self.call('bob', op='assignment_lifecycle', change=dict(id=saved['id'], revision=active['revision'], status='pending_review', submission=dict(summary='已验证任务结果')))
        done = self.call('alice', op='assignment_lifecycle', change=dict(id=saved['id'], revision=review['revision'], status='completed'))
        self.assertEqual(done['status'], 'completed')
        self.state['users']['alice']['contentAdminGroups'] = []
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4())})
        self.state['users']['bob']['groups'] = []
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_list')

    def test_assignment_review_delete_restore_and_reference_safe_purge(self):
        self.state['users']['bob']['uid'] = 1001
        self.state['users']['alice']['uid'] = 1000
        source = self.publish(kind='file', name='original.txt')
        spec = dict(id=str(uuid.uuid4()), title='评估是否继续', description='比较候选与基线', acceptance='提供依据', assignee='bob', references=[dict(id=source['id'], revision=1)])
        first = self.call('alice', op='assignment_create', task=spec)
        second = self.call('alice', op='assignment_create', task={**spec, 'id': str(uuid.uuid4())})
        blob = content.assignment_blob(self.root, self.project, 'bob', first['files'][0])
        def change(actor, task, status, **extra):
            return self.call(actor, op='assignment_lifecycle', change=dict(id=task['id'], revision=task['revision'], status=status, **extra))
        with self.assertRaises(ValueError): change('alice', first, 'deleted')
        with self.assertRaises(ValueError): change('alice', first, 'cancelled', reason='   ')
        task = change('bob', first, 'in_progress')
        with self.assertRaises(PermissionError): change('bob', task, 'completed')
        with self.assertRaises(ValueError): change('alice', task, 'completed')
        with self.assertRaises(ValueError): change('bob', task, 'pending_review', submission=dict(summary='   '))
        upload = dict(id=str(uuid.uuid4()), name='proof.txt', sha256=content.digest(self.incoming), size=self.incoming.stat().st_size)
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_file_upload', taskId=task['id'], file=upload)
        self.call('bob', op='assignment_file_upload', taskId=task['id'], file=upload)
        submission = dict(summary='候选不优于基线，不建议继续', references=[dict(id=source['id'], revision=1)], uploadIds=[upload['id']])
        with self.assertRaises(ValueError): change('bob', task, 'pending_review', submission={**submission, 'references': [dict(id=source['id'], revision=999)]})
        self.assertEqual(next(item for item in self.call('bob', op='assignment_list') if item['id'] == task['id'])['status'], 'in_progress')
        task = change('bob', task, 'pending_review', submission=submission)
        self.assertEqual(task['submissions'][0]['submittedBy'], 'bob')
        self.assertEqual(len(task['submissions'][0]['files']), 2)
        self.assertFalse(content.assignment_stage(self.root, self.project, 'bob', task['id'], upload['id']).exists())
        with self.assertRaises(PermissionError): change('bob', task, 'completed')
        with self.assertRaises(ValueError): change('alice', task, 'in_progress')
        with self.assertRaises(ValueError): change('alice', task, 'completed', submission=submission)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_upload', taskId=task['id'], file=upload)
        self.state['users']['carol']['groups'].append('relation')
        self.state['users']['carol']['contentAdminGroups'] = ['relation']
        task = change('carol', task, 'in_progress', reason='补充适用范围')
        self.assertEqual(task['history'][-1]['by'], 'carol')
        self.assertEqual(task['history'][-1]['action'], 'rejected')
        task = change('bob', task, 'pending_review', submission=dict(summary='当前样本内不优于基线，依据见上次附件'))
        self.assertEqual(len(task['submissions']), 2)
        with self.assertRaises(ValueError): change('alice', {**task, 'revision': 1}, 'completed')
        task = change('carol', task, 'completed', reason='按探索目标验收通过')
        self.assertEqual(task['history'][-1]['by'], 'carol')
        downloaded = self.call('bob', op='assignment_file_download', taskId=task['id'], fileId=task['submissions'][0]['files'][1]['id'])
        self.assertEqual(downloaded['sha256'], upload['sha256'])
        self.state['users']['carol']['contentAdminGroups'] = []
        with self.assertRaises(PermissionError): change('carol', task, 'deleted')
        with self.assertRaises(PermissionError): change('bob', task, 'deleted')
        task = change('alice', task, 'deleted')
        self.assertFalse(any(item['id'] == task['id'] for item in self.call('bob', op='assignment_list')))
        self.assertTrue(any(item['id'] == task['id'] and item.get('deletedAt') for item in self.call('alice', op='assignment_list')))
        self.assertEqual(blob.read_bytes(), b'original')
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_download', taskId=task['id'], fileId=first['files'][0]['id'])
        task = change('alice', task, 'restored')
        self.assertEqual(task['status'], 'completed'); self.assertEqual(len(task['submissions']), 2)
        task = change('alice', task, 'deleted')
        task = change('alice', task, 'purged')
        self.assertEqual(task['title'], ''); self.assertEqual(task['submissions'], [])
        self.assertFalse(any(item['id'] == task['id'] for item in self.call('alice', op='assignment_list')))
        with self.assertRaises(ValueError): self.call('alice', op='assignment_create', task=spec)
        with self.assertRaises(PermissionError): change('alice', task, 'restored')
        with self.assertRaises(PermissionError): self.call('alice', op='assignment_file_download', taskId=task['id'], fileId=first['files'][0]['id'])
        self.assertEqual(content.assignment_resolve(self.root, self.project, 'bob', second['id'], second['files'][0]), blob)
        self.assertEqual(blob.read_bytes(), b'original')
        second = change('alice', second, 'cancelled', reason='重复任务')
        second = change('alice', second, 'deleted')
        self.assertEqual(blob.read_bytes(), b'original', 'recoverable tasks retain their blobs')
        change('alice', second, 'purged')
        self.assertFalse(blob.exists())
        self.assertEqual(content.safe(self.root, source['path']).read_bytes(), b'original', 'shared source is never deleted with a task')
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)

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
        result = self.edit('alice', updated, merge=[{'id': two['id'], 'revision': two['revision']}], sourceSessionTitle='统一口径复核')
        self.assertEqual(result['sources'], [two['id']])
        self.assertEqual({source['id'] for source in result['provenance']}, {updated['id'], two['id']})
        self.assertEqual(result['sourceSessionTitle'], '统一口径复核')
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
        metadata = {'title': '覆盖率结论', 'description': '有证据的结论', 'kind': 'contribution', 'category': 'finding', 'fields': {'statement': '覆盖不足'}, 'sourceSessionTitle': '覆盖率验证'}
        with self.assertRaises(PermissionError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/issues/wrong.zip', sha256=content.digest(self.incoming), metadata=metadata)
        item = self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/findings/right.zip', sha256=content.digest(self.incoming), metadata=metadata)
        self.assertEqual(item['category'], 'finding'); self.assertEqual(item['fields']['statement'], '覆盖不足'); self.assertEqual(item['sourceSessionTitle'], '覆盖率验证')
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

    def test_new_categories_publish_with_matching_paths_and_keep_category_in_assignment_snapshots(self):
        for category in ['requirement', 'design', 'verification', 'troubleshooting', 'guide', 'research', 'comparison']:
            folder = content.CONTRIBUTION_FOLDERS[category]
            field = next(iter(content.CONTRIBUTION_FIELDS[category]))
            metadata = dict(kind='contribution', category=category, title='简短成果', description='有依据的内容。', fields={field: '有依据的内容。'})
            item = self.call('bob', op='publish', target=f'/projects/relation/实体抽取/submissions/bob/{folder}/{category}.md', sha256=content.digest(self.incoming), metadata=metadata)
            self.assertEqual(item['category'], category)
            task = self.call('alice', op='assignment_create', task=dict(id=str(uuid.uuid4()), title='自派任务', description='验证该成果', assignee='alice', references=[dict(id=item['id'], revision=1)]))
            self.assertEqual(task['references'][0]['category'], category)
            started = self.call('alice', op='assignment_status', change=dict(id=task['id'], revision=1, status='in_progress'))
            self.assertEqual(started['status'], 'in_progress')
            self.assertEqual(self.call('alice', op='assignment_status', change=dict(id=task['id'], revision=2, status='completed', submission=dict(summary='自派任务已验证')))['status'], 'completed')
            with self.assertRaises(ValueError): self.edit('alice', item, category='invented')
            self.assertEqual(next(row for row in content.read_json(self.directory / '.workbench-content.json') if row['id'] == item['id'])['revision'], 1)
            edited = self.edit('alice', item, category='verification', sourceDetails='验证来源。')
            self.assertEqual(edited['category'], 'verification'); self.assertEqual(edited['fields'], {}); self.assertEqual(edited['sourceDetails'], '验证来源。')

    def test_task_files_snapshot_shared_attachments_and_deduplicate_only_equal_permissions(self):
        self.state['users']['bob']['uid'] = 1001
        self.state['users']['carol']['groups'].append('relation'); self.state['users']['carol']['uid'] = 1002
        sha = content.digest(self.incoming)
        shared = self.call('bob', op='publish_attachment', sha256=sha)
        linked = self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/result.md', sha256=sha, metadata=dict(kind='contribution', title='关联成果', description='验证内容', attachments=[dict(shared, name='data.csv')]))
        request_id, upload_id = str(uuid.uuid4()), str(uuid.uuid4())
        upload = dict(id=upload_id, name='data.csv', sha256=sha, size=self.incoming.stat().st_size)
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_upload', taskId=request_id, file=upload)
        staged = self.call('alice', op='assignment_file_upload', taskId=request_id, file=upload)
        self.assertEqual(staged['md5'], content.hashlib.md5(b'original', usedforsecurity=False).hexdigest())
        task = dict(id=request_id, title='附件任务', description='审阅文件', assignee='bob', references=[dict(id=linked['id'], revision=1)], uploadIds=[upload_id])
        first = self.call('alice', op='assignment_create', task=task)
        self.assertEqual(len(first['files']), 1)
        self.assertFalse(content.assignment_stage(self.root, self.project, 'alice', request_id, upload_id).exists())
        self.assertEqual(self.call('alice', op='assignment_create', task=task)['id'], request_id)
        same = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'uploadIds': []})
        other = self.call('alice', op='assignment_create', task={**task, 'id': str(uuid.uuid4()), 'assignee': 'carol', 'uploadIds': []})
        get_blob = lambda item: content.assignment_resolve(self.root, self.project, item['assignee'], item['id'], item['files'][0])
        self.assertEqual(get_blob(first), get_blob(same)); self.assertNotEqual(get_blob(first), get_blob(other))
        self.assertNotEqual(first['files'][0]['path'], same['files'][0]['path'])
        if os.name != 'nt': self.assertTrue((self.root / first['files'][0]['path'].lstrip('/')).is_symlink())
        with self.assertRaises(PermissionError): self.call('carol', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.edit('alice', linked, action='delete')
        self.incoming.write_bytes(b'new local version')
        downloaded = self.call('bob', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.assertEqual(downloaded['sha256'], sha)
        outgoing = self.root / '.workbench/outbox/bob' / (sha + '-' + downloaded['downloadId'] + '.file')
        self.assertEqual(outgoing.read_bytes(), b'original')
        tampered = dict(first['files'][0], path=other['files'][0]['path'])
        with self.assertRaises(ValueError): content.assignment_resolve(self.root, self.project, 'bob', request_id, tampered)
        get_blob(first).write_bytes(b'corrupt')
        with self.assertRaises(ValueError): self.call('bob', op='assignment_file_download', taskId=request_id, fileId=first['files'][0]['id'])
        self.state['users']['bob']['enabled'] = False
        with self.assertRaises(PermissionError): self.call('bob', op='assignment_file_download', taskId=same['id'], fileId=same['files'][0]['id'])

    def test_task_dedup_does_not_use_md5_alone_and_rejects_forged_file_selection(self):
        sha = content.digest(self.incoming)
        original_hashes = content.assignment_hashes
        # Simulate an MD5 collision: different SHA-256 values must produce distinct blobs.
        with patch.object(content, 'assignment_hashes', side_effect=lambda file: dict(original_hashes(file), md5='a' * 32)):
            first = content.assignment_store(self.root, self.project, 'bob', str(uuid.uuid4()), self.incoming, 'file.txt', sha, self.incoming.stat().st_size, 'test')
            self.incoming.write_bytes(b'different content')
            second = content.assignment_store(self.root, self.project, 'bob', str(uuid.uuid4()), self.incoming, 'file.txt', content.digest(self.incoming), self.incoming.stat().st_size, 'test')
            self.assertNotEqual(content.assignment_blob(self.root, self.project, 'bob', first), content.assignment_blob(self.root, self.project, 'bob', second))
        task = dict(id=str(uuid.uuid4()), title='非法附件', description='测试', assignee='bob', references=[], uploadIds=[str(uuid.uuid4())])
        with self.assertRaises(FileNotFoundError): self.call('alice', op='assignment_create', task=task)
        self.assertEqual(self.call('alice', op='assignment_list'), [])
        with self.assertRaises(ValueError): self.call('alice', op='assignment_file_upload', taskId=task['id'], file=dict(id=str(uuid.uuid4()), name='../file', sha256=sha, size=8))
        source = self.publish(name='shared-file.csv', kind='file')
        linked = self.call('alice', op='assignment_create', task=dict(id=str(uuid.uuid4()), title='关联独立文件', description='读取共享文件', assignee='bob', references=[dict(id=source['id'], revision=1)]))
        self.assertEqual(linked['references'][0]['kind'], 'file'); self.assertEqual(len(linked['files']), 1)
        self.assertEqual(linked['files'][0]['name'], 'shared-file.csv')

@unittest.skipUnless(sys.platform == 'linux' and getattr(os, 'geteuid', lambda: 1)() == 0 and content.acl_backend(), 'requires Linux root and ACL support; Windows does not verify kernel permissions')
class LinuxKernelPermissions(unittest.TestCase):
    def test_libacl_keeps_public_files_read_only_and_groups_isolated(self):
        with patch.object(content.shutil, 'which', return_value=None):
            self.test_members_read_but_cannot_chmod_write_unlink_or_cross_groups()

    def test_libacl_private_inbox_and_read_only_receipt(self):
        with tempfile.TemporaryDirectory(prefix='team-agent-libacl-') as temp, patch.object(content.shutil, 'which', return_value=None):
            root = pathlib.Path(temp); os.chmod(root, 0o755)
            uid = 400000 + os.getpid(); other = uid + 1
            inbox = root / 'inbox'; outbox = root / 'outbox'
            inbox.mkdir(mode=0o700); outbox.mkdir(mode=0o700)
            content.acl_apply(['-m', 'u:' + str(uid) + ':rwx', str(inbox)])
            content.acl_apply(['-m', 'u:' + str(uid) + ':r-x', str(outbox)])
            receipt = outbox / 'receipt'; receipt.write_text('ok'); os.chmod(receipt, 0o600)
            content.acl_apply(['-m', 'u:' + str(uid) + ':r--', str(receipt)])
            for actor in (uid, other):
                pid = os.fork()
                if pid == 0:
                    try:
                        os.setgroups([]); os.setgid(actor); os.setuid(actor)
                        if actor == uid:
                            (inbox / 'request').write_text('request')
                            assert receipt.read_text() == 'ok'
                            denied = [lambda: receipt.write_text('fake'), lambda: receipt.unlink(), lambda: os.chmod(inbox, 0o777)]
                        else:
                            denied = [lambda: (inbox / 'request').read_text(), lambda: receipt.read_text()]
                        for action in denied:
                            try: action(); os._exit(2)
                            except PermissionError: pass
                        os._exit(0)
                    except BaseException: os._exit(3)
                _, status = os.waitpid(pid, 0); self.assertEqual(os.waitstatus_to_exitcode(status), 0)

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
