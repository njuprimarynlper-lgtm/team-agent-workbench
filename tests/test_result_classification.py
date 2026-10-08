import copy
import json
import unittest
import uuid
from test_content import ContentRules, content


class ResultClassification(unittest.TestCase):
    setUp = ContentRules.setUp
    call = ContentRules.call

    def publish(self, category, name):
        return self.call('bob', op='publish', target=f'/projects/relation/实体抽取/submissions/bob/{content.CONTRIBUTION_FOLDERS[category]}/{name}.zip', sha256=content.digest(self.incoming), metadata=dict(title=name, description=name + '正文', kind='contribution', category=category))

    def test_reclassification_keeps_identity_content_and_historical_category(self):
        item = self.publish('exploration', '探索')
        updated = self.call('bob', op='edit_content', change=dict(id=item['id'], revision=1, action='save', title=item['title'], description=item['description'], category='todo'))
        self.assertEqual(updated['id'], item['id'])
        self.assertEqual(updated['description'], item['description'])
        self.assertEqual(updated['resultStatus'], 'pending')
        self.assertIn('/todos/', updated['path'])
        history = self.call('bob', op='content_history', id=item['id'])
        self.assertEqual(history[0]['category'], 'exploration')
        completed = self.call('bob', op='edit_content', change=dict(id=item['id'], revision=2, action='save', title=item['title'], description=item['description'], resultStatus='completed'))
        self.assertEqual(completed['resultStatus'], 'completed')
        current = content.read_json(self.directory / '.workbench-content.json')
        self.assertEqual(len(current), 1)
        with self.assertRaises(ValueError):
            self.call('bob', op='edit_content', change=dict(id=item['id'], revision=2, action='save', title='过时修改', description='正文', resultStatus='pending'))

    def test_worker_refuses_cross_category_merge_and_stale_sources_before_any_write(self):
        a, b = self.publish('capability', '能力'), self.publish('exploration', '探索')
        change = dict(requestId=str(uuid.uuid4()), sources=[dict(id=item['id'], revision=1) for item in (a, b)], title='合并', description='合并正文', replaceIds=[a['id'], b['id']])
        with self.assertRaisesRegex(ValueError, '同一分类'):
            self.call('alice', op='merge_content', change=change)
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 2)
        self.assertEqual(self.call('alice', op='content_history'), [])
        self.call('alice', op='edit_content', change=dict(id=b['id'], revision=1, action='save', title=b['title'], description=b['description'], category='capability'))
        with self.assertRaises(ValueError):
            self.call('alice', op='merge_content', change=change)
        change['sources'][1]['revision'] = 2
        change['category'] = 'todo'
        with self.assertRaisesRegex(ValueError, '来源分类'):
            self.call('alice', op='merge_content', change=change)
        change['category'] = 'capability'
        merged = self.call('alice', op='merge_content', change=change)
        self.assertIn('/capabilities/', merged['path'])
        self.assertEqual(len(merged['derivedFrom']), 2)
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 1)
        with self.assertRaises(PermissionError):
            self.call('bob', op='edit_content', change=dict(id=merged['id'], revision=1, action='save', title='越权', description='正文'))

    def test_linked_assignment_cannot_be_completed_or_reclassified_through_content_api(self):
        item = self.publish('todo', '补充验证')
        file = self.root / '.workbench/admin/assignments' / (self.project + '.json')
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps([dict(id=str(uuid.uuid4()), references=[dict(id=item['id'])], status='pending_review')]), encoding='utf-8')
        base = dict(id=item['id'], revision=1, action='save', title=item['title'], description=item['description'])
        for change in [dict(base, resultStatus='completed'), dict(base, category='exploration')]:
            with self.assertRaisesRegex(ValueError, '项目任务'):
                self.call('alice', op='edit_content', change=change)
        self.assertEqual(content.read_json(self.directory / '.workbench-content.json')[0]['revision'], 1)

    def test_status_is_validated_even_when_bypassing_client(self):
        item = self.publish('capability', '能力')
        with self.assertRaises(ValueError):
            self.call('alice', op='edit_content', change=dict(id=item['id'], revision=1, action='save', title=item['title'], description=item['description'], resultStatus='completed'))
        with self.assertRaises(ValueError):
            self.call('bob', op='publish', target='/projects/relation/实体抽取/submissions/bob/todos/invalid.zip', sha256=content.digest(self.incoming), metadata=dict(title='invalid', kind='contribution', category='todo', resultStatus='confirmed'))


    def test_todo_merge_requires_explicit_duplicate_confirmation(self):
        a, b = self.publish('todo', '重复一'), self.publish('todo', '重复二')
        change = dict(sources=[dict(id=item['id'], revision=1) for item in (a, b)], title='统一待办', description='同一动作', replaceIds=[a['id'], b['id']])
        with self.assertRaisesRegex(ValueError, '独立事项'):
            self.call('alice', op='merge_content', change=change)
        self.assertEqual(len(content.read_json(self.directory / '.workbench-content.json')), 2)
        merged = self.call('alice', op='merge_content', change=dict(change, confirmDuplicateTodos=True))
        self.assertEqual(merged['resultStatus'], 'pending')
        self.assertEqual(len(merged['replaces']), 2)

    def test_task_links_reveal_private_details_only_to_owner_and_admin(self):
        item = self.publish('todo', '公共事项')
        file = self.root / '.workbench/admin/assignments' / (self.project + '.json')
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps([dict(id=str(uuid.uuid4()), references=[dict(id=item['id'])], title='私有任务标题', assignee='alice', status='pending_review')]), encoding='utf-8')
        visible = self.call('alice', op='content_task_links')[item['id']][0]
        self.assertEqual(visible['status'], 'pending_review')
        redacted = self.call('bob', op='content_task_links')[item['id']][0]
        self.assertEqual(redacted['title'], '关联任务')
        self.assertEqual(redacted['assignee'], '')
        self.assertEqual(redacted['status'], 'linked')


del ContentRules  # Avoid discovering the imported fixture's test cases twice.

if __name__ == '__main__':
    unittest.main()
