"""Project cleanup keeps the registration and, when asked, session trajectories."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('admin_program', pathlib.Path(__file__).parents[1] / 'server/admin.py')
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class ProjectPurgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.project_id = 'project_' + 'a' * 32
        self.other_id = 'project_' + 'b' * 32
        self.prefix = '/projects/算法/华为算法大赛'
        project = self.root / 'projects' / '算法' / '华为算法大赛'
        (project / 'submissions' / 'alice').mkdir(parents=True)
        (project / 'trajectories' / 'alice').mkdir(parents=True)
        (project / '.brief-versions').mkdir()
        (project / 'submissions' / 'alice' / 'a.md').write_text('result', encoding='utf-8')
        (project / 'trajectories' / 'alice' / 'run.zip').write_bytes(b'zip')
        (project / 'loose.bin').write_bytes(b'loose')
        (project / '项目说明.md').write_text('brief', encoding='utf-8')
        (project / '.brief-versions' / '1.md').write_text('v1', encoding='utf-8')
        (project / '.workbench-project.json').write_text(json.dumps({'id': self.project_id, 'name': '华为算法大赛'}), encoding='utf-8')
        (project / '.workbench-content.json').write_text(json.dumps([
            {'id': 'current-file', 'path': self.prefix + '/submissions/alice/a.md'},
            {'id': 'current-trajectory', 'path': self.prefix + '/trajectories/alice/run.zip'},
        ]), encoding='utf-8')
        (project / '.workbench-content-history.json').write_text(json.dumps([
            {'id': 'old-file', 'path': self.prefix + '/submissions/alice/old.md'},
            {'id': 'old-trajectory', 'path': self.prefix + '/trajectories/alice/old.zip'},
        ]), encoding='utf-8')
        other = self.root / 'projects' / '算法' / '另一个'
        other.mkdir()
        (other / '.workbench-project.json').write_text(json.dumps({'id': self.other_id, 'name': '另一个'}), encoding='utf-8')
        (other / 'keep.txt').write_text('stay', encoding='utf-8')
        receipts = self.root / '.workbench' / 'admin'
        receipts.mkdir(parents=True)
        (receipts / 'uploads.json').write_text(json.dumps({
            'submission': {'path': self.prefix + '/submissions/alice/a.md'},
            'trajectory': {'path': self.prefix + '/trajectories/alice/run.zip'},
            'other': {'path': '/projects/算法/另一个/keep.txt'},
        }), encoding='utf-8')
        self.state = {'groups': {'algo': {'label': '算法', 'workspace': '/projects/算法', 'provisioning': False}}}
        self.project = project

    def test_catalog_lists_registered_projects(self):
        catalog = admin.project_catalog(self.root, self.state)
        self.assertEqual([item['name'] for item in catalog['projects']], ['华为算法大赛', '另一个'])

    def test_keep_trajectories_removes_results_and_keeps_trajectory_records(self):
        result = admin.project_purge(self.root, self.state, {'projectId': self.project_id, 'mode': 'keep_trajectories'})
        self.assertEqual(result['removedFiles'], 2)
        self.assertFalse((self.project / 'submissions').exists())
        self.assertFalse((self.project / 'loose.bin').exists())
        self.assertEqual((self.project / 'trajectories' / 'alice' / 'run.zip').read_bytes(), b'zip')
        self.assertEqual((self.project / '项目说明.md').read_text(encoding='utf-8'), 'brief')
        self.assertEqual((self.project / '.brief-versions' / '1.md').read_text(encoding='utf-8'), 'v1')
        self.assertEqual(json.loads((self.project / '.workbench-project.json').read_text(encoding='utf-8'))['id'], self.project_id)
        self.assertEqual([item['id'] for item in json.loads((self.project / '.workbench-content.json').read_text(encoding='utf-8'))], ['current-trajectory'])
        self.assertEqual([item['id'] for item in json.loads((self.project / '.workbench-content-history.json').read_text(encoding='utf-8'))], ['old-trajectory'])
        receipts = json.loads((self.root / '.workbench' / 'admin' / 'uploads.json').read_text(encoding='utf-8'))
        self.assertEqual(set(receipts), {'trajectory', 'other'})
        self.assertEqual((self.root / 'projects' / '算法' / '另一个' / 'keep.txt').read_text(encoding='utf-8'), 'stay')

    def test_all_mode_also_removes_trajectories(self):
        result = admin.project_purge(self.root, self.state, {'projectId': self.project_id, 'mode': 'all'})
        self.assertEqual(result['removedFiles'], 3)
        self.assertFalse((self.project / 'trajectories').exists())
        self.assertFalse((self.project / 'submissions').exists())
        self.assertEqual(json.loads((self.project / '.workbench-content.json').read_text(encoding='utf-8')), [])
        self.assertEqual(json.loads((self.project / '.workbench-content-history.json').read_text(encoding='utf-8')), [])
        receipts = json.loads((self.root / '.workbench' / 'admin' / 'uploads.json').read_text(encoding='utf-8'))
        self.assertEqual(set(receipts), {'other'})
        self.assertTrue((self.project / '项目说明.md').is_file())

    def test_duplicate_identity_stops_before_deletion(self):
        twin = self.root / 'projects' / '算法' / '副本'
        twin.mkdir()
        (twin / '.workbench-project.json').write_text(json.dumps({'id': self.project_id, 'name': '副本'}), encoding='utf-8')
        (twin / 'marker.txt').write_text('kept', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '身份重复'):
            admin.project_purge(self.root, self.state, {'projectId': self.project_id, 'mode': 'all'})
        self.assertTrue((self.project / 'loose.bin').is_file())
        self.assertEqual((twin / 'marker.txt').read_text(encoding='utf-8'), 'kept')

    def test_symlink_is_removed_without_following_it(self):
        outside = self.root / 'outside.txt'
        outside.write_text('secret', encoding='utf-8')
        link = self.project / 'linked.txt'
        try:
            os.symlink(outside, link)
        except OSError:
            self.skipTest('当前系统不允许测试进程创建符号链接')
        admin.project_purge(self.root, self.state, {'projectId': self.project_id, 'mode': 'all'})
        self.assertEqual(outside.read_text(encoding='utf-8'), 'secret')
        self.assertFalse(link.exists())


if __name__ == '__main__':
    unittest.main()
