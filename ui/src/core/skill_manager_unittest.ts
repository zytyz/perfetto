// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  normalizeSkillPath,
  SkillManagerImpl,
  stripFrontmatter,
  type SkillIndex,
  type SkillSource,
} from './skill_manager';

function makeSource(
  id: string,
  index: SkillIndex,
  files: Record<string, string>,
): SkillSource & {fetches: string[]} {
  const fetches: string[] = [];
  return {
    id,
    fetches,
    loadIndex: async () => index,
    fetchFile: async (skill, path) => {
      fetches.push(`${skill}/${path}`);
      const text = files[`${skill}/${path}`];
      if (text === undefined) throw new Error('404');
      return text;
    },
  };
}

const PERFETTO: SkillIndex = {
  skills: [
    {
      name: 'perfetto',
      description: 'Analyze Perfetto traces.',
      files: [
        {path: 'SKILL.md', bytes: 40},
        {path: 'workflows/gpu/gpu_info.md', bytes: 10},
        {path: 'workflows/gpu/scripts/gpu_info.sql', bytes: 9},
      ],
    },
  ],
};

const PERFETTO_FILES = {
  'perfetto/SKILL.md': '---\nname: perfetto\n---\n\n# Perfetto\n',
  'perfetto/workflows/gpu/gpu_info.md': '# GPU info\n',
  'perfetto/workflows/gpu/scripts/gpu_info.sql': 'SELECT 1;\n',
};

describe('normalizeSkillPath', () => {
  test('accepts skill-relative paths and strips prefixes', () => {
    expect(normalizeSkillPath('$SKILL_ROOT/workflows/x.md')).toBe(
      'workflows/x.md',
    );
    expect(normalizeSkillPath('./a/b.sql')).toBe('a/b.sql');
    expect(normalizeSkillPath('SKILL.md')).toBe('SKILL.md');
  });

  test('rejects paths that leave the skill or are not .md/.sql', () => {
    expect(normalizeSkillPath('../x.md')).toBeUndefined();
    expect(normalizeSkillPath('a/../../x.md')).toBeUndefined();
    expect(normalizeSkillPath('/etc/x.md')).toBeUndefined();
    expect(normalizeSkillPath('a//b.md')).toBeUndefined();
    expect(normalizeSkillPath('scripts/x.py')).toBeUndefined();
    expect(normalizeSkillPath('')).toBeUndefined();
  });
});

describe('stripFrontmatter', () => {
  test('removes the YAML block', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\n# X\n')).toBe('# X\n');
    expect(stripFrontmatter('# No frontmatter\n')).toBe('# No frontmatter\n');
  });
});

describe('SkillManagerImpl', () => {
  test('lists skills sorted by name with their source', async () => {
    const mgr = new SkillManagerImpl();
    mgr.addSource(
      makeSource(
        'builtin',
        {
          skills: [{...PERFETTO.skills[0]!, name: 'zeta'}, ...PERFETTO.skills],
        },
        PERFETTO_FILES,
      ),
    );
    const list = await mgr.list();
    expect(list.map((s) => s.name)).toEqual(['perfetto', 'zeta']);
    expect(list[0]!.source).toBe('builtin');
  });

  test('reads files lazily, strips SKILL.md frontmatter and caches', async () => {
    const mgr = new SkillManagerImpl();
    const src = makeSource('builtin', PERFETTO, PERFETTO_FILES);
    mgr.addSource(src);
    await mgr.list();
    expect(src.fetches).toEqual([]);

    expect(await mgr.readFile('perfetto', 'SKILL.md')).toBe('# Perfetto\n');
    expect(
      await mgr.readFile('perfetto', '$SKILL_ROOT/workflows/gpu/gpu_info.md'),
    ).toBe('# GPU info\n');
    await mgr.readFile('perfetto', 'workflows/gpu/gpu_info.md');
    expect(src.fetches).toEqual([
      'perfetto/SKILL.md',
      'perfetto/workflows/gpu/gpu_info.md',
    ]);
  });

  test('rejects unknown skills and files not in the index', async () => {
    const mgr = new SkillManagerImpl();
    mgr.addSource(makeSource('builtin', PERFETTO, PERFETTO_FILES));
    await expect(mgr.readFile('nope', 'SKILL.md')).rejects.toThrow(
      'Unknown skill',
    );
    await expect(
      mgr.readFile('perfetto', 'workflows/other.md'),
    ).rejects.toThrow('not a file of skill');
    await expect(mgr.readFile('perfetto', '../x.md')).rejects.toThrow(
      'not a file of skill',
    );
  });

  test('drops invalid entries and survives a failing source', async () => {
    const mgr = new SkillManagerImpl();
    mgr.addSource({
      id: 'broken',
      loadIndex: async () => {
        throw new Error('offline');
      },
      fetchFile: async () => '',
    });
    mgr.addSource(
      makeSource(
        'builtin',
        {
          skills: [
            ...PERFETTO.skills,
            {name: 'Bad Name', description: 'x', files: []},
            {name: 'no-skill-md', description: 'x', files: []},
            {
              name: 'escapes',
              description: 'x',
              files: [
                {path: 'SKILL.md', bytes: 1},
                {path: '../x.md', bytes: 1},
              ],
            },
          ],
        },
        PERFETTO_FILES,
      ),
    );
    expect((await mgr.list()).map((s) => s.name)).toEqual(['perfetto']);
  });

  test('keeps the first source for a duplicate name', async () => {
    const mgr = new SkillManagerImpl();
    mgr.addSource(makeSource('first', PERFETTO, PERFETTO_FILES));
    mgr.addSource(makeSource('second', PERFETTO, PERFETTO_FILES));
    const list = await mgr.list();
    expect(list.length).toBe(1);
    expect(list[0]!.source).toBe('first');
  });
});
