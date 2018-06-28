import {Change} from "../../state/src/state"
import {ChangedRange} from "../../doc/src/diff"

export interface DecorationRangeSpec {
  inclusiveStart?: boolean;
  inclusiveEnd?: boolean;
  attributes?: {[key: string]: string};
  // Shorthand for {attributes: {class: value}}
  class?: string;
  lineAttributes?: {[key: string]: string};
  tagName?: string;
  collapsed?: boolean | WidgetType<any>;
}

export interface DecorationPointSpec {
  side?: number;
  lineAttributes?: {[key: string]: string};
  widget?: WidgetType<any>;
}

export abstract class WidgetType<T> {
  constructor(readonly spec: T) {}
  abstract toDOM(): HTMLElement;
  eq(spec: T): boolean { return this.spec === spec }

  /** @internal */
  compare(other: WidgetType<any>): boolean {
    return this == other || this.constructor == other.constructor && this.eq(other.spec)
  }

  get estimatedHeight(): number { return -1 }
}

// FIXME try dropping specs entirely from the data structure, and
// providing a user data field in decoration descs

abstract class DecorationDesc {
  constructor(readonly bias: number) {}
  spec: any;
  abstract map(deco: Decoration, changes: A<Change>, oldOffset: number, newOffset: number): Decoration | null;
}

const BIG_BIAS = 2e9

type A<T> = ReadonlyArray<T>

export class RangeDesc extends DecorationDesc {
  readonly endBias: number;
  readonly affectsSpans: boolean;

  constructor(readonly spec: DecorationRangeSpec) {
    super(spec.inclusiveStart === true ? -BIG_BIAS : BIG_BIAS)
    this.endBias = spec.inclusiveEnd == true ? BIG_BIAS : -BIG_BIAS
    this.affectsSpans = !!(spec.attributes || spec.tagName || spec.class || spec.collapsed)
  }

  map(deco: Decoration, changes: A<Change>, oldOffset: number, newOffset: number): Decoration | null {
    let from = mapPos(deco.from + oldOffset, changes, this.bias), to = mapPos(deco.to + oldOffset, changes, this.endBias)
    return from < to ? new Decoration(from - newOffset, to - newOffset, this) : null
  }

  eq(other: RangeDesc) {
    let collA = this.spec.collapsed, collB = other.spec.collapsed
    return this == other ||
      this.spec.tagName == other.spec.tagName &&
      this.spec.class == other.spec.class &&
      (collA === collB || (collA instanceof WidgetType && collB instanceof WidgetType && collA.compare(collB))) &&
      attrsEq(this.spec.attributes, other.spec.attributes)
  }
}

class PointDesc extends DecorationDesc {
  widget: WidgetType<any> | null;
  constructor(readonly spec: DecorationPointSpec) {
    super(spec.side || 0)
    this.widget = spec.widget || null
  }

  map(deco: Decoration, changes: A<Change>, oldOffset: number, newOffset: number): Decoration | null {
    let pos = mapPos(deco.from + oldOffset, changes, this.bias, true)
    return pos == -1 ? null : new Decoration(pos - newOffset, pos - newOffset, this)
  }

  eq(other: PointDesc) {
    return this.bias == other.bias &&
      (this.widget == other.widget || (this.widget && other.widget && this.widget.compare(other.widget)))
  }
}

export class Decoration {
  /** @internal */
  constructor(
    public readonly from: number,
    public readonly to: number,
    /** @internal */
    public readonly desc: DecorationDesc
  ) {}

  get spec(): any { return this.desc.spec }

  map(changes: A<Change>, oldOffset: number, newOffset: number): Decoration | null {
    return this.desc.map(this, changes, oldOffset, newOffset)
  }

  /** @internal */
  move(offset: number): Decoration {
    return offset ? new Decoration(this.from + offset, this.to + offset, this.desc) : this
  }

  static range(from: number, to: number, spec: DecorationRangeSpec): Decoration {
    if (from >= to) throw new RangeError("Range decorations may not be empty")
    return new Decoration(from, to, new RangeDesc(spec))
  }

  static point(pos: number, spec: DecorationPointSpec): Decoration {
    return new Decoration(pos, pos, new PointDesc(spec))
  }

  /** @internal Here so that we can put active decorations on a heap
   * and take then off at their end */
  get heapPos() { return this.to }
}

// FIXME use a mapping abstraction defined in the state module
function mapPos(pos: number, changes: A<Change>, assoc: number, track: boolean = false) {
  for (let change of changes) {
    if (track && change.from < pos && change.to > pos) return -1
    pos = change.mapPos(pos, assoc)
  }
  return pos
}

const noDecorations: A<Decoration> = []
const noChildren: A<DecorationSet> = []

const BASE_NODE_SIZE_SHIFT = 5, BASE_NODE_SIZE = 1 << BASE_NODE_SIZE_SHIFT

type DecorationFilter = (from: number, to: number, spec: any) => boolean

// FIXME look into generalizing this to a generic mappable
// position-data container

export class DecorationSet {
  /** @internal */
  constructor(
    /** @internal The text length covered by this set */
    public length: number,
    /** The number of decorations in the set */
    public size: number,
    /** @internal The locally stored decorations—which are all of them
     * for leaf nodes, and the ones that don't fit in child sets for
     * non-leaves. Sorted by start position, then end position, then startAssoc. */
    public local: A<Decoration>,
    /** @internal The child sets, in position order */
    public children: A<DecorationSet>
  ) {}

  update(decorations: A<Decoration> = noDecorations,
         filter: DecorationFilter | null = null,
         filterFrom: number = 0,
         filterTo: number = this.length): DecorationSet {
    let maxLen = decorations.reduce((l, d) => Math.max(l, d.to), this.length)
    return this.updateInner(decorations.length ? decorations.slice().sort(byPos) : decorations,
                            filter, filterFrom, filterTo, 0, maxLen)
  }

  /** @internal */
  updateInner(decorations: A<Decoration>,
              filter: DecorationFilter | null,
              filterFrom: number, filterTo: number,
              offset: number, length: number): DecorationSet {
    // The new local decorations. Null means no changes were made yet
    let local: Decoration[] | null = filterDecorations(this.local, filter, filterFrom, filterTo, offset)
    // The new array of child sets, if changed
    let children: DecorationSet[] | null = null

    let size = 0
    let decI = 0, pos = offset
    // Iterate over the child sets, applying filters and pushing added
    // decorations into them
    for (let i = 0; i < this.children.length; i++) {
      let child = this.children[i]
      let endPos = pos + child.length, localDeco: Decoration[] | null = null
      while (decI < decorations.length) {
        let next = decorations[decI]
        if (next.from >= endPos) break
        decI++
        if (next.to > endPos) {
          if (!local) local = this.local.slice()
          insertSorted(local, next.move(-offset))
        } else {
          (localDeco || (localDeco = [])).push(next)
        }
      }
      let newChild = child
      if (localDeco || filter && filterFrom <= endPos && filterTo >= pos)
        newChild = newChild.updateInner(localDeco || noDecorations, filter, filterFrom, filterTo,
                                        pos, newChild.length)
      if (newChild != child)
        (children || (children = this.children.slice(0, i))).push(newChild)
      else if (children)
        children.push(newChild)
      size += newChild.size
      pos = endPos
    }

    // If nothing was actually updated, return the existing object
    if (!local && !children && decI == decorations.length) return this

    // Compute final size and length
    size += (local || this.local).length + decorations.length - decI

    // This is a small node—turn it into a flat leaf
    if (size <= BASE_NODE_SIZE)
      return collapseSet(children || this.children, local || this.local.slice(),
                         decorations, decI, offset, length)


    // FIXME going from leaf to non-leaf is currently a mess—will
    // leave all the locals alongside a newly created child

    let childSize = Math.max(BASE_NODE_SIZE, size >> BASE_NODE_SIZE_SHIFT)
    if (decI < decorations.length) {
      if (!children) children = this.children.slice()
      if (!local) local = this.local.slice()
      appendDecorations(local, children, decorations, decI, offset, length, pos, childSize)
    }

    if (children) {
      if (!local) local = this.local.slice()
      rebalanceChildren(local, children, childSize)
    }

    return new DecorationSet(length, size, local || this.local, children || this.children)
  }

  grow(length: number): DecorationSet {
    return new DecorationSet(this.length + length, this.size, this.local, this.children)
  }

  // Collect all decorations in this set into the target array,
  // offsetting them by `offset`
  collect(target: Decoration[], offset: number) {
    for (let deco of this.local) target.push(deco.move(offset))
    for (let child of this.children) {
      child.collect(target, offset)
      offset += child.length
    }
  }

  map(changes: A<Change>): DecorationSet {
    if (changes.length == 0 || this == DecorationSet.empty) return this
    return this.mapInner(changes, 0, 0, mapPos(this.length, changes, 1)).set
  }

  private mapInner(changes: A<Change>,
                   oldStart: number, newStart: number,
                   newEnd: number): {set: DecorationSet, escaped: Decoration[] | null} {
    let newLocal: Decoration[] | null = null
    let escaped: Decoration[] | null = null
    let newLength = newEnd - newStart, newSize = 0

    for (let i = 0; i < this.local.length; i++) {
      let deco = this.local[i], mapped = deco.map(changes, oldStart, newStart)
      let escape = mapped != null && (mapped.from < 0 || mapped.to > newLength)
      if (newLocal == null && (deco != mapped || escaped)) newLocal = this.local.slice(0, i)
      if (escape) (escaped || (escaped = [])).push(mapped!)
      else if (newLocal && mapped) newLocal.push(mapped)
    }

    let newChildren: DecorationSet[] | null = null
    for (let i = 0, oldPos = oldStart, newPos = newStart; i < this.children.length; i++) {
      let child = this.children[i], newChild = child
      let oldChildEnd = oldPos + child.length
      let newChildEnd = mapPos(oldPos + child.length, changes, 1)
      // FIXME immediately collapse children entirely covered by a change
      if (touchesChange(oldPos, oldChildEnd, changes)) {
        let inner = child.mapInner(changes, oldPos, newPos, newChildEnd)
        newChild = inner.set
        if (inner.escaped) for (let deco of inner.escaped) {
          deco = deco.move(newPos - newStart)
          if (deco.from < 0 || deco.to > newLength) {
            ;(escaped || (escaped = [])).push(deco)
          } else {
            if (newLocal == null) newLocal = this.local.slice()
            insertSorted(newLocal, deco)
          }
        }
      } else if (newChildEnd - newPos != oldChildEnd - oldPos) {
        newChild = new DecorationSet(newChildEnd - newPos, child.size, child.local, child.children)
      }
      if (newChild != child) {
        if (newChildren == null) newChildren = this.children.slice(0, i)
        // If the node's content was completely deleted by mapping,
        // drop the node—which is complicated by the need to
        // distribute its length to another child when it's not the
        // last child
        if (newChild.size == 0 && (newChild.length == 0 || newChildren.length || i == this.children.length)) {
          if (newChild.length > 0 && i > 0) {
            let last = newChildren.length - 1, lastChild = newChildren[last]
            newChildren[last] = new DecorationSet(lastChild.length + newChild.length, lastChild.size, lastChild.local, lastChild.children)
          }
        } else {
          newChildren.push(newChild)
        }
      } else if (newChildren) {
        newChildren.push(newChild)
      }
      newSize += newChild.size
      oldPos = oldChildEnd
      newPos = newChildEnd
    }

    let set = newLength == this.length && newChildren == null && newLocal == null
      ? this
      : new DecorationSet(newLength, newSize + (newLocal || this.local).length,
                          newLocal || this.local, newChildren || this.children)
    return {set, escaped}
  }

  changedRanges(other: DecorationSet, textDiff: A<ChangedRange>): Changes {
    let changes = new Changes
    let oldPos = 0, newPos = 0
    for (let range of textDiff) {
      if (range.fromB > newPos && (this != other || oldPos != newPos))
        new DecorationSetComparison(this, oldPos, other, newPos, range.fromB, changes).run()
      oldPos = range.toA
      newPos = range.toB
    }
    if (oldPos < this.length || newPos < other.length)
      new DecorationSetComparison(this, oldPos, other, newPos, Math.max(this.length - oldPos + newPos, other.length), changes).run()
    return changes
  }

  static of(decorations: Decoration[] | Decoration): DecorationSet {
    let set = DecorationSet.empty
    if (decorations instanceof Decoration) set = set.update([decorations])
    else if (decorations.length) set = set.update(decorations)
    return set
  }

  static empty = new DecorationSet(0, 0, noDecorations, noChildren);
}

class Changes {
  content: number[] = []
  height: number[] = []
}

// Stack element for iterating over a decoration set
class IteratedSet {
  // Index == -1 means the set's locals have not been yielded yet.
  // Otherwise this is an index in the set's child array.
  index: number = 0;
  constructor(public offset: number,
              public set: DecorationSet) {}
}

// Cursor into a node-local set of decorations
class LocalSet {
  public index: number = 0;
  constructor(public offset: number,
              public decorations: A<Decoration>,
              public next: IteratedSet[] | null = null) {}

  // Used to make this conform to Heapable
  get heapPos(): number { return this.decorations[this.index].from + this.offset }
  get desc(): DecorationDesc { return this.decorations[this.index].desc }
}

function iterDecorationSet(stack: IteratedSet[], skipTo: number = 0) {
  for (;;) {
    if (stack.length == 0) break
    let top = stack[stack.length - 1]
    if (top.index == top.set.children.length) {
      stack.pop()
    } else {
      let next = top.set.children[top.index], start = top.offset
      top.index++
      top.offset += next.length
      if (top.offset >= skipTo) {
        stack.push(new IteratedSet(start, next))
        break
      }
    }
  }
}

export function buildLineElements(sets: A<DecorationSet>, from: number, to: number, builder: {
  advance(pos: number): void;
  advanceCollapsed(pos: number): void;
  addWidget(widget: WidgetType<any>, side: number): void;
  active: RangeDesc[];
}, heightOnly: boolean = false /* FIXME silly boolean param */) {
  let heap: Heapable[] = []

  for (let set of sets) if (set.size > 0) {
    addIterToHeap(heap, [new IteratedSet(0, set)], from)
    if (set.local.length) addToHeap(heap, new LocalSet(0, set.local))
  }

  while (heap.length > 0) {
    let next = takeFromHeap(heap)
    if (next instanceof LocalSet) {
      let deco = next.decorations[next.index]
      if (deco.from + next.offset > to) break

      if (deco.to + next.offset >= from) {
        if (deco.desc instanceof RangeDesc && (heightOnly ? deco.desc.spec.collapsed : deco.desc.affectsSpans)) {
          deco = deco.move(next.offset)
          builder.advance(deco.from)
          let collapsed = deco.desc.spec.collapsed
          if (collapsed) {
            if (collapsed instanceof WidgetType) builder.addWidget(collapsed, 0)
            from = deco.to
            builder.advanceCollapsed(Math.min(from, to))
          } else {
            builder.active.push(deco.desc as RangeDesc)
            addToHeap(heap, deco)
          }
        } else if (deco.desc instanceof PointDesc && deco.desc.widget &&
                   (heightOnly ? deco.desc.widget.estimatedHeight > -1 : true)) {
          builder.advance(deco.from)
          builder.addWidget(deco.desc.widget, deco.desc.bias)
        }
      }
      // Put the rest of the set back onto the heap
      if (++next.index < next.decorations.length) addToHeap(heap, next)
      else if (next.next) addIterToHeap(heap, next.next, from)
    } else { // It is a decoration that ends here
      let deco = next as Decoration
      if (deco.to >= to) break
      builder.advance(deco.to)
      builder.active.splice(builder.active.indexOf(deco.desc as RangeDesc), 1)
    }
  }
  builder.advance(to)
}

function compareHeapable(a: Heapable, b: Heapable): number {
  return a.heapPos - b.heapPos || a.desc.bias - b.desc.bias
}

function addIterToHeap(heap: Heapable[], stack: IteratedSet[], skipTo: number = 0) {
  for (;;) {
    iterDecorationSet(stack, skipTo)
    if (stack.length == 0) break
    let next = stack[stack.length - 1], local = next.set.local
    let leaf = next.set.children.length ? null : stack
    if (local.length) addToHeap(heap, new LocalSet(next.offset, local, leaf))
    if (leaf) break
  }
}

interface Heapable { heapPos: number; desc: DecorationDesc }

function addToHeap(heap: Heapable[], elt: Heapable) {
  let index = heap.push(elt) - 1
  while (index > 0) {
    let parentIndex = index >> 1, parent = heap[parentIndex]
    if (compareHeapable(elt, parent) >= 0) break
    heap[index] = parent
    heap[parentIndex] = elt
    index = parentIndex
  }
}

function takeFromHeap(heap: Heapable[]): Heapable {
  let elt = heap[0], replacement = heap.pop()!
  if (heap.length == 0) return elt
  heap[0] = replacement
  for (let index = 0;;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && compareHeapable(child, heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (compareHeapable(replacement, child) < 0) break
    heap[childIndex] = replacement
    heap[index] = child
    index = childIndex
  }
  return elt
}

function byPos(a: Decoration, b: Decoration): number {
  return a.from - b.from || a.desc.bias - b.desc.bias
}

function insertSorted(target: Decoration[], deco: Decoration) {
  let i = target.length
  while (i > 0 && byPos(target[i - 1], deco) >= 0) i--
  target.splice(i, 0, deco)
}

function filterDecorations(decorations: A<Decoration>,
                           filter: DecorationFilter | null,
                           filterFrom: number, filterTo: number,
                           offset: number): Decoration[] | null {
  if (!filter) return null
  let copy: Decoration[] | null = null
  for (let i = 0; i < decorations.length; i++) {
    let deco = decorations[i], from = deco.from + offset, to = deco.to + offset
    if (filterFrom > to || filterTo < from || filter(from, to, deco.spec)) {
      if (copy != null) copy.push(deco)
    } else {
      if (copy == null) copy = decorations.slice(0, i)
    }
  }
  return copy
}

function touchesChange(from: number, to: number, changes: A<Change>): boolean {
  for (let change of changes) {
    if (change.to >= from && change.from <= to) return true
    let diff = change.text.length - (change.to - change.from)
    if (from > change.from) from += diff
    if (to > change.to) to += diff
  }
  return false
}

function collapseSet(children: A<DecorationSet>, local: Decoration[],
                     add: A<Decoration>, start: number, offset: number, length: number): DecorationSet {
  let mustSort = local.length > 0 && add.length > 0, off = 0
  for (let child of children) {
    child.collect(local, -off)
    off += child.length
  }
  for (let added of add) local.push(added.move(-offset))
  if (mustSort) local.sort(byPos)

  return new DecorationSet(length, local.length, local, noChildren)
}

function appendDecorations(local: Decoration[], children: DecorationSet[],
                           decorations: A<Decoration>, start: number,
                           offset: number, length: number, pos: number, childSize: number) {
  // Group added decorations after the current children into new
  // children (will usually only happen when initially creating a
  // node or adding stuff to the top-level node)
  for (let i = start; i < decorations.length;) {
    let add: Decoration[] = []
    let end = Math.min(i + childSize, decorations.length)
    let endPos = end == decorations.length ? offset + length : decorations[end].from
    for (; i < end; i++) {
      let deco = decorations[i]
      if (deco.to > endPos) insertSorted(local, deco.move(-offset))
      else add.push(deco)
    }
    if (add.length) {
      children.push(DecorationSet.empty.updateInner(add, null, 0, 0, pos, endPos - pos))
      pos = endPos
    }
  }
}

// FIXME try to clean this up
function rebalanceChildren(local: Decoration[], children: DecorationSet[], childSize: number) {
  for (let i = 0, off = 0; i < children.length;) {
    let child = children[i], next
    if (child.size == 0 && (i > 0 || children.length == 1)) {
      // Drop empty node
      children.splice(i--, 1)
      if (i >= 0) children[i] = children[i].grow(child.length)
    } else if (child.size > (childSize << 1) && child.local.length < (child.length >> 1)) {
      // Unwrap an overly big node
      for (let deco of child.local) insertSorted(local, deco.move(off))
      children.splice(i, 1, ...child.children)
    } else if (child.children.length == 0 && i < children.length - 1 &&
               (next = children[i + 1]).size + child.size <= BASE_NODE_SIZE &&
               next.children.length == 0) {
      // Join two small leaf nodes
      children.splice(i, 2, new DecorationSet(child.length + next.length,
                                              child.size + next.size,
                                              child.local.concat(next.local.map(d => d.move(child.length))),
                                              noChildren))
      off += child.length + next.length
    } else {
      // Join a number of nodes into a wrapper node
      let joinTo = i + 1, size = child.size, length = child.length
      if (child.size < (childSize >> 1)) {
        for (; joinTo < children.length; joinTo++) {
          let next = children[joinTo], totalSize = size + next.size
          if (totalSize > childSize) break
          size = totalSize
          length += next.length
        }
      }
      if (joinTo > i + 1) {
        let joined = new DecorationSet(length, size, noDecorations, children.slice(i, joinTo))
        let joinedLocals = []
        for (let j = 0; j < local.length; j++) {
          let deco = local[j]
          if (deco.from >= off && deco.to <= off + length) {
            local.splice(j--, 1)
            if (local.length == 0) local = noDecorations as Decoration[]
            joinedLocals.push(deco.move(-off))
          }
        }
        if (joinedLocals.length) joined = joined.update(joinedLocals.sort(byPos))
        children.splice(i, joinTo - i, joined)
        i = joinTo
        off += length
      } else {
        i++
        off += child.length
      }
    }
  }
}

const SIDE_A = 1, SIDE_B = 2

class ComparisonSide {
  heap: LocalSet[] = [];
  active: RangeDesc[] = [];
  widgets: WidgetType<any>[] = [];
  tip: LocalSet | null = null;
  collapsedTo: number = -1;

  constructor(readonly stack: IteratedSet[]) {}

  forward(start: number, next: IteratedSet): boolean {
    let newTip = false
    if (next.set.local.length) {
      let local = new LocalSet(next.offset, next.set.local)
      addToHeap(this.heap, local)
      if (!next.set.children.length) {
        this.tip = local
        newTip = true
      }
    }
    iterDecorationSet(this.stack, start)
    return newTip
  }
}

class DecorationSetComparison {
  a: ComparisonSide;
  b: ComparisonSide;
  pos: number;
  end: number;

  constructor(a: DecorationSet, startA: number,
              b: DecorationSet, startB: number, endB: number,
              readonly changes: Changes) {
    this.a = new ComparisonSide([new IteratedSet(startB - startA, a)])
    this.b = new ComparisonSide([new IteratedSet(0, b)])
    this.pos = startB
    this.end = endB
    this.forwardIter(SIDE_A | SIDE_B)
  }

  forwardIter(side: number) {
    for (; side > 0;) {
      let nextA = this.a.stack.length ? this.a.stack[this.a.stack.length - 1] : null
      let nextB = this.b.stack.length ? this.b.stack[this.b.stack.length - 1] : null
      if (nextA && nextB && nextA.offset == nextB.offset && nextA.set == nextB.set) {
        iterDecorationSet(this.a.stack, this.pos)
        iterDecorationSet(this.b.stack, this.pos)
      } else if (nextA && (!nextB || (nextA.offset < nextB.offset ||
                                      nextA.offset == nextB.offset && (this.a.stack.length == 1 ||
                                                                       nextA.set.length >= nextB.set.length)))) {
        if (this.a.forward(this.pos, nextA)) side = side & ~SIDE_A
      } else if (nextB) {
        if (this.b.forward(this.pos, nextB)) side = side & ~SIDE_B
      } else {
        break
      }
    }
  }

  run() {
    let heapA = this.a.heap, heapB = this.b.heap

    for (;;) {
      if (heapA.length && (!heapB.length || (heapA[0].heapPos - heapB[0].heapPos || heapA[0].desc.bias - heapB[0].desc.bias) < 0)) {
        this.advance(this.a)
      } else if (heapB.length) {
        this.advance(this.b)
      } else {
        if (!compareWidgetSets(this.a.widgets, this.b.widgets)) {
          addRange(this.pos, this.pos, this.changes.content)
          addRange(this.pos, this.pos, this.changes.height)
        }
        break
      }
    }
  }

  advancePos(pos: number) {
    if (pos > this.end) pos = this.end
    if (pos <= this.pos) return
    if (this.a.widgets.length || this.b.widgets.length) {
      if (!compareWidgetSets(this.a.widgets, this.b.widgets)) {
        addRange(pos, pos, this.changes.content)
        addRange(pos, pos, this.changes.height)
      }
      this.a.widgets.length = this.b.widgets.length = 0
    }
    if (!compareActiveSets(this.a.active, this.b.active)) {
      addRange(this.pos, pos, this.changes.content)
      if ((this.a.collapsedTo > this.pos) != (this.b.collapsedTo > this.pos)) addRange(this.pos, pos, this.changes.height)
    }
    this.pos = pos
  }

  advance(side: ComparisonSide) {
    let next = takeFromHeap(side.heap)!
    if (next instanceof LocalSet) {
      let deco = next.decorations[next.index++]
      if (deco.from + next.offset > this.end) {
        side.heap.length = 0
        this.pos = this.end
        return
      }
      // FIXME handle line decoration
      if (deco.desc instanceof RangeDesc && deco.desc.affectsSpans && deco.to + next.offset > this.pos) {
        this.advancePos(deco.from + next.offset)
        deco = deco.move(next.offset)
        let collapsed = deco.desc.spec.collapsed
        if (collapsed) {
          if (collapsed instanceof WidgetType) side.widgets.push(collapsed)
          side.collapsedTo = Math.max(side.collapsedTo, deco.to)
          // Skip regions that are collapsed on both sides
          let collapsedTo = Math.min(this.a.collapsedTo, this.b.collapsedTo)
          if (collapsedTo > this.pos) this.pos = collapsedTo
        }
        // FIXME as optimization, it should be possible to remove it from the other set, if present
        side.active.push(deco.desc as RangeDesc)
        addToHeap(side.heap, deco)
      } else if (deco.desc instanceof PointDesc && deco.desc.widget) {
        this.advancePos(deco.from)
        side.widgets.push(deco.desc.widget)
      }
      if (next.index < next.decorations.length) addToHeap(side.heap, next)
      else if (next == this.a.tip) this.forwardIter(SIDE_A)
      else if (next == this.b.tip) this.forwardIter(SIDE_B)
    } else {
      let deco = next as Decoration
      this.advancePos(deco.to)
      remove(side.active, deco.desc)
    }
  }
}

function compareActiveSets(active: RangeDesc[], otherActive: RangeDesc[]): boolean {
  if (active.length != otherActive.length) return false
  outer: for (let desc of active) {
    if (otherActive.indexOf(desc) > -1) continue
    for (let other of otherActive) if (desc.eq(other)) continue outer
    return false
  }
  return true
}

function compareWidgetSets(widgets: WidgetType<any>[], otherWidgets: WidgetType<any>[]): boolean {
  if (widgets.length != otherWidgets.length) return false
  outer: for (let widget of widgets) {
    if (otherWidgets.indexOf(widget) > -1) continue
    for (let other of otherWidgets) if (widget.compare(other)) continue outer
    return false
  }
  return true
}

function remove<T>(array: T[], elt: T) {
  let found = array.indexOf(elt)
  let last = array.pop()!
  if (found != array.length) array[found] = last
}

export function attrsEq(a: any, b: any): boolean {
  if (a == b) return true
  if (!a || !b) return false
  let keysA = Object.keys(a), keysB = Object.keys(b)
  if (keysA.length != keysB.length) return false
  for (let key of keysA) {
    if (keysB.indexOf(key) == -1 || a[key] !== b[key]) return false
  }
  return true
}

const MIN_RANGE_GAP = 4

function addRange(from: number, to: number, ranges: number[]) {
  if (ranges[ranges.length - 1] + MIN_RANGE_GAP > from) ranges[ranges.length - 1] = to
  else ranges.push(from, to)
}

export function joinRanges(a: number[], b: number[]): number[] {
  if (a.length == 0) return b
  if (b.length == 0) return a
  let result: number[] = []
  for (let iA = 0, iB = 0;;) {
    if (iA < a.length && (iB == b.length || a[iA] < b[iB]))
      addRange(a[iA++], a[iA++], result)
    else if (iB < b.length)
      addRange(b[iB++], b[iB++], result)
    else
      break
  }
  return result
}