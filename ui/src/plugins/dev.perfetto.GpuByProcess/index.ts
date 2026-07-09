// Copyright (C) 2023 The Android Open Source Project
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
  LONG,
  NUM,
  NUM_NULL,
  STR,
  STR_NULL,
} from '../../trace_processor/query_result';
import type {Trace} from '../../public/trace';
import type {PerfettoPlugin} from '../../public/plugin';
import {TrackNode} from '../../public/workspace';
import {SliceTrack} from '../../components/tracks/slice_track';
import {SourceDataset} from '../../trace_processor/dataset';
import {ThreadSliceDetailsPanel} from '../../components/details/thread_slice_details_tab';
import {Gpu} from '../../components/gpu';
import {getMachineCount} from '../../public/utils';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';

// Name of the precomputed per-lane slice layout-depth table (see
// createLayoutDepthTable). Referenced by every leaf dataset (layoutDataset).
const LAYOUT_TABLE = '__gpu_by_process_slice_layout';

function getProcessDisplayName(
  name: string | null,
  pid: number | null,
): string {
  if (name != null) {
    return name;
  } else if (pid != null) {
    return `Process ${pid}`;
  }
  return 'Unknown';
}

interface PathPart {
  // Display name shown in the workspace tree.
  name: string;
  // Sort order within the immediate parent.
  sortOrder: number;
  // Stable key used to dedupe groups (combined with upid + ancestors).
  key: string;
}

interface LeafTrack {
  // The owning process.
  upid: number;
  pid: number | null;
  processName: string | null;
  // Ordered groups from outermost (under the per-process "GPU" node) to
  // innermost (parent of the leaf track). May be empty.
  pathParts: PathPart[];
  // Leaf track display name.
  leafName: string;
  // Sort order of the leaf within its immediate parent.
  leafSortOrder: number;
  // Stable URI suffix appended after the per-process URI prefix.
  uriSuffix: string;
  // The dataset that drives the SliceTrack. Discoverers prefer
  // src='gpu_slice' + a structured `filter` (so aggregation across tracks
  // can merge them). When the constraint can't be expressed by the dataset
  // Filter API (e.g. predicates on extract_arg() values), a custom
  // subquery src is used instead.
  dataset: SourceDataset<{
    id: number;
    name: string;
    ts: bigint;
    dur: bigint;
    depth: number;
  }>;
}

// CUDA / HIP: events that carry both a "device" and "stream" launch arg get
// nested under "Device #N -> Context #N -> Stream #N", with the leaf track
// holding the actual slices. Other APIs can be added by writing a similar
// discovery function and adding it to discoverApiTracks() below.
//
// Notes on per-sequence scoping:
//   * device, stream and the gpu_slice.context_id (which is the
//     InternedGraphicsContext IID) are all per-process. Two processes can
//     reuse the same numeric values for distinct logical entities; including
//     upid in every URI / partition key keeps them disambiguated.
async function discoverCudaHipTracks(ctx: Trace): Promise<LeafTrack[]> {
  // Pick up the API name (CUDA / HIP / OPEN_CL / VULKAN / ...) from
  // gpu_context so we can label the per-process top group with the right
  // API. gpu_context is populated from InternedGraphicsContext.api, which
  // both the CUDA and HIP injection producers set. The view lives in the
  // std.gpu.context perfetto SQL module and must be included before use.
  const result = await ctx.engine.query(`
    INCLUDE PERFETTO MODULE std.gpu.context;
    SELECT
      s.upid AS upid,
      extract_arg(s.arg_set_id, 'device') AS device,
      s.context_id AS context,
      extract_arg(s.arg_set_id, 'stream') AS stream,
      gc.api AS api,
      p.pid AS pid,
      p.name AS process_name
    FROM gpu_slice s
    JOIN process p USING (upid)
    LEFT JOIN gpu_context gc ON gc.context_id = s.context_id
    WHERE s.upid IS NOT NULL
      AND s.context_id IS NOT NULL
      AND extract_arg(s.arg_set_id, 'device') IS NOT NULL
      AND extract_arg(s.arg_set_id, 'stream') IS NOT NULL
    GROUP BY s.upid, device, s.context_id, stream
    ORDER BY s.upid, device, s.context_id, stream
  `);

  const it = result.iter({
    upid: NUM,
    device: NUM,
    context: NUM,
    stream: NUM,
    api: STR_NULL,
    pid: NUM_NULL,
    process_name: STR_NULL,
  });

  interface Raw {
    upid: number;
    device: number;
    context: number;
    stream: number;
    api: string | null;
    pid: number | null;
    processName: string | null;
  }
  const raws: Raw[] = [];
  // Hierarchy collapse: skip the Device level if the process only ever
  // touched a single device, and skip the Context level for any
  // particular (process, device) where only a single context is used.
  // Stream is always shown as the leaf.
  const devicesByUpid = new Map<number, Set<number>>();
  const contextsByUpidDevice = new Map<string, Set<number>>();
  for (; it.valid(); it.next()) {
    raws.push({
      upid: it.upid,
      device: it.device,
      context: it.context,
      stream: it.stream,
      api: it.api,
      pid: it.pid,
      processName: it.process_name,
    });
    const dSet = devicesByUpid.get(it.upid) ?? new Set<number>();
    dSet.add(it.device);
    devicesByUpid.set(it.upid, dSet);
    const ctxKey = `${it.upid}#${it.device}`;
    const cSet = contextsByUpidDevice.get(ctxKey) ?? new Set<number>();
    cSet.add(it.context);
    contextsByUpidDevice.set(ctxKey, cSet);
  }

  return raws.map((r) => {
    // The top API group is named after the actual API on the slices'
    // graphics context (e.g. "CUDA" for cuda-injection traces, "HIP" for
    // hip-injection traces). Slices whose API couldn't be resolved fall
    // back to a generic "API" label: gpu_context.api is either SQL NULL or
    // the literal string "UNDEFINED" (e.g. MTIA, which has no GPU API), and
    // both mean "unknown". Labelling it "API" keeps a distinct level under
    // the per-process "GPU" group instead of showing "undefined" or
    // duplicating "GPU". Different APIs within the same process get separate
    // sibling groups via the path key.
    const apiName =
      r.api == null || r.api.toUpperCase() === 'UNDEFINED' ? 'API' : r.api;
    const apiKey = `api_${apiName.toLowerCase()}`;
    const pathParts: PathPart[] = [{name: apiName, sortOrder: 0, key: apiKey}];
    if ((devicesByUpid.get(r.upid)?.size ?? 0) > 1) {
      pathParts.push({
        name: `Device #${r.device}`,
        sortOrder: r.device,
        key: `${apiKey}_device_${r.device}`,
      });
    }
    const contextsForDevice =
      contextsByUpidDevice.get(`${r.upid}#${r.device}`)?.size ?? 0;
    if (contextsForDevice > 1) {
      pathParts.push({
        name: `Context #${r.context}`,
        sortOrder: r.context,
        key: `${apiKey}_device_${r.device}_context_${r.context}`,
      });
    }
    const whereClause =
      `gpu_slice.upid = ${r.upid}` +
      ` AND extract_arg(gpu_slice.arg_set_id, 'device') = ${r.device}` +
      ` AND gpu_slice.context_id = ${r.context}` +
      ` AND extract_arg(gpu_slice.arg_set_id, 'stream') = ${r.stream}`;
    return {
      upid: r.upid,
      pid: r.pid,
      processName: r.processName,
      pathParts,
      leafName: `Stream #${r.stream}`,
      leafSortOrder: r.stream,
      uriSuffix: `${apiKey}_d${r.device}_c${r.context}_s${r.stream}`,
      dataset: layoutDataset(whereClause),
    };
  });
}

// Builds the dataset for a leaf SliceTrack. The stored gpu_slice.depth is 0 for
// every render-stage slice, so slices that overlap in time on the same leaf
// (e.g. a coarse job span and the finer slices running inside it) would draw on
// top of each other. Instead we read a per-lane layout depth precomputed in
// LAYOUT_TABLE (see createLayoutDepthTable), joined by slice id, so overlapping
// slices stack into rows within the one lane. The join stays cheap because the
// heavy layout work is done once at trace load, not per viewport.
//
// ORDER BY ts is required because SliceTrack's __intrinsic_slice_mipmap operator
// runs a galloping binary search (slice_mipmap_operator.cc) that assumes the
// per-depth timestamps array is sorted; without it SQLite's row order is
// unspecified and the mipmap silently skips out-of-order rows.
function layoutDataset(whereClause: string) {
  return new SourceDataset({
    src: `(
      SELECT
        gpu_slice.id,
        gpu_slice.name,
        gpu_slice.ts,
        gpu_slice.dur,
        layout.depth AS depth
      FROM gpu_slice
      JOIN ${LAYOUT_TABLE} layout USING (id)
      WHERE ${whereClause}
      ORDER BY gpu_slice.ts
    )`,
    schema: {
      id: NUM,
      name: STR,
      ts: LONG,
      dur: LONG,
      depth: NUM,
    },
  });
}

// A half-open time span [ts, te) occupied by one slice.
interface Interval {
  ts: bigint;
  te: bigint;
}

// One source gpu_track's contribution to a lane: the slices it owns and their
// time spans (sorted by ts, and internally non-overlapping since a track never
// overlaps itself).
interface SourceTrack {
  trackId: number;
  sliceIds: number[];
  intervals: Interval[];
}

// True if any interval in `a` overlaps any in `b`. Both must be sorted by ts and
// internally non-overlapping, so a single linear walk decides it.
function intervalsOverlap(
  a: ReadonlyArray<Interval>,
  b: ReadonlyArray<Interval>,
): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].te <= b[j].ts) {
      i++; // a[i] ends before b[j] starts
    } else if (b[j].te <= a[i].ts) {
      j++; // b[j] ends before a[i] starts
    } else {
      return true; // they overlap
    }
  }
  return false;
}

// Merges two sorted, mutually non-overlapping interval lists into one sorted
// list.
function mergeIntervals(
  a: ReadonlyArray<Interval>,
  b: ReadonlyArray<Interval>,
): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].ts <= b[j].ts) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// Computes a layout depth for every slice the plugin will show and stores it in
// LAYOUT_TABLE as (id, depth). A "lane" is a leaf track (see lane_key below):
// the CUDA/HIP discoverer keys lanes by (upid, device, context, stream); the
// fallback keys by (upid, hw_queue_id).
//
// The stored gpu_slice.depth is 0 for every render-stage slice, so overlapping
// slices in a lane would otherwise draw on the same row. A GpuByProcess lane
// merges slices from several source gpu_tracks — the stream <-> hw-queue mapping
// is many-to-many (one stream spans several queues; one queue serves several
// streams), so a lane pulls together tracks that can run concurrently.
// trace_processor already guarantees each source track is internally
// non-overlapping (TrackCompressor spills any overlap onto a separate parallel
// track, dimension track_compressor_idx).
//
// So the job is to merge those tracks back onto as few rows as possible: two
// tracks whose slices never overlap in time collapse onto one row (showing the
// stream's temporal order), and only genuinely time-overlapping tracks — an AFG
// job vs the layers running inside it — are forced onto separate rows. This is
// greedy first-fit over WHOLE tracks: tracks are visited in
// (hw_queue_id, track_compressor_idx) order and each is dropped onto the lowest
// row whose already-placed slices it doesn't overlap. Keeping a track whole
// means it never splits across rows, and because each track is serial the result
// never visually overlaps, for nested and crossing slices alike. The row
// assignment needs the running per-row occupancy so it can't be a SQL window
// function; we compute it here and materialise (id, depth) into LAYOUT_TABLE.
async function createLayoutDepthTable(engine: Trace['engine']): Promise<void> {
  // Every slice the plugin can show, tagged with its lane and time span, ordered
  // by lane, then source track (hw_queue then compressor index), then ts.
  const result = await engine.query(`
    SELECT
      s.id AS id,
      s.track_id AS track_id,
      s.ts AS ts,
      CASE WHEN s.dur < 0 THEN 9223372036854775807 ELSE s.ts + s.dur END AS te,
      CASE
        WHEN s.context_id IS NOT NULL
             AND extract_arg(s.arg_set_id, 'device') IS NOT NULL
             AND extract_arg(s.arg_set_id, 'stream') IS NOT NULL
        THEN 'c:' || s.upid || ':' || extract_arg(s.arg_set_id, 'device') ||
             ':' || s.context_id || ':' || extract_arg(s.arg_set_id, 'stream')
        WHEN s.hw_queue_id IS NOT NULL
             AND (extract_arg(s.arg_set_id, 'device') IS NULL
                  OR extract_arg(s.arg_set_id, 'stream') IS NULL)
        THEN 'f:' || s.upid || ':' || s.hw_queue_id
      END AS lane_key
    FROM gpu_slice s
    JOIN track t ON t.id = s.track_id
    WHERE s.upid IS NOT NULL
    ORDER BY lane_key,
             s.hw_queue_id,
             extract_arg(t.dimension_arg_set_id, 'track_compressor_idx'),
             s.track_id,
             s.ts
  `);

  const it = result.iter({
    id: NUM,
    track_id: NUM,
    ts: LONG,
    te: LONG,
    lane_key: STR_NULL,
  });

  // Phase 1: group slices by lane, then by source track, preserving query order
  // (Map keeps insertion order, so tracks stay in hw_queue/compressor order and
  // slices in ts order).
  const tracksByLane = new Map<string, SourceTrack[]>();
  for (; it.valid(); it.next()) {
    const laneKey = it.lane_key;
    if (laneKey === null) continue;

    let tracks = tracksByLane.get(laneKey);
    if (tracks === undefined) {
      tracks = [];
      tracksByLane.set(laneKey, tracks);
    }

    let track = tracks[tracks.length - 1];
    if (track === undefined || track.trackId !== it.track_id) {
      track = {trackId: it.track_id, sliceIds: [], intervals: []};
      tracks.push(track);
    }
    track.sliceIds.push(it.id);
    track.intervals.push({ts: it.ts, te: it.te});
  }

  // Phase 2: drop each whole track onto the lowest row it doesn't overlap.
  const ids: number[] = [];
  const depths: number[] = [];
  for (const tracks of tracksByLane.values()) {
    const rows: Interval[][] = []; // rows[r] = merged intervals already on row r
    for (const track of tracks) {
      let r = 0;
      while (r < rows.length && intervalsOverlap(rows[r], track.intervals)) r++;
      if (r === rows.length) rows.push([]);
      rows[r] = mergeIntervals(rows[r], track.intervals);
      for (const id of track.sliceIds) {
        ids.push(id);
        depths.push(r);
      }
    }
  }

  // Phase 3: write (id, depth) into LAYOUT_TABLE via chunked VALUES (each stays
  // within SQLite's single-VALUES limit) so the leaf datasets can join it.
  const chunkSize = 5000;
  const blocks: string[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const vals: string[] = [];
    for (let j = i; j < Math.min(i + chunkSize, ids.length); j++) {
      vals.push(`(${ids[j]},${depths[j]})`);
    }
    blocks.push(`SELECT column1 AS id, column2 AS depth FROM (VALUES ${vals.join(',')})`);
  }
  const body =
    blocks.length > 0
      ? blocks.join(' UNION ALL ')
      : 'SELECT 0 AS id, 0 AS depth WHERE 0';
  await engine.query(`CREATE PERFETTO TABLE ${LAYOUT_TABLE} AS ${body}`);
}

// Fallback: events that are not classified by any API-specific discovery
// (i.e. lack the device + stream launch args used by CUDA/HIP). Each
// (process, hw_queue_id) tuple gets one leaf track named after the global
// hw queue track ("Channel #1", "Channel #2", ...). When a process spans
// multiple GPUs, those leaves are nested under per-GPU sub-groups.
async function discoverFallbackTracks(
  ctx: Trace,
  numMachines: number,
): Promise<LeafTrack[]> {
  const result = await ctx.engine.query(`
    SELECT
      s.upid AS upid,
      s.hw_queue_id AS hw_queue_id,
      MIN(t.name) AS track_name,
      extract_arg(t.dimension_arg_set_id, 'ugpu') AS ugpu,
      extract_arg(t.dimension_arg_set_id, 'gpu') AS gpu_id,
      t.machine_id AS machine_id,
      g.name AS gpu_name,
      m.name AS machine_name,
      m.label_index AS machine_label_index,
      p.pid AS pid,
      p.name AS process_name
    FROM gpu_slice s
    JOIN gpu_track t ON s.track_id = t.id
    JOIN process p USING (upid)
    LEFT JOIN gpu g ON extract_arg(t.dimension_arg_set_id, 'ugpu') = g.id
    LEFT JOIN machine m ON m.id = t.machine_id
    WHERE s.upid IS NOT NULL AND s.hw_queue_id IS NOT NULL
      AND (extract_arg(s.arg_set_id, 'device') IS NULL
           OR extract_arg(s.arg_set_id, 'stream') IS NULL)
    GROUP BY s.upid, s.hw_queue_id
    ORDER BY s.upid, ugpu, s.hw_queue_id
  `);

  const it = result.iter({
    upid: NUM,
    hw_queue_id: NUM,
    track_name: STR,
    ugpu: NUM_NULL,
    gpu_id: NUM_NULL,
    machine_id: NUM,
    gpu_name: STR_NULL,
    machine_name: STR_NULL,
    machine_label_index: NUM_NULL,
    pid: NUM_NULL,
    process_name: STR_NULL,
  });

  interface FallbackRow {
    upid: number;
    pid: number | null;
    processName: string | null;
    hwqId: number;
    trackName: string;
    gpu: Gpu | null;
  }

  const rows: FallbackRow[] = [];
  const ugpusByUpid = new Map<number, Set<number>>();
  for (; it.valid(); it.next()) {
    const gpu =
      it.gpu_id !== null
        ? new Gpu(
            it.ugpu ?? it.gpu_id,
            it.gpu_id,
            it.machine_id,
            it.gpu_name ?? undefined,
            it.machine_name ?? undefined,
            it.machine_label_index ?? undefined,
            numMachines,
          )
        : null;
    rows.push({
      upid: it.upid,
      pid: it.pid,
      processName: it.process_name,
      hwqId: it.hw_queue_id,
      trackName: it.track_name,
      gpu,
    });
    if (gpu !== null) {
      let set = ugpusByUpid.get(it.upid);
      if (set === undefined) {
        set = new Set<number>();
        ugpusByUpid.set(it.upid, set);
      }
      set.add(gpu.ugpu);
    }
  }

  return rows.map((row) => {
    const pathParts: PathPart[] = [];
    const distinctGpus = ugpusByUpid.get(row.upid)?.size ?? 0;
    if (row.gpu !== null && distinctGpus > 1) {
      pathParts.push({
        name: `${row.gpu.displayName}${row.gpu.maybeMachineLabel()}`,
        sortOrder: row.gpu.sortOrder,
        key: `gpu_${row.gpu.ugpu}`,
      });
    }
    const whereClause =
      `gpu_slice.upid = ${row.upid}` +
      ` AND gpu_slice.hw_queue_id = ${row.hwqId}` +
      ` AND (extract_arg(gpu_slice.arg_set_id, 'device') IS NULL` +
      ` OR extract_arg(gpu_slice.arg_set_id, 'stream') IS NULL)`;
    return {
      upid: row.upid,
      pid: row.pid,
      processName: row.processName,
      pathParts,
      leafName: row.trackName,
      leafSortOrder: row.hwqId,
      uriSuffix: `hwq_${row.hwqId}`,
      dataset: layoutDataset(whereClause),
    };
  });
}

// API-specific discoverers run before the fallback. Each emits leaf tracks
// for slices it claims; the fallback then handles whatever's left. To add
// a new API, write an async discoverer returning LeafTrack[] and append it
// here, plus update discoverFallbackTracks()'s WHERE clause to also
// exclude that API's slices.
async function discoverApiTracks(ctx: Trace): Promise<LeafTrack[]> {
  const cuda = await discoverCudaHipTracks(ctx);
  return cuda;
}

export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.GpuByProcess';
  static readonly dependencies = [ProcessThreadGroupsPlugin];

  async onTraceLoad(ctx: Trace): Promise<void> {
    // Precompute the per-lane slice layout depth once; leaf datasets join it.
    await createLayoutDepthTable(ctx.engine);

    const numMachines = await getMachineCount(ctx.engine);
    const apiTracks = await discoverApiTracks(ctx);
    const fallbackTracks = await discoverFallbackTracks(ctx, numMachines);
    const allTracks = [...apiTracks, ...fallbackTracks];

    const processGroups = ctx.plugins.getPlugin(ProcessThreadGroupsPlugin);
    const gpuGroupByUpid = new Map<number, TrackNode>();
    const subGroupByKey = new Map<string, TrackNode>();
    const processInfoByUpid = new Map<
      number,
      {pid: number | null; processName: string | null}
    >();
    for (const t of allTracks) {
      if (!processInfoByUpid.has(t.upid)) {
        processInfoByUpid.set(t.upid, {
          pid: t.pid,
          processName: t.processName,
        });
      }
    }

    for (const t of allTracks) {
      const uri = `dev.perfetto.GpuByProcess#${t.upid}#${t.uriSuffix}`;
      ctx.tracks.registerTrack({
        uri,
        renderer: SliceTrack.create({
          trace: ctx,
          uri,
          dataset: t.dataset,
          detailsPanel: () => new ThreadSliceDetailsPanel(ctx),
        }),
      });

      let processGroup = processGroups.getGroupForProcess(t.upid);
      if (processGroup === undefined) {
        const info = processInfoByUpid.get(t.upid)!;
        const displayName = getProcessDisplayName(info.processName, info.pid);
        processGroup = new TrackNode({
          uri: `/process_${t.upid}`,
          name: `${displayName} ${info.pid ?? t.upid}`,
          isSummary: true,
          sortOrder: 50,
        });
        ctx.defaultWorkspace.addChildInOrder(processGroup);
      }

      let gpuGroup = gpuGroupByUpid.get(t.upid);
      if (gpuGroup === undefined) {
        gpuGroup = new TrackNode({
          uri: `dev.perfetto.GpuByProcess#${t.upid}`,
          name: 'GPU',
          isSummary: true,
          sortOrder: -50,
        });
        processGroup.addChildInOrder(gpuGroup);
        gpuGroupByUpid.set(t.upid, gpuGroup);
      }

      // Walk pathParts, lazily creating sub-groups along the way.
      let parent = gpuGroup;
      let cumulativeKey = `${t.upid}`;
      for (const part of t.pathParts) {
        cumulativeKey += `#${part.key}`;
        let sub = subGroupByKey.get(cumulativeKey);
        if (sub === undefined) {
          sub = new TrackNode({
            uri: `dev.perfetto.GpuByProcess#${cumulativeKey}`,
            name: part.name,
            isSummary: true,
            sortOrder: part.sortOrder,
          });
          parent.addChildInOrder(sub);
          subGroupByKey.set(cumulativeKey, sub);
        }
        parent = sub;
      }

      parent.addChildInOrder(
        new TrackNode({
          uri,
          name: t.leafName,
          sortOrder: t.leafSortOrder,
        }),
      );
    }
  }
}
