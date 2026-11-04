(function (Icinga) {


    var Clustergraph = function (module) {
        this.module = module;
        this.initialize();
        this.module.icinga.logger.debug('Clustergraph module loaded');
    };

    function rgbToHex(rgb) {
        const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) {
            return null;
        }
        const toHex = (n) => ('0' + parseInt(n).toString(16)).slice(-2);
        return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
    }

    function stateColor(node) {
        if (node.state === null || node.state === undefined) return "#dbdbdb"; // unknown host
        if (!node.last_check || node.last_check <= 0) return "#77aaff";        // Pending
        if (node.state === 0) return "#44bb77";                                // Up
        if (node.state === 1) return "#ff5566";                                // Down
        return "#dbdbdb";
    }

    function stateName(node) {
        if (node.state === null || node.state === undefined) return "unknown";
        if (!node.last_check || node.last_check <= 0) return "pending";
        return node.state === 0 ? "up" : "down";
    }

    /**
     * Lay out a directed acyclic graph in columns (parents left, children right).
     *
     * Each node's column is the length of the longest parent chain above it, so a
     * host with several parents always sits to the right of all of them. Rows are
     * ordered with a few barycenter sweeps to reduce crossing edges.
     */
    function layout(nodes, links) {
        const byName = new Map(nodes.map(n => [n.name, n]));
        const parents = new Map(nodes.map(n => [n.name, []]));
        const children = new Map(nodes.map(n => [n.name, []]));
        const indegree = new Map(nodes.map(n => [n.name, 0]));

        links.forEach(l => {
            if (!byName.has(l.source) || !byName.has(l.target)) return;
            children.get(l.source).push(l.target);
            parents.get(l.target).push(l.source);
            indegree.set(l.target, indegree.get(l.target) + 1);
        });

        // Longest-path layering via Kahn's topological sort
        const layer = new Map(nodes.map(n => [n.name, 0]));
        const queue = nodes.filter(n => indegree.get(n.name) === 0).map(n => n.name);
        const seen = new Set();
        while (queue.length) {
            const name = queue.shift();
            seen.add(name);
            children.get(name).forEach(child => {
                layer.set(child, Math.max(layer.get(child), layer.get(name) + 1));
                indegree.set(child, indegree.get(child) - 1);
                if (indegree.get(child) === 0) queue.push(child);
            });
        }
        // Icinga rejects dependency cycles, but don't hang or drop nodes if one slips through
        nodes.forEach(n => {
            if (!seen.has(n.name)) {
                const maxParent = Math.max(-1, ...parents.get(n.name).filter(p => seen.has(p)).map(p => layer.get(p)));
                layer.set(n.name, maxParent + 1);
            }
        });

        const layerCount = Math.max(0, ...layer.values()) + 1;
        const columns = Array.from({length: layerCount}, () => []);
        nodes
            .slice()
            .sort((a, b) => d3.ascending(a.label, b.label))
            .forEach(n => columns[layer.get(n.name)].push(n.name));

        const position = new Map();
        const reindex = () => columns.forEach(col => col.forEach((name, i) => position.set(name, i)));
        reindex();

        const barycenter = (name, neighbours) => {
            const list = neighbours.get(name);
            if (!list.length) return position.get(name);
            return d3.mean(list, n => position.get(n));
        };

        for (let sweep = 0; sweep < 4; sweep++) {
            for (let i = 1; i < layerCount; i++) {
                columns[i].sort((a, b) => barycenter(a, parents) - barycenter(b, parents));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
            for (let i = layerCount - 2; i >= 0; i--) {
                columns[i].sort((a, b) => barycenter(a, children) - barycenter(b, children));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
        }

        return {columns, layer, position, layerCount};
    }

    Clustergraph.prototype = {

        initialize: function () {
            this.module.on('rendered', this.onRenderedContainer);
        },

        chart: function (data) {
            const navigation = document.getElementById("navigation");
            const textColor = (navigation && rgbToHex(getComputedStyle(navigation).getPropertyValue('color').trim())) || "#535353";

            const nodes = data.nodes || [];
            const links = data.links || [];

            if (!nodes.length) {
                const empty = document.createElement('p');
                empty.textContent = 'No hosts found in the "synthetic" host group.';
                return empty;
            }

            const {columns, layerCount} = layout(nodes, links);

            const fontSize = 11;    // about 80% of the original 14px
            const rowHeight = 24;
            const padding = 16;
            const labelOffset = 10; // circle centre to the end of its label (labels sit left of the dot)
            const columnGap = 90;   // space for the edges between dependency levels
            const subColumnGap = 40; // space between the wrapped parts of the rightmost column
            const boxPadX = 6;

            const nodeNames = new Set(nodes.map(n => n.name));
            const validLinks = links.filter(l => nodeNames.has(l.source) && nodeNames.has(l.target));
            const childrenOf = new Map(nodes.map(n => [n.name, []]));
            validLinks.forEach(l => childrenOf.get(l.source).push(l.target));
            const rightmost = new Set(columns[0]);

            // Measure labels so each column leaves room for its text
            const ctx = document.createElement("canvas").getContext("2d");
            const labelWidth = new Map(nodes.map(n => {
                ctx.font = (n.synthetic ? "bold" : "italic") + " " + fontSize + "px sans-serif";
                return [n.name, ctx.measureText(n.label).width];
            }));

            // The rightmost level (hosts with no parents) is usually by far the
            // tallest, so it is wrapped into side-by-side sub-columns no taller
            // than the rest of the graph. Hosts that are parents of the same
            // children form a group, drawn as one box with one exit point.
            const otherMax = Math.max(0, ...columns.slice(1).map(c => c.length));
            const maxRows = layerCount > 1
                ? Math.max(otherMax, 8)
                : Math.max(8, Math.ceil(columns[0].length / 4));

            const groupsByKey = new Map();
            columns[0].forEach(name => {
                const key = childrenOf.get(name).slice().sort().join("\0");
                if (!groupsByKey.has(key)) groupsByKey.set(key, []);
                groupsByKey.get(key).push(name);
            });
            // Groups taller than a sub-column are split into pieces, one box each
            const linkedGroups = [];
            let looseNames = [];
            groupsByKey.forEach((names, key) => {
                names.sort((a, b) => d3.ascending(a, b));
                if (key === "") {
                    looseNames = names;
                    return;
                }
                for (let i = 0; i < names.length; i += maxRows) {
                    linkedGroups.push({names: names.slice(i, i + maxRows), children: key.split("\0")});
                }
            });

            const widest = names => Math.max(0, ...names.map(name => labelWidth.get(name)));
            const rowY = row => padding + row * rowHeight;

            /**
             * Compute the full drawing for a given row order of the left levels
             * (order[i] lists the hosts of level i, for i >= 1): host positions,
             * boxes and edges. Levels keep their columns; only rows change.
             * spread is the cost of putting a rightmost group one sub-column
             * further out, against moving it one row from its children's height.
             * pinned optionally fixes some rightmost groups at {k, start}.
             */
            const place = (order, spread = 1.5, pinned = null) => {
                const coords = new Map();
                let x = padding;

                // Left levels: deepest first, each centred against maxRows
                for (let col = layerCount - 1; col >= 1; col--) {
                    x += widest(order[col]) + labelOffset;
                    const offset = (maxRows - order[col].length) / 2;
                    order[col].forEach((name, i) => coords.set(name, {x, y: rowY(offset + i)}));
                    x += columnGap;
                }

                // Rightmost level: put each group at the height of its children,
                // in whichever sub-column lets it sit closest to that height.
                // Groups are placed in order of that height, so each sub-column
                // fills top to bottom with a blank row between groups.
                linkedGroups.forEach(group => {
                    const meanY = d3.mean(group.children, child => coords.get(child).y);
                    group.desired = (meanY - padding) / rowHeight - (group.names.length - 1) / 2;
                });
                // A sub-column tracks which rows are taken; a group needs its own
                // rows plus a free row above and below to keep boxes apart.
                const subColumns = [];
                const newSub = () => ({taken: new Array(maxRows).fill(false), groups: []});
                const fits = (column, start, size) => {
                    if (start < 0 || start + size > maxRows) return false;
                    for (let r = Math.max(0, start - 1); r <= Math.min(maxRows - 1, start + size); r++) {
                        if (column.taken[r]) return false;
                    }
                    return true;
                };
                const put = (k, group, start) => {
                    while (subColumns.length <= k) subColumns.push(newSub());
                    const column = subColumns[k];
                    for (let r = start; r < start + group.names.length; r++) column.taken[r] = true;
                    column.groups.push({group, start});
                };

                // Groups with a position chosen by the final refinement go first
                const pending = [];
                linkedGroups.forEach(group => {
                    const fixed = pinned && pinned.get(group);
                    if (fixed && fits(subColumns[fixed.k] || newSub(), fixed.start, group.names.length)) {
                        put(fixed.k, group, fixed.start);
                    } else {
                        pending.push(group);
                    }
                });
                pending
                    .sort((a, b) => a.desired - b.desired)
                    .forEach(group => {
                        const size = group.names.length;
                        let best = null;
                        for (let k = 0; k <= subColumns.length; k++) {
                            const column = subColumns[k] || newSub();
                            for (let start = 0; start + size <= maxRows; start++) {
                                if (!fits(column, start, size)) continue;
                                // Further sub-columns mean longer edges across more boxes
                                const cost = Math.abs(start - group.desired) + k * spread;
                                if (!best || cost < best.cost) best = {k, start, cost};
                            }
                        }
                        put(best.k, group, best.start);
                    });
                // Drop sub-columns left empty by pinned positions
                for (let k = subColumns.length - 1; k >= 0; k--) {
                    if (!subColumns[k].groups.length) subColumns.splice(k, 1);
                }
                linkedGroups.forEach(group => group.placed = null);
                subColumns.forEach((column, k) => column.groups.forEach(g => g.group.placed = {k, start: g.start}));

                // Hosts with no children go last, in sub-columns of their own
                for (let i = 0; i < looseNames.length; i += maxRows) {
                    const names = looseNames.slice(i, i + maxRows);
                    subColumns.push({
                        groups: [{
                            group: {names, children: []},
                            start: Math.floor((maxRows - names.length) / 2)
                        }]
                    });
                }

                const boxes = [];
                subColumns.forEach((column, k) => {
                    if (k > 0) x += subColumnGap;
                    x += widest([].concat(...column.groups.map(g => g.group.names))) + labelOffset;
                    column.groups.forEach(({group, start}) => {
                        group.names.forEach((name, i) => coords.set(name, {x, y: rowY(start + i)}));
                        boxes.push({
                            names: group.names,
                            children: group.children,
                            x0: x - labelOffset - widest(group.names) - boxPadX,
                            x1: x + 5 + boxPadX,
                            y0: rowY(start) - rowHeight / 2 + 2,
                            y1: rowY(start + group.names.length - 1) + rowHeight / 2 - 2
                        });
                    });
                });

                // Edges leave from the far (left) end of the parent's label, or from
                // the box of a rightmost group, and run left into the child's dot.
                const edges = validLinks
                    .filter(l => !rightmost.has(l.source))
                    .map(l => {
                        const p = coords.get(l.source);
                        return {
                            source: {x: p.x - labelOffset - labelWidth.get(l.source) - 5, y: p.y},
                            target: coords.get(l.target)
                        };
                    });
                boxes.forEach(box => {
                    const start = {x: box.x0, y: (box.y0 + box.y1) / 2};
                    box.children.forEach(child => edges.push({source: start, target: coords.get(child)}));
                });

                // Where each host's edges start, for ordering its children
                const anchorY = new Map();
                coords.forEach((p, name) => anchorY.set(name, p.y));
                boxes.forEach(box => box.names.forEach(name => anchorY.set(name, (box.y0 + box.y1) / 2)));

                return {coords, boxes, edges, anchorY, width: x + 5 + boxPadX + padding};
            };

            // Count crossing edges, treating each as a straight line (the drawn
            // curves cross in the same places). Edges sharing an end can't cross.
            const crossings = edges => {
                let count = 0;
                const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
                const yAt = (e, x) => e.source.y + (e.target.y - e.source.y) * (x - e.source.x) / (e.target.x - e.source.x);
                for (let i = 0; i < edges.length; i++) {
                    for (let j = i + 1; j < edges.length; j++) {
                        const a = edges[i], b = edges[j];
                        if (same(a.source, b.source) || same(a.target, b.target)) continue;
                        const lo = Math.max(a.target.x, b.target.x);
                        const hi = Math.min(a.source.x, b.source.x);
                        if (hi - lo < 1) continue;
                        if ((yAt(a, lo) - yAt(b, lo)) * (yAt(a, hi) - yAt(b, hi)) < 0) count++;
                    }
                }
                return count;
            };
            // Count edges that run through a box or a host label they don't belong
            // to; that hides text just as badly as a crossing does.
            const obstacleHits = geo => {
                const obstacles = geo.boxes.map(b => ({x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1}));
                geo.coords.forEach((p, name) => {
                    if (rightmost.has(name)) return; // already inside a box
                    obstacles.push({
                        x0: p.x - labelOffset - labelWidth.get(name), x1: p.x + 5,
                        y0: p.y - rowHeight / 2 + 5, y1: p.y + rowHeight / 2 - 5
                    });
                });
                let count = 0;
                geo.edges.forEach(e => {
                    obstacles.forEach(o => {
                        const lo = Math.max(o.x0, e.target.x + 6), hi = Math.min(o.x1, e.source.x - 1);
                        if (hi <= lo) return;
                        const yA = e.source.y + (e.target.y - e.source.y) * (lo - e.source.x) / (e.target.x - e.source.x);
                        const yB = e.source.y + (e.target.y - e.source.y) * (hi - e.source.x) / (e.target.x - e.source.x);
                        if (Math.max(yA, yB) > o.y0 && Math.min(yA, yB) < o.y1) count++;
                    });
                });
                return count;
            };
            // Fewest crossings and hidden labels first; among equals, prefer
            // shorter vertical runs
            const score = geo => (crossings(geo.edges) + obstacleHits(geo)) * 1e6
                + d3.sum(geo.edges, e => Math.abs(e.source.y - e.target.y));

            // Reorder the rows of the left levels to minimise crossings. Hosts never
            // change level, so the left-to-right placement stays as it is.
            const order = columns.map(c => c.slice());
            let bestOrder = order.map(c => c.slice());
            let bestGeo = place(order);
            let bestScore = score(bestGeo);
            const consider = () => {
                const geo = place(order);
                const s = score(geo);
                if (s < bestScore) {
                    bestScore = s;
                    bestGeo = geo;
                    bestOrder = order.map(c => c.slice());
                    return true;
                }
                return false;
            };

            if (layerCount > 1) {
                const parentsOf = new Map(nodes.map(n => [n.name, []]));
                validLinks.forEach(l => parentsOf.get(l.target).push(l.source));
                const sortBy = (col, neighbours) => {
                    const geo = place(order);
                    const key = new Map(order[col].map(name => {
                        const list = neighbours.get(name);
                        const own = geo.coords.get(name).y;
                        return [name, list.length ? d3.mean(list, n => geo.anchorY.get(n)) : own];
                    }));
                    order[col].sort((a, b) => key.get(a) - key.get(b));
                };

                // Barycenter sweeps, alternating towards the parents and the children
                for (let round = 0; round < 8; round++) {
                    for (let col = 1; col < layerCount; col++) sortBy(col, parentsOf);
                    consider();
                    for (let col = layerCount - 1; col >= 1; col--) sortBy(col, childrenOf);
                    consider();
                }

                // Then try swapping neighbours in each level while that still helps
                // (skipped on very large graphs to keep rendering quick)
                order.forEach((c, i) => order[i] = bestOrder[i].slice());
                if (validLinks.length <= 400) {
                    for (let pass = 0, improved = true; improved && pass < 6; pass++) {
                        improved = false;
                        for (let col = 1; col < layerCount; col++) {
                            for (let i = 0; i + 1 < order[col].length; i++) {
                                [order[col][i], order[col][i + 1]] = [order[col][i + 1], order[col][i]];
                                if (consider()) {
                                    improved = true;
                                } else {
                                    [order[col][i], order[col][i + 1]] = [order[col][i + 1], order[col][i]];
                                }
                            }
                        }
                    }
                }
            }

            // Try a few trade-offs for spreading the rightmost groups out
            let bestSpread = 1.5;
            [0.25, 0.75, 3, 6, 12].forEach(spread => {
                const geo = place(bestOrder, spread);
                const s = score(geo);
                if (s < bestScore) {
                    bestScore = s;
                    bestGeo = geo;
                    bestSpread = spread;
                }
            });

            // Finally, try moving each rightmost group to any free spot within a
            // few rows of where it is, in any sub-column, keeping each move that
            // lowers the score (skipped on very large graphs)
            if (linkedGroups.length > 1 && validLinks.length <= 400) {
                // Start from where the current best layout put every group
                place(bestOrder, bestSpread);
                const pinned = new Map(linkedGroups.map(group => [group, group.placed]));
                for (let pass = 0, improved = true; improved && pass < 3; pass++) {
                    improved = false;
                    linkedGroups.forEach(group => {
                        const current = pinned.get(group);
                        const subCount = Math.max(...[...pinned.values()].map(p => p.k)) + 1;
                        let bestMove = null;
                        for (let k = 0; k <= subCount; k++) {
                            for (let start = current.start - 3; start <= current.start + 3; start++) {
                                if (k === current.k && start === current.start) continue;
                                if (start < 0 || start + group.names.length > maxRows) continue;
                                const trial = new Map(pinned).set(group, {k, start});
                                const geo = place(bestOrder, bestSpread, trial);
                                const s = score(geo);
                                if (s < bestScore && (!bestMove || s < bestMove.s)) bestMove = {trial, geo, s};
                            }
                        }
                        if (bestMove) {
                            bestScore = bestMove.s;
                            bestGeo = bestMove.geo;
                            improved = true;
                            // A move can push other groups around; record where all of them ended up
                            place(bestOrder, bestSpread, bestMove.trial);
                            linkedGroups.forEach(g => pinned.set(g, g.placed));
                        }
                    });
                }
            }

            const {coords, boxes, width} = bestGeo;
            const drawnLinks = bestGeo.edges;
            const point = name => coords.get(name);
            // Crop to the rows actually used (placement works on a maxRows grid)
            const ys = [...coords.values()].map(p => p.y)
                .concat(...boxes.map(b => [b.y0 + rowHeight / 2 - 2, b.y1 - rowHeight / 2 + 2]));
            const top = Math.min(...ys) - padding;
            const height = Math.max(...ys) - Math.min(...ys) + padding * 2 + 8;

            // Edges from the outer sub-columns pass behind inner labels, so outline
            // the text in the page background colour to keep it readable.
            let background = null;
            for (let el = document.getElementById("clustergraph-container"); el; el = el.parentElement) {
                const bg = getComputedStyle(el).backgroundColor;
                if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
                    background = bg;
                    break;
                }
            }

            const svg = d3.create("svg")
                .attr("width", width)
                .attr("height", height)
                .attr("viewBox", [0, top, width, height])
                .attr("style", "max-width: 100%; height: auto; font: " + fontSize + "px sans-serif;");

            svg.append("defs").append("marker")
                .attr("id", "clustergraph-arrow")
                .attr("viewBox", "0 -5 10 10")
                .attr("refX", 13)
                .attr("refY", 0)
                .attr("markerWidth", 6)
                .attr("markerHeight", 6)
                .attr("orient", "auto")
                .append("path")
                .attr("d", "M0,-5L10,0L0,5")
                .attr("fill", "#00c3ed");

            // Boxes stay unfilled so an edge from an outer box can be followed
            // across inner ones back to where it starts.
            svg.append("g")
                .attr("fill", "none")
                .attr("stroke", textColor)
                .attr("stroke-opacity", 0.45)
                .attr("stroke-width", 1.2)
                .selectAll("rect")
                .data(boxes)
                .join("rect")
                .attr("x", b => b.x0)
                .attr("y", b => b.y0)
                .attr("width", b => b.x1 - b.x0)
                .attr("height", b => b.y1 - b.y0)
                .attr("rx", 7)
                .attr("ry", 7);

            svg.append("g")
                .attr("fill", "none")
                .attr("stroke", "#00c3ed")
                .attr("stroke-opacity", 0.5)
                .attr("stroke-width", 1.6)
                .selectAll("path")
                .data(drawnLinks)
                .join("path")
                .attr("marker-end", "url(#clustergraph-arrow)")
                .attr("d", d3.linkHorizontal()
                    .x(p => p.x)
                    .y(p => p.y));

            const node = svg.append("g")
                .selectAll("a")
                .data(nodes)
                .join("a")
                .attr("href", d => d.link)
                .attr("transform", d => {
                    const p = point(d.name);
                    return `translate(${p.x},${p.y})`;
                });

            node.append("title")
                .text(d => [
                    d.name,
                    "state: " + stateName(d),
                    d.zone ? "zone: " + d.zone : null,
                    d.synthetic ? null : "not in the synthetic host group"
                ].filter(Boolean).join("\n"));

            node.append("circle")
                .attr("r", 5)
                .attr("fill", d => stateColor(d))
                .attr("stroke", d => d.synthetic ? "none" : textColor)
                .attr("stroke-dasharray", "2,2");

            node.append("text")
                .attr("x", -labelOffset)
                .attr("dy", "0.32em")
                .attr("text-anchor", "end")
                .attr("fill", d => d.synthetic ? stateColor(d) : textColor)
                .attr("opacity", d => d.synthetic ? 1 : 0.6)
                .attr("font-weight", d => d.synthetic ? "bold" : "normal")
                .attr("font-style", d => d.synthetic ? "normal" : "italic")
                .attr("stroke", background || "none")
                .attr("stroke-width", 3)
                .attr("stroke-linejoin", "round")
                .attr("paint-order", "stroke")
                .text(d => d.label);

            return svg.node();
        },


        onRenderedContainer: function (event) {
            const container = document.getElementById('clustergraph-container');
            // in module configuration we don't have a graph, so return peacefully
            if (!container) {
                return;
            }

            fetch(window.location.pathname + "/index/data")
                .then(response => response.json())
                .then(data => {
                    container.replaceChildren(this.chart(data));
                });


        }
    };

    Icinga.availableModules.clustergraph = Clustergraph;

}(Icinga));
