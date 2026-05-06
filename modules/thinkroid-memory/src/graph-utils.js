/**
 * Tarjan's Strongly Connected Components algorithm (iterative).
 * @param {Map<number, number[]>} adjList - adjacency list (nodeId -> [neighborIds])
 * @returns {number[][]} Array of SCCs with size > 1 (actual cycles)
 */
export function tarjanSCC(adjList) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Map();
  const stack = [];
  const sccs = [];

  // Iterative Tarjan using an explicit call stack
  // Each frame: { node, neighborIterator, parent }
  for (const startNode of adjList.keys()) {
    if (indices.has(startNode)) continue;

    // Iterative DFS using a work stack
    // Each entry: [node, neighborIndex]
    const callStack = [[startNode, 0]];
    indices.set(startNode, index);
    lowlinks.set(startNode, index);
    index++;
    stack.push(startNode);
    onStack.set(startNode, true);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const [node, neighborIdx] = frame;
      const neighbors = adjList.get(node) || [];

      if (neighborIdx < neighbors.length) {
        // Advance neighbor index
        frame[1]++;
        const neighbor = neighbors[neighborIdx];

        if (!indices.has(neighbor)) {
          // Tree edge — push new frame
          indices.set(neighbor, index);
          lowlinks.set(neighbor, index);
          index++;
          stack.push(neighbor);
          onStack.set(neighbor, true);
          callStack.push([neighbor, 0]);
        } else if (onStack.get(neighbor)) {
          // Back edge — update lowlink
          lowlinks.set(node, Math.min(lowlinks.get(node), indices.get(neighbor)));
        }
      } else {
        // Done with this node — pop and propagate lowlink to parent
        callStack.pop();

        if (callStack.length > 0) {
          const parentNode = callStack[callStack.length - 1][0];
          lowlinks.set(parentNode, Math.min(lowlinks.get(parentNode), lowlinks.get(node)));
        }

        // If root of an SCC, pop stack to collect SCC
        if (lowlinks.get(node) === indices.get(node)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.set(w, false);
            scc.push(w);
          } while (w !== node);

          // Only include SCCs with more than one node (actual cycles)
          if (scc.length > 1) {
            sccs.push(scc);
          }
        }
      }
    }
  }

  return sccs;
}
