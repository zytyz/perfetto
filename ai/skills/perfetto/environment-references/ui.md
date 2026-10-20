<!-- targets: ui -->
# Using this skill in the Perfetto UI

You run inside the Perfetto UI, not in a shell. The trace the user has open is
already loaded into trace_processor, so there is nothing to install, start or
load, and only that one trace is available.

- Run PerfettoSQL with the `run_query` tool. State (`INCLUDE PERFETTO MODULE`,
  `CREATE PERFETTO TABLE`) persists between calls, like a warm session.
- When a file says to run
  `trace_processor query --remote SESSION --query-file $SKILL_ROOT/<path>`,
  call `run_skill_sql` with that `<path>` instead. For an inline query, call
  `run_query`.
- Read another file of this skill with `read_skill_file`. Paths may keep the
  `$SKILL_ROOT/` prefix.
- Results are capped at 100 rows: aggregate rather than pulling raw rows.
- Answer in the chat. There is no working directory to write reports to.
