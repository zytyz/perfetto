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
"""Builds the Perfetto UI form of one or more agent skills.

The UI agent (dev.perfetto.Intelletto) has no shell and no file system: it
reads a skill through tools that fetch one file at a time. This script turns a
skill directory (the same tree that coding agents load) into an index (one
entry per skill: name, description, files) and the files that the UI can use:

  --layout assets (the UI build, see ui/build.mjs):
    <out>/index.json
    <out>/<skill>/<path>

  --layout extension-server --module <id> (an extension server, see
  docs/visualization/extension-server-protocol.md):
    <out>/modules/<id>/skills
    <out>/modules/<id>/skill_files/<skill>/<path>

Content for only one target is marked in the markdown, each mark alone on its
line. Unmarked content is for both targets.

  <!-- targets: cli -->     the trace_processor CLI only (sessions, Python,
  ...                       recording, two traces at once)
  <!-- /targets -->

  <!-- targets: ui -->      the Perfetto UI only
  ...
  <!-- /targets -->

The UI form drops the `cli` blocks and keeps the content of the `ui` blocks
without their marks. A file that opens a mark before any content (other
full-line HTML comments may come first) and never closes it belongs to that
target as a whole. Starting from SKILL.md, the script follows the references
that are left (markdown links and `$SKILL_ROOT/<path>` text) and copies only
the .md and .sql files they reach.
"""

import argparse
import json
import posixpath
import re
import shutil
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

SKILL_FILE = 'SKILL.md'
SKILL_TEMPLATE = 'SKILL-template.md'
UI_ENV_FILE = 'environment-references/ui.md'
INDEX_FILE = 'index.json'
ALLOWED_EXTS = ('.md', '.sql')
MAX_FILE_BYTES = 64 * 1024
MAX_DESCRIPTION = 1024
NAME_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')

TARGETS = ('cli', 'ui')
UI_TARGET = 'ui'

_MARK_LINE_RE = re.compile(r'[ \t]*<!--\s*'
                           r'(?:targets:\s*(?P<open>\S+?)|(?P<close>/targets))'
                           r'\s*-->[ \t]*')
_ANY_MARK_RE = re.compile(r'<!--\s*/?targets\b')
_COMMENT_LINE_RE = re.compile(r'<!--.*-->')
_LINK_RE = re.compile(r'\]\(([^)\s]+)\)')
_ROOT_REF_RE = re.compile(r'\$SKILL_ROOT/([A-Za-z0-9_./-]+)')


class SkillError(Exception):
  pass


def file_target(text: str) -> Optional[str]:
  """The target of a whole-file mark, or None for a file of both targets.

  A whole-file mark opens before any content and is never closed. Other
  full-line HTML comments (license or @generated banners) may come first.
  """
  lines = text.splitlines()
  if any(_mark(line) == ('close', '') for line in lines):
    return None
  for line in lines:
    if not line.strip():
      continue
    mark = _mark(line)
    if mark is not None:
      return mark[1]
    if not _COMMENT_LINE_RE.fullmatch(line.strip()):
      return None
  return None


def _mark(line: str) -> Optional[Tuple[str, str]]:
  """('open', target) or ('close', '') for a mark line, else None."""
  m = _MARK_LINE_RE.fullmatch(line)
  if m is None:
    return None
  return ('close', '') if m.group('close') else ('open', m.group('open'))


def filter_targets(text: str, target: str, where: str) -> str:
  """Returns the content of `text` for `target`.

  A block for another target is removed with its content. The mark lines of a
  block for `target` are removed and its content is kept. A removed line takes
  its indentation with it, so a block inside a list leaves the list unchanged.
  """
  whole = file_target(text)
  out: List[str] = []
  current: Optional[str] = None
  for n, line in enumerate(text.splitlines(keepends=True), 1):
    mark = _mark(line.rstrip('\r\n'))
    if mark is None:
      if _ANY_MARK_RE.search(line):
        raise SkillError(f'{where}:{n}: a targets mark must be alone on its '
                         'line, as <!-- targets: NAME --> or <!-- /targets -->')
      if current is None or current == target:
        out.append(line)
      continue
    kind, name = mark
    if kind == 'close':
      if current is None:
        raise SkillError(f'{where}:{n}: <!-- /targets --> with no open mark')
      current = None
      continue
    if name not in TARGETS:
      raise SkillError(f'{where}:{n}: unknown target "{name}", expected one of '
                       f'{", ".join(TARGETS)}')
    if current is not None:
      raise SkillError(f'{where}:{n}: nested targets mark')
    current = name
  if current is not None and whole is None:
    raise SkillError(f'{where}: unbalanced targets mark')
  return ''.join(out)


def split_frontmatter(text: str, where: str) -> Tuple[str, str]:
  if not text.startswith('---\n'):
    raise SkillError(f'{where}: missing YAML frontmatter')
  end = text.find('\n---\n', 4)
  if end < 0:
    raise SkillError(f'{where}: unterminated YAML frontmatter')
  return text[4:end + 1], text[end + 5:]


def parse_frontmatter(fm: str) -> Dict[str, str]:
  """Reads the top-level string keys of a frontmatter block.

  Supports plain, quoted and block scalars ('>', '>-', '|', '|-'). Nested maps
  (e.g. `metadata:`) are skipped. This is enough for `name` and `description`
  and avoids a YAML dependency in the UI build.
  """
  values: Dict[str, str] = {}
  lines = fm.splitlines()
  i = 0
  while i < len(lines):
    m = re.match(r'^([A-Za-z0-9_-]+):\s*(.*)$', lines[i])
    i += 1
    if not m:
      continue
    key, rest = m.group(1), m.group(2).strip()
    if rest in ('>', '>-', '|', '|-'):
      block = []
      while i < len(lines) and (lines[i].startswith(' ') or not lines[i]):
        block.append(lines[i].strip())
        i += 1
      sep = ' ' if rest.startswith('>') else '\n'
      values[key] = sep.join(l for l in block if l).strip()
    elif rest:
      if len(rest) >= 2 and rest[0] == rest[-1] and rest[0] in '"\'':
        rest = rest[1:-1]
      values[key] = rest
  return values


def _resolve(ref: str, from_dir: str, root_relative: bool) -> Optional[str]:
  """Returns the skill-relative path for a reference, or None if external."""
  # URLs, anchors and site-absolute paths are not files of the skill.
  if (re.match(r'^[a-z][a-z0-9+.-]*:', ref) or ref.startswith('#') or
      ref.startswith('/')):
    return None
  ref = ref.split('#', 1)[0]
  if not ref:
    return None
  if ref.startswith('$SKILL_ROOT/'):
    ref, root_relative = ref[len('$SKILL_ROOT/'):], True
  path = posixpath.normpath(
      ref if root_relative else posixpath.join(from_dir, ref))
  if path.startswith('../') or path == '..':
    raise SkillError(f'reference leaves the skill: {ref}')
  return path


def find_references(text: str, rel_path: str) -> List[Tuple[str, str]]:
  """Returns (kind, path) for each reference; kind is 'link' or 'text'."""
  from_dir = posixpath.dirname(rel_path)
  refs: List[Tuple[str, str]] = []
  for m in _LINK_RE.finditer(text):
    path = _resolve(m.group(1), from_dir, root_relative=False)
    if path is not None:
      refs.append(('link', path))
  without_links = _LINK_RE.sub('](...)', text)
  for m in _ROOT_REF_RE.finditer(without_links):
    path = _resolve(m.group(1).rstrip('.'), '', root_relative=True)
    if path is not None:
      refs.append(('text', path))
  return refs


def add_ui_env_pointer(body: str) -> str:
  """Points the UI agent at environment-references/ui.md under the title."""
  pointer = (f'Read [ui.md]($SKILL_ROOT/{UI_ENV_FILE}) first: it says how to '
             'use this skill in the Perfetto UI.\n')
  lines = body.splitlines(keepends=True)
  for i, line in enumerate(lines):
    if line.startswith('# '):
      return ''.join(lines[:i + 1] + ['\n', pointer] + lines[i + 1:])
  return pointer + '\n' + body


class Skill:
  """The UI form of one skill: its index entry and its rendered files."""

  def __init__(self, src: Path):
    self.src = src
    self.files: Dict[str, str] = {}
    self.warnings: List[str] = []
    template = src / SKILL_TEMPLATE
    skill_md = template if template.exists() else src / SKILL_FILE
    if not skill_md.exists():
      raise SkillError(f'{src}: no {SKILL_FILE} or {SKILL_TEMPLATE}')
    fm, body = split_frontmatter(skill_md.read_text(), str(skill_md))
    meta = parse_frontmatter(fm)
    self.name = meta.get('name', '')
    self.description = meta.get('description', '')
    if not NAME_RE.match(self.name) or len(self.name) > 64:
      raise SkillError(f'{skill_md}: invalid skill name "{self.name}"')
    if not self.description or len(self.description) > MAX_DESCRIPTION:
      raise SkillError(f'{skill_md}: description must be 1-1024 characters')
    body = filter_targets(body, UI_TARGET, str(skill_md))
    if (src / UI_ENV_FILE).exists():
      body = add_ui_env_pointer(body)
    self._collect(SKILL_FILE, f'---\n{fm}---\n{body}')

  def _read_source(self, rel: str) -> str:
    return (self.src / rel).read_text()

  def _collect(self, root_rel: str, root_text: str) -> None:
    queue: List[Tuple[str, str]] = [(root_rel, root_text)]
    seen: Set[str] = {root_rel}
    while queue:
      rel, text = queue.pop(0)
      self.files[rel] = text
      if not rel.endswith('.md'):
        continue
      for kind, path in find_references(text, rel):
        if path in seen:
          continue
        problem = self._check(path)
        if problem is not None:
          msg = f'{self.name}: {rel} references {path}: {problem}'
          if kind == 'link':
            raise SkillError(msg)
          self.warnings.append(msg)
          continue
        seen.add(path)
        src_text = self._read_source(path)
        if path.endswith('.md'):
          src_text = filter_targets(src_text, UI_TARGET, str(self.src / path))
        queue.append((path, src_text))

  def _check(self, path: str) -> Optional[str]:
    full = self.src / path
    if not full.is_file():
      return 'missing' if not full.exists() else 'not a file'
    if not path.endswith(ALLOWED_EXTS):
      return 'not a .md or .sql file'
    if path.endswith('.md'):
      target = file_target(full.read_text())
      if target not in (None, UI_TARGET):
        return f'{target}-only file'
    return None

  def index_entry(self, replaces: Optional[str] = None) -> dict:
    paths = sorted(self.files, key=lambda p: (p != SKILL_FILE, p))
    files = []
    for p in paths:
      size = len(self.files[p].encode('utf-8'))
      if size > MAX_FILE_BYTES:
        raise SkillError(f'{self.name}: {p} is {size} bytes, over the limit')
      files.append({'path': p, 'bytes': size})
    entry = {
        'name': self.name,
        'description': self.description,
        'files': files,
    }
    if replaces is not None:
      entry['replaces'] = replaces
    return entry


def write_skills(skills: List[Skill],
                 index_path: Path,
                 files_dir: Path,
                 replaces: Optional[Set[str]] = None):
  names = [s.name for s in skills]
  if len(set(names)) != len(names):
    raise SkillError(f'duplicate skill names: {names}')
  replaces = replaces or set()
  unknown = replaces - set(names)
  if unknown:
    raise SkillError(f'--replaces names no input skill: {sorted(unknown)}')
  entries = [
      s.index_entry(s.name if s.name in replaces else None) for s in skills
  ]
  for skill in skills:
    dst_root = files_dir / skill.name
    if dst_root.exists():
      shutil.rmtree(dst_root)
    for rel, text in skill.files.items():
      dst = dst_root / rel
      dst.parent.mkdir(parents=True, exist_ok=True)
      dst.write_text(text)
  index_path.parent.mkdir(parents=True, exist_ok=True)
  index_path.write_text(json.dumps({'skills': entries}, indent=2) + '\n')


def main(argv: Optional[List[str]] = None) -> int:
  parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
  parser.add_argument(
      '--skill',
      action='append',
      required=True,
      help='skill directory (repeatable)')
  parser.add_argument(
      '--layout',
      choices=['assets', 'extension-server'],
      default='assets',
      help='assets: files for the UI build; extension-server: files for '
      'modules/<id>/ of an extension server')
  parser.add_argument(
      '--module', help='extension-server layout: the module id to write')
  parser.add_argument(
      '--replaces',
      action='append',
      default=[],
      help='extension-server layout: mark the skill of this name as the '
      'replacement of the builtin skill of the same name (repeatable). The UI '
      'honours it only from its embedder-managed server.')
  parser.add_argument('--out', required=True, help='output directory')
  args = parser.parse_args(argv)

  try:
    skills = [Skill(Path(s)) for s in args.skill]
    out = Path(args.out)
    if args.layout == 'assets':
      if args.module or args.replaces:
        raise SkillError('--module and --replaces need --layout '
                         'extension-server')
      write_skills(skills, out / INDEX_FILE, out)
    else:
      if not args.module or not re.match(r'^[A-Za-z0-9_]+$', args.module):
        raise SkillError('--layout extension-server needs a valid --module')
      mod_dir = out / 'modules' / args.module
      write_skills(skills, mod_dir / 'skills', mod_dir / 'skill_files',
                   set(args.replaces))
  except SkillError as e:
    print(f'gen_ui_skills: error: {e}', file=sys.stderr)
    return 1
  for skill in skills:
    for w in skill.warnings:
      print(f'gen_ui_skills: warning: {w}', file=sys.stderr)
  return 0


if __name__ == '__main__':
  sys.exit(main())
