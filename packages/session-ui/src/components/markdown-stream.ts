import { createMarkdownStream, type MarkdownBlock, type PatchmarkStream } from "@opencode/patchmark"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type ProjectionPatch =
  | { op: "append"; block: Block }
  | { op: "replace"; index: number; block: Block }
  | { op: "finalize"; index: number; block: Block }
  | { op: "truncate"; keepCount: number }

export type Projection = {
  text: string
  blocks: Block[]
  patches?: ProjectionPatch[]
}

const streams = new WeakMap<Projection, PatchmarkStream>()

function createStream() {
  return createMarkdownStream({
    gfm: true,
    math: true,
    heal: true,
    holdPendingMarkers: false,
    settleOnComplete: false,
    groupHtmlBlocks: true,
    renderHtml: false,
  })
}

function toBlock(block: MarkdownBlock): Block {
  if (block.kind.type === "code" || block.kind.type === "mermaid") {
    const item: Block = {
      raw: block.raw,
      src: block.kind.source,
      mode: "code",
    }

    const language = block.kind.type === "mermaid" ? "mermaid" : block.kind.language
    if (language) item.language = language

    if (block.kind.complete || block.status === "settled") item.complete = true

    return item
  }

  const mode = block.status === "settled" ? "full" : "live"
  const defs = block.defs ? `\n\n${block.defs}` : ""
  const base = mode === "live" ? (block.liveRaw ?? block.raw) : block.raw

  return {
    raw: block.raw,
    src: base + defs,
    mode,
  }
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks

  const blocks = createStream().update(text, { streaming: true }).blocks.map(toBlock)
  if (blocks.length === 0) return [{ raw: text, src: text, mode: "live" }]

  return blocks
}

function applyPatches(previous: Block[], frame: ReturnType<PatchmarkStream["update"]>) {
  const blocks = [...previous]
  const patches: ProjectionPatch[] = []

  for (const patch of frame.patches) {
    if (patch.op === "append") {
      const block = toBlock(patch.block)
      blocks.push(block)
      patches.push({ op: "append", block })
    } else if (patch.op === "replace" || patch.op === "finalize") {
      const block = toBlock(patch.block)
      blocks[patch.index] = block
      patches.push({ op: patch.op, index: patch.index, block })
    } else {
      blocks.length = patch.keepCount
      patches.push({ op: "truncate", keepCount: patch.keepCount })
    }
  }

  return { blocks, patches }
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!previous) {
    if (!live) return completedProjection(text)

    const instance = createStream()
    const rawBlocks = instance.update(text, { streaming: true }).blocks.map(toBlock)
    const blocks = rawBlocks.length === 0 ? ([{ raw: text, src: text, mode: "live" }] satisfies Block[]) : rawBlocks
    const next: Projection = { text, blocks, patches: blocks.map((block) => ({ op: "append", block })) }
    streams.set(next, instance)

    return next
  }

  if (live && previous.text === text) return previous

  let instance = streams.get(previous)

  if (!instance || instance.getText() !== previous.text) {
    // The worker lost this stream (or the projection came from elsewhere): replay it into a fresh parser.
    instance = createStream()
    if (previous.text.length > 0 && text.startsWith(previous.text)) {
      instance.update(previous.text, { streaming: true })
    }
  }

  const wasFallback = instance.getBlocks().length === 0 && previous.blocks.length > 0
  const frame = instance.update(text, { streaming: live })

  if (frame.blocks.length === 0) {
    const fallbackBlock: Block = { raw: text, src: text, mode: live ? "live" : "full" }
    const next: Projection = {
      text,
      blocks: [fallbackBlock],
      patches: [{ op: "truncate", keepCount: 0 }, { op: "append", block: fallbackBlock }],
    }
    if (live) streams.set(next, instance)
    return next
  }

  const { blocks, patches } = wasFallback
    ? {
        blocks: frame.blocks.map(toBlock),
        patches: [
          { op: "truncate", keepCount: 0 } as ProjectionPatch,
          ...frame.blocks.map((block) => ({ op: "append", block: toBlock(block) }) as ProjectionPatch),
        ],
      }
    : applyPatches(previous.blocks, frame)

  const next: Projection = { text, blocks, patches }
  if (live) streams.set(next, instance)

  return next
}
