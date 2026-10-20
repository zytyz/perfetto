#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tests for tools/gen_ui_skills.py. Run: python3 tools/gen_ui_skills_unittest.py"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_ui_skills  # pylint: disable=wrong-import-position

ROOT = Path(__file__).resolve().parent.parent

SKILL_MD = """---
name: demo
description: >-
  A demo skill
  for tests.
---

# Demo

<!-- targets: cli -->
## Setup
Read [setup.md]($SKILL_ROOT/environment-references/setup.md).
<!-- /targets -->

## Workflows
- Both: [both.md]($SKILL_ROOT/workflows/both.md)
   <!-- targets: cli -->
   - Two traces: [diff.md]($SKILL_ROOT/workflows/diff.md)
   <!-- /targets -->
   <!-- targets: ui -->
   - Show a result: select it on the timeline.
   <!-- /targets -->
- Docs: [proto](/protos/x.proto), [site](https://perfetto.dev)
"""


class GenUiSkillsTest(unittest.TestCase):

  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.src = Path(self.tmp.name) / 'demo'
    self.out = Path(self.tmp.name) / 'out'
    self._write('SKILL-template.md', SKILL_MD)
    self._write('environment-references/setup.md', '# CLI setup\n')
    self._write('environment-references/ui.md', '<!-- targets: ui -->\n# UI\n')
    self._write(
        'workflows/both.md', '# Both\n'
        'trace_processor query --remote S --query-file '
        '$SKILL_ROOT/workflows/scripts/both.sql\n'
        'Python: $SKILL_ROOT/workflows/scripts/tool.py\n')
    self._write('workflows/scripts/both.sql', 'SELECT 1;\n')
    self._write('workflows/scripts/tool.py', 'print(1)\n')
    self._write('workflows/diff.md', '<!-- targets: cli -->\n# Diff\n')

  def tearDown(self):
    self.tmp.cleanup()

  def _write(self, rel, text):
    path = self.src / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)

  def _run(self):
    self.assertEqual(
        gen_ui_skills.main(['--skill',
                            str(self.src), '--out',
                            str(self.out)]), 0)
    return json.loads((self.out / 'index.json').read_text())

  def test_index_and_reachability(self):
    index = self._run()
    (entry,) = index['skills']
    self.assertEqual(entry['name'], 'demo')
    self.assertEqual(entry['description'], 'A demo skill for tests.')
    paths = [f['path'] for f in entry['files']]
    self.assertEqual(paths, [
        'SKILL.md',
        'environment-references/ui.md',
        'workflows/both.md',
        'workflows/scripts/both.sql',
    ])
    for f in entry['files']:
      self.assertEqual(f['bytes'],
                       (self.out / 'demo' / f['path']).stat().st_size)

  def test_cli_blocks_removed_and_ui_pointer_added(self):
    self._run()
    skill = (self.out / 'demo' / 'SKILL.md').read_text()
    self.assertNotIn('targets', skill)
    self.assertNotIn('setup.md', skill)
    self.assertNotIn('diff.md', skill)
    self.assertIn('environment-references/ui.md', skill)
    # The indented blocks go away without changing the list indentation.
    self.assertIn('- Both: [both.md]', skill)
    self.assertIn('\n   - Show a result: select it on the timeline.\n- Docs:',
                  skill)
    self.assertTrue(skill.startswith('---\nname: demo\n'))

  def test_whole_file_ui_mark_removed(self):
    self._run()
    self.assertEqual(
        (self.out / 'demo' / 'environment-references/ui.md').read_text(),
        '# UI\n')

  def test_filter_for_each_target(self):
    text = ('a\n<!-- targets: cli -->\nc\n<!-- /targets -->\n'
            '<!-- targets: ui -->\nu\n<!-- /targets -->\nb\n')
    self.assertEqual(gen_ui_skills.filter_targets(text, 'ui', 'x'), 'a\nu\nb\n')
    self.assertEqual(
        gen_ui_skills.filter_targets(text, 'cli', 'x'), 'a\nc\nb\n')

  def test_kept_link_to_cli_only_file_fails(self):
    self._write('workflows/both.md', '# Both\nSee [diff.md](diff.md).\n')
    self.assertEqual(
        gen_ui_skills.main(['--skill',
                            str(self.src), '--out',
                            str(self.out)]), 1)

  def test_whole_file_mark_after_a_banner(self):
    self.assertEqual(
        gen_ui_skills.file_target(
            '<!-- @generated -->\n<!-- targets: cli -->\n# Diff\n'), 'cli')
    self.assertEqual(
        gen_ui_skills.file_target('<!-- targets: ui -->\n# UI\n'), 'ui')
    self.assertIsNone(
        gen_ui_skills.file_target('# Title\n<!-- targets: cli -->\n'))
    self.assertIsNone(
        gen_ui_skills.file_target(
            '<!-- targets: cli -->\nx\n<!-- /targets -->\n'))

  def test_kept_link_to_missing_file_fails(self):
    self._write('workflows/both.md', '# Both\nSee [x.md](x.md).\n')
    self.assertEqual(
        gen_ui_skills.main(['--skill',
                            str(self.src), '--out',
                            str(self.out)]), 1)

  def test_bad_marks_fail(self):
    for text in [
        '# Both\n<!-- /targets -->\n',
        '# Both\n<!-- targets: cli -->\nx\n',
        '# Both\n<!-- targets: web -->\nx\n<!-- /targets -->\n',
        '# Both\n<!-- targets: cli -->\n<!-- targets: ui -->\n'
        '<!-- /targets -->\n',
        '# Both\ntext <!-- targets: ui --> more\n',
        '# Both\n<!-- targets: cli, ui -->\nx\n<!-- /targets -->\n',
    ]:
      with self.subTest(text=text):
        self._write('workflows/both.md', text)
        self.assertEqual(
            gen_ui_skills.main(
                ['--skill', str(self.src), '--out',
                 str(self.out)]), 1)

  def test_link_out_of_skill_fails(self):
    self._write('workflows/both.md', '# Both\n[x](../../outside.md)\n')
    self.assertEqual(
        gen_ui_skills.main(['--skill',
                            str(self.src), '--out',
                            str(self.out)]), 1)

  def test_extension_server_layout(self):
    self.assertEqual(
        gen_ui_skills.main([
            '--skill',
            str(self.src), '--layout', 'extension-server', '--module',
            'default', '--replaces', 'demo', '--out',
            str(self.out)
        ]), 0)
    mod = self.out / 'modules' / 'default'
    (entry,) = json.loads((mod / 'skills').read_text())['skills']
    self.assertEqual(entry['replaces'], 'demo')
    self.assertTrue((mod / 'skill_files/demo/SKILL.md').is_file())
    self.assertTrue((mod / 'skill_files/demo/workflows/both.md').is_file())

  def test_extension_server_layout_checks_flags(self):
    for extra in (['--module', 'bad/id'], ['--module', 'm', '--replaces',
                                           'x'], []):
      self.assertEqual(
          gen_ui_skills.main(
              ['--skill',
               str(self.src), '--layout', 'extension-server'] + extra +
              ['--out', str(self.out)]), 1)
    self.assertEqual(
        gen_ui_skills.main(
            ['--skill',
             str(self.src), '--module', 'm', '--out',
             str(self.out)]), 1)

  def test_upstream_perfetto_skill_builds(self):
    self.assertEqual(
        gen_ui_skills.main([
            '--skill',
            str(ROOT / 'ai/skills/perfetto'), '--out',
            str(self.out)
        ]), 0)
    index = json.loads((self.out / 'index.json').read_text())
    (entry,) = index['skills']
    paths = {f['path'] for f in entry['files']}
    self.assertIn('workflows/gpu/gpu_info.md', paths)
    self.assertIn('workflows/gpu/scripts/gpu_info.sql', paths)
    self.assertNotIn('environment-references/setup.md', paths)
    self.assertFalse(any(p.endswith('.py') for p in paths))
    for p in paths:
      self.assertNotIn('targets', (self.out / 'perfetto' / p).read_text(), p)


if __name__ == '__main__':
  unittest.main()
