import {Decoration, DecorationSet} from "../src/decoration"
import {Change} from "../../state/src/state"
const ist = require("ist")

function depth(decoSet: DecorationSet): number {
  return 1 + Math.max(0, ...decoSet.children.map(depth))
}
function maxSize(decoSet: DecorationSet): number {
  return Math.max(decoSet.local.length, ...decoSet.children.map(maxSize))
}
function size(decoSet: DecorationSet): number {
  return decoSet.children.reduce((a, b) => a + size(b), decoSet.local.length)
}
function avgSize(decoSet: DecorationSet): number {
  let total = 0, count = 0
  function scan(set: DecorationSet) {
    total += set.local.length + set.children.length
    count++
    set.children.forEach(scan)
  }
  scan(decoSet)
  return total / count
}
function checkSet(decoSet: DecorationSet, offset: number = 0) {
  ist(decoSet.length, 0, ">=")
  ist(size(decoSet), decoSet.size)
  let off = 0
  for (let i = 0; i < decoSet.children.length; i++) {
    let child = decoSet.children[i]
    checkSet(child, offset + off)
    off += child.length
  }
  ist(off, decoSet.length, "<=")
  for (let i = 0; i < decoSet.local.length; i++) {
    let deco = decoSet.local[i]
    if (deco.spec.pos != null) ist(offset + deco.from, deco.spec.pos)
    ist(deco.to, deco.from, ">=")
    ist(deco.from, 0, ">=")
    ist(deco.to, decoSet.length, "<=")
  }
}

function mk(from: number, to: any, spec: any): Decoration {
  if (typeof to != "number") { spec = to; to = from }
  if (typeof spec == "string") spec = {attributes: {[spec]: "y"}}
  return from == to ? Decoration.point(from, spec) : Decoration.range(from, to, spec)
}

let smallDecorations = []
for (let i = 0; i < 5000; i++)
  smallDecorations.push(Decoration.range(i, i + 1 + (i % 4), {pos: i}))
let set0 = DecorationSet.of(smallDecorations)

describe("DecorationSet", () => {
  it("creates a balanced decoration tree", () => {
    let set = DecorationSet.of(smallDecorations.concat([
      Decoration.range(1000, 4000, {pos: 1000}),
      Decoration.range(2000, 3000, {pos: 2000})
    ]))
    ist(set.size, 5002)
    ist(size(set), 5002)
    ist(depth(set), 4, "<")
    ist(maxSize(set), 64, "<=")
    ist(avgSize(set), 24, ">")
    checkSet(set)
  })

  describe("update", () => {
    it("can add decorations to an existing set", () => {
      let set = set0.update([
        Decoration.point(2000, {pos: 2000}),
        Decoration.range(2008, 2200, {pos: 2008})
      ])
      ist(set.size, 5002)
      checkSet(set)
      ist(set.children[0], set0.children[0])
      ist(set.children[set.children.length - 1], set0.children[set0.children.length - 1])
    })

    it("can add a large amount of decorations", () => {
      let set0 = DecorationSet.of([
        Decoration.point(0, {pos: 0}),
        Decoration.point(100, {pos: 100}),
        Decoration.range(2, 4000, {pos: 2}),
        Decoration.point(10000, {pos: 10000})
      ])
      let set = set0.update(smallDecorations)
      ist(set.size, 5004)
      checkSet(set)
    })

    it("can filter decorations", () => {
      let set = set0.update([], from => from >= 2500)
      ist(set.size, 2500)
      checkSet(set)
      ist(set.children[set.children.length - 1], set0.children[set0.children.length - 1])
    })

    it("can filter all over", () => {
      let set = set0.update([], from => (from % 200) >= 100)
      ist(set.size, 2500)
      checkSet(set)
    })

    it("can add and remove in one go", () => {
      let set = set0.update([Decoration.range(25, 30, {pos: 25})], from => from % 1000 > 0)
      ist(set.size, 4996)
      checkSet(set)
    })

    it("collapses the tree when removing almost all decorations", () => {
      let set = set0.update([], from => from == 500 || from == 501)
      ist(set.size, 2)
      ist(depth(set), 1)
    })

    it("doesn't call filter on decorations outside the filter range", () => {
      let called = 0
      set0.update([], () => (called++, true), 2000, 2005)
      ist(called, 10, "<")
    })

    it("reuses unchanged nodes", () => {
      ist(set0.update([], () => true), set0)
    })

    it("creates a sorted set", () => {
      let set = DecorationSet.of([mk(2, 4, "a"), mk(8, 11, "a")])
        .update([mk(3, 9, "b"), mk(16, 17, "b")])
      ist(set.local.map(d => d.from).join(","), "2,3,8,16")
    })
  })

  describe("map", () => {
    type Pos = number | [number, number] | [number, number, any]

    function asRange(pos: Pos): {from: number, to: number} {
      return typeof pos == "number" ? {from: pos, to: pos} : {from: pos[0], to: pos[1]}
    }

    function test(positions: Pos[], changes: [number, number, number][], newPositions: Pos[]) {
      let set = DecorationSet.of(positions.map(pos => {
        let {from, to} = asRange(pos)
        return from == to ? Decoration.point(from, pos[2] || {}) : Decoration.range(from, to, pos[2] || {})
      }))
      let mapped = set.map(changes.map(([from, to, len]) => new Change(from, to, "x".repeat(len))))
      let out = []
      mapped.collect(out, 0)
      ist(JSON.stringify(out.map(d => d.from + "-" + d.to)),
          JSON.stringify(newPositions.map(asRange).map(r => r.from + "-" + r.to)))
    }

    it("can map through changes", () =>
       test([1, 4, 10], [[0, 0, 1], [2, 3, 0], [8, 8, 20]], [2, 4, 30]))

    it("takes inclusivity into account", () =>
       test([[1, 2, {inclusiveStart: true, inclusiveEnd: true}]], [[1, 1, 2], [4, 4, 2]], [[1, 6]]))

    it("uses side to determine mapping of points", () =>
       test([[1, 1, {side: 1}], [1, 1, {side: -1}]], [[1, 1, 2]], [1, 3]))

    it("defaults to exclusive on both sides", () =>
       test([[1, 2]], [[1, 1, 2], [4, 4, 2]], [[3, 4]]))

    it("drops collapsed decorations", () =>
       test([[1, 2]], [[1, 2, 0], [1, 1, 1]], []))

    it("drops decorations in deleted regions", () =>
       test([[1, 2], 3], [[0, 4, 0]], []))

    it("shrinks range decorations", () =>
       test([[2, 4], [2, 8], [6, 8]], [[3, 7, 0]], [[2, 3], [2, 4], [3, 4]]))

    it("leaves point decorations on change boundaries", () =>
       test([2, 4], [[2, 4, 6]], [2, 8]))

    it("adjusts the set tree shape", () => {
      let child0Size = set0.children[0].length, child1Size = set0.children[1].length
      let set = set0.map([new Change(0, 0, "hi"), new Change(child0Size + 3, child0Size + 5, "")])
      ist(set.size, set0.size, "<=")
      ist(set.size, set0.size - 2, ">")
      ist(set.children[0].length, child0Size + 2)
      ist(set.children[1].length, child1Size - 2)
      ist(set.children[2].length, set0.children[2].length)
    })

    it("allows decorations to escape their parent node", () => {
      let deco = []
      for (let i = 0; i < 100; i++)
        deco.push(Decoration.range(i, i + 1, {inclusiveStart: true, inclusiveEnd: true}))
      let set0 = DecorationSet.of(deco), nodeBoundary = set0.children[0].length
      let set = set0.map([new Change(nodeBoundary, nodeBoundary, "hello")])
      ist(set.size, set0.size)
      checkSet(set)
    })

    it("removes collapsed tree nodes", () => {
      let set = set0.map([new Change(0, 6000, "")])
      ist(set.size, 0)
      ist(depth(set), 1)
    })
  })

  describe("changedRanges", () => {
    function test(decos, update, ranges) {
      let deco = Array.isArray(decos) ? DecorationSet.of(decos) : decos
      let newDeco = deco
      let docRanges = []
      if (update.changes) {
        let changes = update.changes.map(([from, to, len]) => new Change(from, to, "x".repeat(len)))
        newDeco = deco.map(changes)
        for (let i = 0, off = 0; i < changes.length; i++) {
          let {from, to, text} = changes[i]
          docRanges.push({fromA: from + off, toA: to + off, fromB: from, toB: from + text.length})
          off += (to - from) - text.length
        }
      }
      if (update.add || update.filter)
        newDeco = newDeco.update(update.add || [], update.filter)
      if (update.prepare) update.prepare(newDeco)
      let found = deco.changedRanges(newDeco, docRanges).content
      ist(JSON.stringify(found), JSON.stringify(ranges))
    }

    it("notices added decorations", () =>
       test([mk(2, 4, "a"), mk(8, 11, "a")], {
         add: [mk(3, 9, "b"), mk(106, 107, "b")]
       }, [3, 9, 106, 107]))

    it("notices deleted decorations", () =>
       test([mk(4, 6, "a"), mk(5, 7, "b"), mk(6, 8, "c"), mk(20, 30, "d")], {
         filter: from => from != 5 && from != 20
       }, [5, 7, 20, 30]))

    it("recognizes identical decorations", () =>
       test([mk(0, 50, "a")], {
         add: [mk(10, 40, "a")],
         filter: () => false
       }, [0, 10, 40, 50]))

    it("skips changes", () =>
       test([mk(0, 20, "a")], {
         changes: [[5, 15, 20]],
         filter: () => false
       }, [0, 5, 25, 30]))

    it("simplifies ranges close to each other", () =>
       test([mk(1, 2, "a"), mk(4, 5, "b")], {
         add: [mk(7, 8, "c"), mk(100, 101, "d")],
         filter: () => false
       }, [1, 8, 100, 101]))

    it("ignores identical sub-nodes", () => {
      let decos = []
      for (let i = 0; i < 1000; i += 2) decos.push(mk(i, i + 1, "a"))
      test(decos, {
        changes: [[900, 1000, 0]],
        add: [mk(850, 860, "b")],
        prepare: set => Object.defineProperty(set.children[0], "local", {get() { throw new Error("NO TOUCH") }})
      }, [850, 860])
    })

    it("ignores collapsed sub-nodes", () => {
      let decos = [mk(3, 997, {collapsed: true})]
      for (let i = 0; i < 1000; i += 2) decos.push(mk(i, i + 1, "a"))
      let set = DecorationSet.of(decos)
      test(set, {
        add: [mk(set.children[0].length + 1, set.children[0].length + 2, "b")],
        prepare: set => Object.defineProperty(set.children[2], "local", {get() { throw new Error("NO TOUCH") }})
      }, [])
    })

    it("ignores changes in collapsed decorations", () => {
      let decos = [mk(3, 997, {collapsed: true})]
      for (let i = 0; i < 1000; i += 2) decos.push(mk(i, i + 1, "a"))
      let set = DecorationSet.of(decos)
      test(set, {
        changes: [[300, 500, 100]]
      }, [])
    })

    it("notices adding a collapsed range", () => {
      test([mk(3, 50, {collapsed: true})], {
        add: [mk(40, 80, {collapsed: true})]
      }, [50, 80])
    })

    it("notices removing a collapsed range", () => {
      test([mk(3, 50, {collapsed: true})], {
        filter: () => false
      }, [3, 50])
    })

    it("can handle multiple changes", () => {
      let decos = []
      for (let i = 0; i < 200; i += 2) {
        let end = i + 1 + Math.ceil(i / 50)
        decos.push(mk(i, end, `${i}-${end}`))
      }
      test(decos, {
        changes: [[0, 0, 50], [100, 150, 0], [150, 200, 0]],
        filter: from => from % 50 > 0
      }, [50, 51, 100, 103, 150, 153])
    })
  })
})