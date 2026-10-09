/*
 * A small fake of the `premierepro` UXP module, shaped after Adobe's
 * @adobe/premierepro 26.5.0 type declarations, so premiere.js and sync.js can
 * be exercised under Node (tools/test-sync.mjs).
 *
 * It models only what LazyEditMirror touches: tracks, clip track items,
 * project items with in/out marks, overwrite edits (including the linked audio
 * an overwrite brings along), selection-based removal and transactions.
 */
export const TICKS_PER_SECOND = 254016000000;

class MockTickTime {
  constructor(ticks) {
    this._t = Math.round(ticks);
  }
  get ticksNumber() {
    return this._t;
  }
  get ticks() {
    return String(this._t);
  }
  get seconds() {
    return this._t / TICKS_PER_SECOND;
  }
  add(o) {
    return new MockTickTime(this._t + o._t);
  }
  subtract(o) {
    return new MockTickTime(this._t - o._t);
  }
  equals(o) {
    return this._t === o._t;
  }
}

const tt = (ticks) => new MockTickTime(ticks);
export const sec = (s) => Math.round(s * TICKS_PER_SECOND);

const Constants = {
  TrackItemType: { EMPTY: 0, CLIP: 1, TRANSITION: 2, PREVIEW: 3, FEEDBACK: 4 },
  MediaType: { ANY: 0, DATA: 1, VIDEO: 2, AUDIO: 3 },
  ContentType: { ANY: 0, SEQUENCE: 1, MEDIA: 2 },
};

const TYPE_BIN = 2;
const TYPE_CLIP = 1;
const TYPE_ROOT = 3;

let nextId = 1;

/** A project item record. Clip in/out marks live here so every cast shares them. */
export class MockProjectItem {
  constructor(props) {
    this.id = String(nextId++);
    this.name = props.name;
    this.type = props.type;
    this.children = props.children || [];
    this.mediaPath = props.mediaPath || "";
    this.mediaStart = props.mediaStart || 0;
    this.duration = props.duration || 0;
    this.hasAudio = props.hasAudio !== false;
    this.fps = props.fps || 25;
    this.isSequence = !!props.isSequence;
    this.inPoint = null;
    this.outPoint = null;
    this.inOutChanges = 0;
  }
  getId() {
    return this.id;
  }
}

class MockClipProjectItem {
  constructor(record) {
    this.record = record;
    this.name = record.name;
    this.type = record.type;
  }
  async isSequence() {
    return this.record.isSequence;
  }
  async isMulticamClip() {
    return false;
  }
  async isMergedClip() {
    return false;
  }
  async isOffline() {
    return false;
  }
  async getContentType() {
    return this.record.isSequence ? Constants.ContentType.SEQUENCE : Constants.ContentType.MEDIA;
  }
  async getMediaFilePath() {
    return this.record.mediaPath;
  }
  async getMedia() {
    const r = this.record;
    return { getStart: () => tt(r.mediaStart), getDuration: () => tt(r.duration) };
  }
  async getFootageInterpretation() {
    const r = this.record;
    return { getFrameRate: () => r.fps };
  }
  async getComponentChain(mediaType) {
    if (mediaType === Constants.MediaType.AUDIO) return this.record.hasAudio ? { getComponentCount: () => 1 } : null;
    return { getComponentCount: () => 1 };
  }
  async getInPoint() {
    return tt(this.record.inPoint == null ? 0 : this.record.inPoint);
  }
  async getOutPoint() {
    return tt(this.record.outPoint == null ? this.record.duration : this.record.outPoint);
  }
  createSetInOutPointsAction(inPoint, outPoint) {
    const r = this.record;
    return () => {
      r.inPoint = inPoint.ticksNumber;
      r.outPoint = outPoint.ticksNumber;
      r.inOutChanges += 1;
    };
  }
  createClearInOutPointsAction() {
    const r = this.record;
    return () => {
      r.inPoint = null;
      r.outPoint = null;
    };
  }
}

export class MockTrackItem {
  constructor(track, props) {
    this.track = track;
    this.start = props.start;
    this.end = props.end;
    this.inPoint = props.inPoint;
    this.outPoint = props.outPoint;
    this.projectItem = props.projectItem;
    this.name = props.name || (props.projectItem && props.projectItem.name) || "";
    this.speed = props.speed == null ? 1 : props.speed;
    this.reversed = !!props.reversed;
    this.adjustment = !!props.adjustment;
  }
  async getStartTime() {
    return tt(this.start);
  }
  async getEndTime() {
    return tt(this.end);
  }
  async getInPoint() {
    return tt(this.inPoint);
  }
  async getOutPoint() {
    return tt(this.outPoint);
  }
  async getProjectItem() {
    return this.projectItem;
  }
  async getName() {
    return this.name;
  }
  async getSpeed() {
    return this.speed;
  }
  async isSpeedReversed() {
    return this.reversed ? 1 : 0;
  }
  async isAdjustmentLayer() {
    return this.adjustment;
  }
  async getTrackIndex() {
    return this.track.index;
  }
}

export class MockTrack {
  constructor(kind, index, name) {
    this.kind = kind;
    this.index = index;
    this.name = name || (kind === "video" ? "V" : "A") + (index + 1);
    this.id = index;
    this.items = [];
    this.transitions = [];
  }
  getTrackItems(type) {
    if (type === Constants.TrackItemType.CLIP) return this.items.slice().sort((a, b) => a.start - b.start);
    if (type === Constants.TrackItemType.TRANSITION) return this.transitions.slice();
    return [];
  }
  async getIndex() {
    return this.index;
  }
  add(props) {
    const item = new MockTrackItem(this, props);
    this.items.push(item);
    return item;
  }
}

/** Overwrite semantics: whatever lies under [start, end) is cut away. */
function overwriteRange(track, start, end) {
  const next = [];
  for (const item of track.items) {
    if (item.end <= start || item.start >= end) {
      next.push(item);
      continue;
    }
    if (item.start >= start && item.end <= end) continue; // fully covered
    if (item.start < start && item.end > end) {
      // split: keep both ends
      const right = new MockTrackItem(track, {
        start: end,
        end: item.end,
        inPoint: item.inPoint + (end - item.start),
        outPoint: item.outPoint,
        projectItem: item.projectItem,
        name: item.name,
      });
      item.outPoint -= item.end - start;
      item.end = start;
      next.push(item, right);
      continue;
    }
    if (item.start < start) {
      item.outPoint -= item.end - start;
      item.end = start;
    } else {
      item.inPoint += end - item.start;
      item.start = end;
    }
    next.push(item);
  }
  track.items = next;
}

export class MockSequence {
  constructor(props) {
    this.name = props.name || "Sequence 01";
    this.frameTicks = props.frameTicks || TICKS_PER_SECOND / 25;
    this.fps = props.fps || 25;
    this.zeroPoint = props.zeroPoint || 0;
    this.videoTracks = [];
    this.audioTracks = [];
    for (let i = 0; i < (props.videoTracks || 3); i += 1) this.videoTracks.push(new MockTrack("video", i));
    for (let i = 0; i < (props.audioTracks || 3); i += 1) this.audioTracks.push(new MockTrack("audio", i));
    this.selectionCleared = 0;
    /* What the user has selected in the timeline; tests fill this in. */
    this.selectedItems = [];
  }
  async getSelection() {
    const items = this.selectedItems.slice();
    return { getTrackItems: async () => items };
  }
  async getVideoTrackCount() {
    return this.videoTracks.length;
  }
  async getVideoTrack(i) {
    return this.videoTracks[i];
  }
  async getAudioTrackCount() {
    return this.audioTracks.length;
  }
  async getAudioTrack(i) {
    return this.audioTracks[i];
  }
  async getSettings() {
    const s = this;
    return { getVideoFrameRate: () => ({ ticksPerFrame: s.frameTicks, value: s.fps }) };
  }
  async getTimebase() {
    return String(this.frameTicks);
  }
  async getZeroPoint() {
    return tt(this.zeroPoint);
  }
  async clearSelection() {
    this.selectionCleared += 1;
    return true;
  }
}

export class MockProject {
  constructor(sequence, root) {
    this.sequence = sequence;
    this.root = root;
    this.transactions = [];
    this.locked = 0;
    this.name = "Mock.prproj";
  }
  async getActiveSequence() {
    return this.sequence;
  }
  async getRootItem() {
    /* The real API hands back a FolderItem, which has getItems(); the record itself does not. */
    const root = this.root;
    return { name: root.name, type: root.type, getItems: async () => root.children };
  }
  lockedAccess(cb) {
    this.locked += 1;
    try {
      cb();
    } finally {
      this.locked -= 1;
    }
  }
  executeTransaction(cb, label) {
    if (this.locked <= 0) throw new Error("executeTransaction called outside lockedAccess");
    const actions = [];
    const compound = {
      addAction(a) {
        actions.push(a);
        return true;
      },
      get empty() {
        return actions.length === 0;
      },
    };
    cb(compound);
    for (const action of actions) action();
    this.transactions.push({ label, count: actions.length });
    return true;
  }
}

/** Build the module object that `require("premierepro")` would return. */
export function createMockPremiere(project) {
  const sequence = project.sequence;
  const sourceMonitor = { closedAll: 0 };

  const editor = {
    createOverwriteItemAction(projectItem, time, videoTrackIndex, audioTrackIndex) {
      return () => {
        const record = projectItem;
        const inPoint = record.inPoint == null ? 0 : record.inPoint;
        const outPoint = record.outPoint == null ? record.duration : record.outPoint;
        const start = time.ticksNumber;
        const end = start + (outPoint - inPoint);
        const vTrack = sequence.videoTracks[videoTrackIndex];
        if (!vTrack) throw new Error("Script Action failed to execute (video track " + videoTrackIndex + ")");
        overwriteRange(vTrack, start, end);
        vTrack.add({ start, end, inPoint, outPoint, projectItem: record, name: record.name });
        if (record.hasAudio) {
          /* -1 behaves like 0 in Premiere (community report); modelled the same way. */
          const aTrack = sequence.audioTracks[audioTrackIndex < 0 ? 0 : audioTrackIndex];
          if (!aTrack) throw new Error("Script Action failed to execute (audio track " + audioTrackIndex + ")");
          overwriteRange(aTrack, start, end);
          aTrack.add({ start, end, inPoint, outPoint, projectItem: record, name: record.name });
        }
      };
    },
    createRemoveItemsAction(selection, ripple, mediaType) {
      if (ripple) throw new Error("ripple removal not modelled");
      return () => {
        for (const item of selection.items) {
          const isAudio = item.track.kind === "audio";
          if (mediaType === Constants.MediaType.VIDEO && isAudio) continue;
          if (mediaType === Constants.MediaType.AUDIO && !isAudio) continue;
          item.track.items = item.track.items.filter((i) => i !== item);
        }
      };
    },
  };

  return {
    Constants,
    TickTime: {
      createWithTicks: (s) => tt(Number(s)),
      createWithSeconds: (s) => tt(Math.round(s * TICKS_PER_SECOND)),
      TIME_ZERO: tt(0),
    },
    Project: { getActiveProject: async () => project },
    ProjectItem: { TYPE_BIN, TYPE_CLIP, TYPE_ROOT, cast: (i) => i },
    ClipProjectItem: { cast: (item) => (item && item.type === TYPE_CLIP ? new MockClipProjectItem(item) : null) },
    FolderItem: {
      cast: (item) => (item && (item.type === TYPE_BIN || item.type === TYPE_ROOT) ? { name: item.name, getItems: async () => item.children } : null),
    },
    SequenceEditor: { getEditor: () => editor },
    TrackItemSelection: {
      createEmptySelection(cb) {
        const selection = {
          items: [],
          addItem(item) {
            this.items.push(item);
            return true;
          },
          removeItem(item) {
            this.items = this.items.filter((i) => i !== item);
            return true;
          },
          getTrackItems: async () => selection.items.slice(),
        };
        cb(selection);
        return true;
      },
    },
    SourceMonitor: {
      closeAllClips: async () => {
        sourceMonitor.closedAll += 1;
        return true;
      },
      _state: sourceMonitor,
    },
  };
}

/**
 * The standard scenario: a 25 fps sequence, a front camera edit on V1 with two
 * cuts and one gap, the untouched side recording on V2, front audio on A1,
 * music on A3 and A2 empty. The side camera started 5 s before the front one.
 *
 * With options.multiFile the edit continues with a second front file
 * (Front2.mp4, two more clips at 30-40 s and 40-52 s) that has its own side
 * recording Side2.mp4, so a mirror needs two passes.
 */
export function createScenario(options = {}) {
  nextId = 1;
  const front = new MockProjectItem({
    name: "Front.mp4",
    type: TYPE_CLIP,
    mediaPath: "D:/Footage/Front.mp4",
    mediaStart: sec(36000), // 10:00:00:00
    duration: sec(600),
    hasAudio: true,
  });
  const side = new MockProjectItem({
    name: "Side.mp4",
    type: TYPE_CLIP,
    mediaPath: "D:/Footage/Side.mp4",
    mediaStart: options.sideStart == null ? sec(35995) : options.sideStart, // 09:59:55:00
    duration: options.sideDuration == null ? sec(590) : options.sideDuration,
    hasAudio: options.sideHasAudio !== false,
  });
  const front2 = new MockProjectItem({ name: "Front2.mp4", type: TYPE_CLIP, mediaPath: "D:/Footage/Front2.mp4", mediaStart: sec(40000), duration: sec(300), hasAudio: true });
  const side2 = new MockProjectItem({ name: "Side2.mp4", type: TYPE_CLIP, mediaPath: "D:/Footage/Side2.mp4", mediaStart: sec(41000), duration: sec(200), hasAudio: true });
  const music = new MockProjectItem({ name: "Music.wav", type: TYPE_CLIP, mediaPath: "D:/Footage/Music.wav", duration: sec(300), hasAudio: true });
  const binChildren = options.multiFile ? [front, side, front2, side2] : [front, side];
  const bin = new MockProjectItem({ name: "Footage", type: TYPE_BIN, children: binChildren });
  const root = new MockProjectItem({ name: "Root", type: TYPE_ROOT, children: [bin, music] });

  const sequence = new MockSequence({ videoTracks: options.videoTracks || 3, audioTracks: options.audioTracks || 3 });
  const [v1, v2] = sequence.videoTracks;
  const a1 = sequence.audioTracks[0];
  const a3 = sequence.audioTracks[2];

  /* Front edit: 0-10 s (src 2-12), cut, 10-18 s (src 20-28), gap, 20-30 s (src 40-50). */
  const edit = [
    [0, 10, 2, front],
    [10, 18, 20, front],
    [20, 30, 40, front],
  ];
  /* Second file: 30-40 s (src 5-15 of Front2), 40-52 s (src 30-42 of Front2). */
  if (options.multiFile) edit.push([30, 40, 5, front2], [40, 52, 30, front2]);
  for (const [start, end, srcIn, item] of edit) {
    v1.add({ start: sec(start), end: sec(end), inPoint: sec(srcIn), outPoint: sec(srcIn + (end - start)), projectItem: item });
    a1.add({ start: sec(start), end: sec(end), inPoint: sec(srcIn), outPoint: sec(srcIn + (end - start)), projectItem: item });
  }
  /* The side recording laid out whole on V2 (and its audio on A3, together with music). */
  if (!options.emptyTarget) v2.add({ start: 0, end: sec(60), inPoint: 0, outPoint: sec(60), projectItem: side });
  if (a3) a3.add({ start: 0, end: sec(30), inPoint: 0, outPoint: sec(30), projectItem: music });

  const project = new MockProject(sequence, root);
  const ppro = createMockPremiere(project);
  return { ppro, project, sequence, front, side, front2, side2, music, root, v1, v2 };
}
