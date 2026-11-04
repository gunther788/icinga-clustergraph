(function (Icinga) {


    var Topologygraph = function (module) {
        this.module = module;
        this.initialize();
        this.module.icinga.logger.debug('Topologygraph module loaded');
    };

    function rgbToHex(rgb) {
        const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) {
            return null;
        }
        const toHex = (n) => ('0' + parseInt(n).toString(16)).slice(-2);
        return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
    }

    // Colours as Icinga Web uses them
    const COLOURS = {
        up: "#44bb77",
        down: "#ff5566",
        unreachable: "#aa44ff",
        pending: "#77aaff",
        unknownHost: "#dbdbdb",
        warning: "#ffaa44",
        critical: "#ff5566",
        unknown: "#aa44ff",
        edge: "#00c3ed"
    };

    function stateName(node) {
        if (node.state === null || node.state === undefined) return "unknown";
        if (!node.last_check || node.last_check <= 0) return "pending";
        if (node.state === 0) return "up";
        // Down only because a parent is down
        return node.reachable === false ? "unreachable" : "down";
    }

    function stateColor(node) {
        switch (stateName(node)) {
            case "up": return COLOURS.up;
            case "down": return COLOURS.down;
            case "unreachable": return COLOURS.unreachable;
            case "pending": return COLOURS.pending;
            default: return COLOURS.unknownHost;
        }
    }

    // A host problem (down or unreachable)
    function isProblem(node) {
        const state = stateName(node);
        return state === "down" || state === "unreachable";
    }

    // A problem someone already knows about: acknowledged or in downtime
    function isHandled(node) {
        return isProblem(node) && !!(node.acknowledged || node.in_downtime);
    }

    // One line describing a host's services for the hover text; notifiedOnly
    // when services with notifications disabled are left out
    function servicesText(services, notifiedOnly) {
        const what = notifiedOnly ? "services with notifications" : "services";
        if (services === null || services === undefined) return "services: not available";
        if (!services.total) return what + ": none";
        const parts = ["critical", "warning", "unknown", "pending"]
            .filter(state => services[state])
            .map(state => services[state] + " " + state);
        const problems = services.critical + services.warning + services.unknown;
        if (problems > services.unhandled) parts.push((problems - services.unhandled) + " handled");
        return what + ": " + services.total + (parts.length ? " (" + parts.join(", ") + ")" : ", all OK");
    }

    // How often to fetch fresh host states while the page is visible, unless
    // the server says otherwise (the module's "Refresh interval" setting)
    const REFRESH_MS = 15000;
    const refreshInterval = data => data && data.refresh >= 5 ? data.refresh * 1000 : REFRESH_MS;

    /**
     * Everything that affects the layout (hosts, their labels and group
     * membership, and the dependencies), but not host states. If this is
     * unchanged, a refresh only needs to recolour the existing drawing.
     */
    function structureOf(data) {
        const nodes = (data.nodes || []).map(n => [n.name, n.label, !!n.synthetic, n.link]).sort();
        const links = (data.links || []).map(l => [l.source, l.target]).sort();
        return JSON.stringify([nodes, links]);
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

    // Drawing constants. BASE spacing is the tightest layout; it is widened to
    // fill the window when there is room (see computeLayout).
    const FONT_SIZE = 12;
    const BASE = {rowHeight: 24, columnGap: 90, subColumnGap: 40};
    const PADDING = 16;
    const LABEL_OFFSET = 10; // circle centre to the end of its label (labels sit left of the dot)
    const BOX_PAD_X = 6;

    /**
     * Place a column of hosts (in this order) as close as possible to their
     * target heights, keeping at least `gap` between neighbours: least squares
     * under the ordering constraint, solved by pool-adjacent-violators on
     * y[i] - i * gap. The result is shifted to stay within [lo, hi] if it can.
     */
    function alignColumn(targets, gap, lo, hi) {
        const blocks = [];
        targets.forEach((t, i) => {
            blocks.push({sum: t - i * gap, count: 1});
            while (blocks.length > 1) {
                const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
                if (a.sum / a.count <= b.sum / b.count) break;
                blocks.pop();
                a.sum += b.sum;
                a.count += b.count;
            }
        });
        const ys = [];
        blocks.forEach(b => {
            for (let k = 0; k < b.count; k++) ys.push(b.sum / b.count + ys.length * gap);
        });
        if (!ys.length) return ys;
        let shift = 0;
        if (ys[0] < lo) shift = lo - ys[0];
        else if (ys[ys.length - 1] > hi) shift = Math.max(lo - ys[0], hi - ys[ys.length - 1]);
        return ys.map(y => y + shift);
    }

    /**
     * Lay out the graph for a viewport of size avail ({width, height}).
     *
     * Hosts keep their dependency level (column). The rightmost level (hosts
     * with no parents) is wrapped into side-by-side sub-columns, with hosts that
     * are parents of the same children kept together as one boxed group. The
     * height of those sub-columns is chosen so the diagram's shape matches the
     * viewport's, then rows are ordered to minimise crossing arrows, and finally
     * the gaps are widened so the diagram fills the viewport at 100%.
     *
     * Returns {coords, boxes, edges, width, height, top}.
     */
    function computeLayout(nodes, links, avail) {
        const {columns, layerCount} = layout(nodes, links);

        const nodeNames = new Set(nodes.map(n => n.name));
        const validLinks = links.filter(l => nodeNames.has(l.source) && nodeNames.has(l.target));
        const childrenOf = new Map(nodes.map(n => [n.name, []]));
        const parentsOf = new Map(nodes.map(n => [n.name, []]));
        validLinks.forEach(l => {
            childrenOf.get(l.source).push(l.target);
            parentsOf.get(l.target).push(l.source);
        });
        const rightmost = new Set(columns[0]);

        // Measure labels so each column leaves room for its text
        const ctx = document.createElement("canvas").getContext("2d");
        const labelWidth = new Map(nodes.map(n => {
            ctx.font = (n.synthetic ? "bold" : "italic") + " " + FONT_SIZE + "px sans-serif";
            return [n.name, ctx.measureText(n.label).width];
        }));
        const widest = names => Math.max(0, ...names.map(name => labelWidth.get(name)));

        // Rightmost hosts grouped by their exact set of children
        const groupsByKey = new Map();
        columns[0].forEach(name => {
            const key = childrenOf.get(name).slice().sort().join("\0");
            if (!groupsByKey.has(key)) groupsByKey.set(key, []);
            groupsByKey.get(key).push(name);
        });
        const rawGroups = [];
        let looseNames = [];
        groupsByKey.forEach((names, key) => {
            names.sort((a, b) => d3.ascending(a, b));
            if (key === "") {
                looseNames = names;
            } else {
                rawGroups.push({names, children: key.split("\0")});
            }
        });

        // Choose the height of the rightmost sub-columns (in rows). Estimate the
        // diagram's size for each candidate and take the one that shows it
        // largest (up to 100%) in the viewport; among those that fit at 100%,
        // the one whose shape is closest to the viewport's.
        const otherMax = Math.max(0, ...columns.slice(1).map(c => c.length));
        let leftWidth = 0;
        for (let col = layerCount - 1; col >= 1; col--) {
            leftWidth += widest(columns[col]) + LABEL_OFFSET + BASE.columnGap;
        }
        const estimate = rows => {
            const subs = [];
            let current = null;
            rawGroups.forEach(group => {
                for (let i = 0; i < group.names.length; i += rows) {
                    const piece = group.names.slice(i, i + rows);
                    const need = (current && current.used ? 1 : 0) + piece.length;
                    if (!current || current.used + need > rows) {
                        current = {used: 0, names: []};
                        subs.push(current);
                    }
                    current.used += current.used ? 1 + piece.length : piece.length;
                    current.names.push(...piece);
                }
            });
            for (let i = 0; i < looseNames.length; i += rows) {
                const chunk = looseNames.slice(i, i + rows);
                subs.push({used: chunk.length, names: chunk});
            }
            const rightWidth = d3.sum(subs, s => widest(s.names) + LABEL_OFFSET)
                + Math.max(0, subs.length - 1) * BASE.subColumnGap;
            const usedRows = Math.max(otherMax, ...subs.map(s => s.used));
            return {
                linkedSubColumns: subs.length - Math.ceil(looseNames.length / rows),
                width: PADDING + leftWidth + rightWidth + 5 + BOX_PAD_X + PADDING,
                height: 2 * PADDING + Math.max(0, usedRows - 1) * BASE.rowHeight + 8
            };
        };
        const neededRows = d3.sum(rawGroups, g => g.names.length) + Math.max(0, rawGroups.length - 1);
        const lowest = Math.max(layerCount > 1 ? otherMax : 1, 2);
        const highest = Math.min(Math.max(lowest, neededRows, looseNames.length), lowest + 400);
        let maxRows = lowest;
        if (avail && avail.width > 0 && avail.height > 0) {
            const targetAspect = avail.width / avail.height;
            let best = null;
            for (let rows = lowest; rows <= highest; rows++) {
                const e = estimate(rows);
                const scale = Math.min(1, avail.width / e.width, avail.height / e.height);
                const aspectError = Math.abs(Math.log((e.width / e.height) / targetAspect));
                if (!best || scale > best.scale + 1e-6
                    || (Math.abs(scale - best.scale) <= 1e-6 && aspectError < best.aspectError)) {
                    best = {rows, scale, aspectError};
                }
            }
            maxRows = best.rows;
        } else {
            maxRows = layerCount > 1 ? Math.max(otherMax, 8) : Math.max(8, Math.ceil(columns[0].length / 4));
        }
        // Keep to the planned number of sub-columns so the diagram keeps the
        // chosen shape; a group may only open another if it fits nowhere else
        const subColumnLimit = Math.max(1, estimate(maxRows).linkedSubColumns);

        // Groups taller than a sub-column are split into pieces, one box each
        const linkedGroups = [];
        rawGroups.forEach(group => {
            for (let i = 0; i < group.names.length; i += maxRows) {
                linkedGroups.push({names: group.names.slice(i, i + maxRows), children: group.children});
            }
        });

        /**
         * Compute the full drawing for a given row order of the left levels
         * (order[i] lists the hosts of level i, for i >= 1): host positions,
         * boxes and edges. Levels keep their columns; only rows change.
         * spread is the cost of putting a rightmost group one sub-column
         * further out, against moving it one row from its children's height.
         * pinned optionally fixes some rightmost groups at {k, start}.
         * sp is the spacing ({rowHeight, columnGap, subColumnGap}).
         */
        const place = (order, spread = 1.5, pinned = null, sp = BASE) => {
            const rowY = row => PADDING + row * sp.rowHeight;
            const coords = new Map();
            let x = PADDING;

            // Left levels: deepest first, each starting centred against maxRows
            for (let col = layerCount - 1; col >= 1; col--) {
                x += widest(order[col]) + LABEL_OFFSET;
                const offset = (maxRows - order[col].length) / 2;
                order[col].forEach((name, i) => coords.set(name, {x, y: rowY(offset + i)}));
                x += sp.columnGap;
            }

            // Keep arrows horizontal: move each left host towards the (median)
            // height of the hosts it connects to (anchorOf gives where a
            // neighbour's arrows start or end), keeping the row order and at
            // least one row between hosts. Alternate directions a few times so
            // alignment can travel along chains.
            const alignLeft = (anchorOf, rounds) => {
                const lo = rowY(0), hi = rowY(maxRows - 1);
                const target = name => {
                    const ys = parentsOf.get(name).concat(childrenOf.get(name))
                        .map(anchorOf).filter(y => y !== undefined);
                    // Line the host up exactly with one neighbour: the median, or
                    // with an even count whichever middle value is nearer to where
                    // the host is now (an average would slope all of its arrows)
                    const own = coords.get(name).y;
                    if (!ys.length) return own;
                    ys.sort((a, b) => a - b);
                    const mid = ys.length >> 1;
                    if (ys.length % 2) return ys[mid];
                    return Math.abs(ys[mid - 1] - own) <= Math.abs(ys[mid] - own) ? ys[mid - 1] : ys[mid];
                };
                const alignOne = col => {
                    const ys = alignColumn(order[col].map(target), sp.rowHeight, lo, hi);
                    order[col].forEach((name, i) => coords.get(name).y = ys[i]);
                };
                for (let round = 0; round < rounds; round++) {
                    for (let col = 1; col < layerCount; col++) alignOne(col);
                    for (let col = layerCount - 1; col >= 1; col--) alignOne(col);
                }
            };
            // First among the left levels only (rightmost groups aren't placed yet)
            alignLeft(name => rightmost.has(name) ? undefined : coords.get(name).y, 3);

            // Rightmost level: put each group at the height of its children,
            // in whichever sub-column lets it sit closest to that height
            linkedGroups.forEach(group => {
                const meanY = d3.mean(group.children, child => coords.get(child).y);
                group.desired = (meanY - PADDING) / sp.rowHeight - (group.names.length - 1) / 2;
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
                    const search = limit => {
                        let best = null;
                        for (let k = 0; k <= Math.min(subColumns.length, limit - 1); k++) {
                            const column = subColumns[k] || newSub();
                            for (let start = 0; start + size <= maxRows; start++) {
                                if (!fits(column, start, size)) continue;
                                // Further sub-columns mean longer edges across more boxes
                                const cost = Math.abs(start - group.desired) + k * spread;
                                if (!best || cost < best.cost) best = {k, start, cost};
                            }
                        }
                        return best;
                    };
                    const best = search(subColumnLimit) || search(Infinity);
                    put(best.k, group, best.start);
                });
            // Drop sub-columns left empty by pinned positions
            for (let k = subColumns.length - 1; k >= 0; k--) {
                if (!subColumns[k].groups.length) subColumns.splice(k, 1);
            }
            linkedGroups.forEach(group => group.placed = null);
            subColumns.forEach((column, k) => column.groups.forEach(g => g.group.placed = {k, start: g.start}));

            // Then line the left levels up with the boxes that now point at them
            // (a box's arrows leave from its middle)
            // (a box's arrows leave from its middle). Boxes sit on the row grid;
            // first let each one slide up to 0.4 of a row towards the median
            // height of its children, so a single arrow can come out level. The
            // blank row between boxes keeps them apart.
            const boxMiddle = new Map();
            subColumns.forEach(column => column.groups.forEach(placedGroup => {
                const {group, start} = placedGroup;
                const middle = rowY(start + (group.names.length - 1) / 2);
                const want = d3.median(group.children, child => coords.get(child).y);
                const limit = 0.4 * sp.rowHeight;
                placedGroup.offset = Math.max(-limit, Math.min(limit, want - middle));
                group.names.forEach(name => boxMiddle.set(name, middle + placedGroup.offset));
            }));
            alignLeft(name => rightmost.has(name) ? boxMiddle.get(name) : coords.get(name).y, 2);

            // Hosts with no children go last, in sub-columns of their own
            for (let i = 0; i < looseNames.length; i += maxRows) {
                const names = looseNames.slice(i, i + maxRows);
                subColumns.push({
                    groups: [{group: {names, children: []}, start: Math.floor((maxRows - names.length) / 2)}]
                });
            }

            const boxes = [];
            subColumns.forEach((column, k) => {
                if (k > 0) x += sp.subColumnGap;
                x += widest([].concat(...column.groups.map(g => g.group.names))) + LABEL_OFFSET;
                column.groups.forEach(({group, start, offset = 0}) => {
                    group.names.forEach((name, i) => coords.set(name, {x, y: rowY(start + i) + offset}));
                    boxes.push({
                        names: group.names,
                        children: group.children,
                        x0: x - LABEL_OFFSET - widest(group.names) - BOX_PAD_X,
                        x1: x + 5 + BOX_PAD_X,
                        y0: rowY(start) + offset - BASE.rowHeight / 2 + 2,
                        y1: rowY(start + group.names.length - 1) + offset + BASE.rowHeight / 2 - 2
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
                        source: {x: p.x - LABEL_OFFSET - labelWidth.get(l.source) - 5, y: p.y},
                        target: coords.get(l.target),
                        child: l.target,
                        parents: [l.source]
                    };
                });
            boxes.forEach(box => {
                const start = {x: box.x0, y: (box.y0 + box.y1) / 2};
                box.children.forEach(child => edges.push({
                    source: start, target: coords.get(child), child, parents: box.names
                }));
            });

            // Where each host's edges start, for ordering its children
            const anchorY = new Map();
            coords.forEach((p, name) => anchorY.set(name, p.y));
            boxes.forEach(box => box.names.forEach(name => anchorY.set(name, (box.y0 + box.y1) / 2)));

            return {
                coords, boxes, edges, anchorY,
                subColumnCount: subColumns.length,
                width: x + 5 + BOX_PAD_X + PADDING
            };
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
                    x0: p.x - LABEL_OFFSET - labelWidth.get(name), x1: p.x + 5,
                    y0: p.y - BASE.rowHeight / 2 + 5, y1: p.y + BASE.rowHeight / 2 - 5
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
        let bestSpread = 1.5;
        let bestPinned = null;
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
        [0.25, 0.75, 3, 6, 12].forEach(spread => {
            const geo = place(bestOrder, spread);
            const s = score(geo);
            if (s < bestScore) {
                bestScore = s;
                bestGeo = geo;
                bestSpread = spread;
            }
        });

        // Then try moving each rightmost group to any free spot within a few
        // rows of where it is, in any sub-column, keeping each move that lowers
        // the score (skipped on very large graphs)
        if (linkedGroups.length > 1 && validLinks.length <= 400) {
            place(bestOrder, bestSpread);
            const pinned = new Map(linkedGroups.map(group => [group, group.placed]));
            for (let pass = 0, improved = true; improved && pass < 3; pass++) {
                improved = false;
                linkedGroups.forEach(group => {
                    const current = pinned.get(group);
                    const subCount = Math.max(...[...pinned.values()].map(p => p.k)) + 1;
                    let bestMove = null;
                    for (let k = 0; k < Math.max(subCount, subColumnLimit); k++) {
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
                        bestPinned = bestMove.trial;
                        improved = true;
                        // A move can push other groups around; record where all of them ended up
                        place(bestOrder, bestSpread, bestMove.trial);
                        linkedGroups.forEach(g => pinned.set(g, g.placed));
                    }
                });
            }
        }

        // Size of a layout, cropped to the rows actually used
        const extent = geo => {
            const ys = [...geo.coords.values()].map(p => p.y);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            return {top: minY - PADDING, height: maxY - minY + 2 * PADDING + 8, rows: maxY - minY};
        };

        // Spread out a little where there is room, so arrows between levels
        // and rows aren't cramped, but keep it compact: the lists of boxes in
        // the rightmost level stay at their normal distance, rows stretch to at
        // most 1.25x and the gaps between levels to at most 1.75x. On a large
        // screen the rest is left as margin around the (centred) diagram
        // rather than pulling the lists apart.
        let geo = bestGeo;
        if (avail && avail.width > 0 && avail.height > 0) {
            const sp = Object.assign({}, BASE);
            const levelGaps = (layerCount - 1) * BASE.columnGap;
            const extraWidth = avail.width - geo.width;
            if (extraWidth > 0 && levelGaps > 0) {
                sp.columnGap = BASE.columnGap * Math.min(1.75, 1 + extraWidth / levelGaps);
            }
            const size = extent(geo);
            const rowSteps = size.rows / BASE.rowHeight;
            const extraHeight = avail.height - size.height;
            if (extraHeight > 0 && rowSteps >= 1) {
                sp.rowHeight = Math.min(1.25 * BASE.rowHeight, BASE.rowHeight + extraHeight / rowSteps);
            }
            geo = place(bestOrder, bestSpread, bestPinned, sp);
        }

        const size = extent(geo);
        return {coords: geo.coords, boxes: geo.boxes, edges: geo.edges, width: geo.width, height: size.height, top: size.top};
    }

    /**
     * Hosts without children, for the subset picker, sorted by label.
     */
    function hostsWithoutChildren(data) {
        const nodes = data.nodes || [];
        const names = new Set(nodes.map(n => n.name));
        const hasChildren = new Set((data.links || [])
            .filter(l => names.has(l.source) && names.has(l.target))
            .map(l => l.source));
        return nodes
            .filter(n => !hasChildren.has(n.name))
            .sort((a, b) => d3.ascending(a.label, b.label));
    }

    /**
     * The part of the graph above some hosts: those hosts, their parents,
     * their parents' parents and so on, with the dependencies between them.
     */
    function subsetAbove(data, names) {
        const parentsOf = new Map();
        (data.links || []).forEach(l => {
            if (!parentsOf.has(l.target)) parentsOf.set(l.target, []);
            parentsOf.get(l.target).push(l.source);
        });
        const keep = new Set(names);
        const queue = [...names];
        while (queue.length) {
            (parentsOf.get(queue.shift()) || []).forEach(parent => {
                if (!keep.has(parent)) {
                    keep.add(parent);
                    queue.push(parent);
                }
            });
        }
        return {
            nodes: (data.nodes || []).filter(n => keep.has(n.name)),
            links: (data.links || []).filter(l => keep.has(l.source) && keep.has(l.target))
        };
    }

    // What is shown lives in the page URL, so it can be bookmarked or shared:
    // ?host=a&host=b for a subset, and ?services=notified to leave out services
    // with notifications disabled
    const readUrlState = () => {
        const params = new URLSearchParams(window.location.search);
        return {hosts: params.getAll("host"), notifiedOnly: params.get("services") === "notified"};
    };
    const writeUrlState = (state, container) => {
        const url = new URL(window.location.href);
        // Always written in the same order: hosts first, then the option
        url.searchParams.delete("host");
        url.searchParams.delete("services");
        state.hosts.forEach(name => url.searchParams.append("host", name));
        if (state.notifiedOnly) url.searchParams.append("services", "notified");
        if (url.href !== window.location.href) {
            // Replace rather than push: Icinga keeps its own history entries,
            // and its state object is kept as it is
            window.history.replaceState(window.history.state, "", url.href);
        }
        // Icinga reloads a column from its data-icinga-url; keep that in step
        const column = container.closest("[data-icinga-url]");
        if (column && column.getAttribute("data-icinga-url") !== url.pathname + url.search) {
            column.setAttribute("data-icinga-url", url.pathname + url.search);
        }
    };

    Topologygraph.prototype = {

        initialize: function () {
            this.module.on('rendered', this.onRenderedContainer);
        },

        onRenderedContainer: function (event) {
            const container = document.getElementById('topologygraph-container');
            // in module configuration we don't have a graph, so return peacefully
            if (!container) {
                return;
            }

            const url = window.location.pathname + "/index/data";
            const load = () => fetch(url, {cache: "no-store", headers: {Accept: "application/json"}})
                .then(response => {
                    if (!response.ok) throw new Error("HTTP " + response.status);
                    return response.json();
                });
            const time = () => new Date().toLocaleTimeString();

            // Only one refresh loop at a time, even if Icinga renders us again
            if (this.stopRefresh) this.stopRefresh();

            load().then(data => {
                const graph = this.mount(container);
                graph.setData(data);
                graph.setStatus("Updated " + time());

                let busy = false;
                let timer = null;
                const stop = () => {
                    clearInterval(timer);
                    document.removeEventListener("visibilitychange", onVisible);
                    if (this.stopRefresh === stop) this.stopRefresh = null;
                };
                const refresh = () => {
                    if (!graph.isConnected()) {
                        stop(); // navigated away
                        return;
                    }
                    if (document.hidden || busy) return;
                    busy = true;
                    load().then(fresh => {
                        if (!graph.isConnected()) return;
                        graph.setData(fresh);
                        graph.setStatus("Updated " + time());
                        // Follow a changed refresh interval setting
                        if (refreshInterval(fresh) !== interval) {
                            interval = refreshInterval(fresh);
                            clearInterval(timer);
                            timer = setInterval(refresh, interval);
                        }
                    }).catch(() => {
                        if (graph.isConnected()) graph.setStatus("Update failed, retrying");
                    }).finally(() => { busy = false; });
                };
                // Catch up straight away when the tab becomes visible again
                const onVisible = () => { if (!document.hidden) refresh(); };
                document.addEventListener("visibilitychange", onVisible);
                let interval = refreshInterval(data);
                timer = setInterval(refresh, interval);
                this.stopRefresh = stop;
            }).catch(error => {
                const message = document.createElement("p");
                message.textContent = "Could not load the graph (" + error.message + "). Reload the page to try again.";
                container.replaceChildren(message);
            });
        },

        /**
         * Build the zoomable viewport in container and return an API to feed it
         * data: {setData(data), setStatus(text), isConnected()}.
         *
         * The viewport fills the browser window below its top edge, reaching
         * into the surrounding padding so there is no border around it. The
         * graph is laid out to match the viewport's shape and re-laid out when
         * the viewport changes size (unless the user has zoomed or panned),
         * when entering or leaving full screen, and when the shown subset or
         * the hosts and dependencies change. State-only changes recolour the
         * drawing in place.
         *
         * Controls: a picker to show only one bottom-level host and everything
         * above it, zoom in/out, fit, 100% and full screen. Scroll (or pinch) to
         * zoom around the pointer, drag to move; Shift + scroll also moves the
         * diagram.
         */
        mount: function (container) {
            const navigation = document.getElementById("navigation");
            const textColor = (navigation && rgbToHex(getComputedStyle(navigation).getPropertyValue('color').trim())) || "#535353";

            // Labels get an outline in the page background colour so arrows
            // passing behind them don't hide the text
            let background = null;
            for (let el = container; el; el = el.parentElement) {
                const bg = getComputedStyle(el).backgroundColor;
                if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
                    background = bg;
                    break;
                }
            }


            const viewport = document.createElement("div");
            viewport.className = "topologygraph-viewport";
            if (background) viewport.style.backgroundColor = background;

            const svg = d3.select(viewport).append("svg")
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("style", "display: block; touch-action: none; font: " + FONT_SIZE + "px sans-serif;");
            const defs = svg.append("defs");
            // One arrowhead per arrow colour
            const arrowColours = [COLOURS.edge, COLOURS.down, COLOURS.unreachable];
            const markerFor = colour => "url(#topologygraph-arrow-" + arrowColours.indexOf(colour) + ")";
            arrowColours.forEach((colour, i) => {
                const id = "topologygraph-arrow-" + i;
                defs.append("marker")
                    .attr("id", id)
                    .attr("viewBox", "0 -5 10 10")
                    .attr("refX", 13)
                    .attr("refY", 0)
                    .attr("markerWidth", 6)
                    .attr("markerHeight", 6)
                    .attr("orient", "auto")
                    .append("path")
                    .attr("d", "M0,-5L10,0L0,5")
                    .attr("fill", colour);
            });
            // zoomLayer carries the zoom/pan transform; content shifts the drawing
            // so its cropped top edge sits at y = 0
            const zoomLayer = svg.append("g");
            const content = zoomLayer.append("g");

            const emptyMessage = document.createElement("p");
            emptyMessage.className = "topologygraph-empty";
            emptyMessage.hidden = true;
            viewport.append(emptyMessage);

            // Size of the current drawing, and whether the user has taken over the view
            let width = 1, height = 1;
            let userMoved = false;

            const zoom = d3.zoom()
                .scaleExtent([0.1, 4])
                // The wheel zooms around the pointer; with Shift held it moves the
                // diagram instead (see wheel.pan below)
                .filter(event => event.type === "wheel" ? !event.shiftKey : !event.button)
                // Gentle steps for a mouse wheel; trackpad pinches send small
                // deltas, so those get boosted to feel natural
                .wheelDelta(event => {
                    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode ? 100 : 1);
                    return -delta * 0.002 * (Math.abs(delta) < 40 ? 5 : 1);
                })
                .on("zoom", event => {
                    zoomLayer.attr("transform", event.transform);
                    if (event.sourceEvent) userMoved = true;
                });
            svg.call(zoom).on("dblclick.zoom", null);

            // Shift + scroll moves the diagram. Some browsers turn Shift + wheel
            // into a sideways scroll (deltaX), so take whichever is set and move
            // vertically for deltaY and sideways for deltaX.
            svg.on("wheel.pan", event => {
                if (!event.shiftKey) return;
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
                const dx = event.deltaX * unit;
                const dy = event.deltaY * unit;
                const before = d3.zoomTransform(svg.node());
                zoom.translateBy(svg, -dx / before.k, -dy / before.k);
                const after = d3.zoomTransform(svg.node());
                // Only keep the scroll if the diagram actually moved; at its edges
                // the page scrolls instead
                if (Math.abs(after.x - before.x) > 0.5 || Math.abs(after.y - before.y) > 0.5) {
                    userMoved = true;
                    event.preventDefault();
                }
            }, {passive: false});

            // Bands kept clear for the controls (top) and the hint (bottom), so
            // the fitted diagram never sits underneath them
            const reservedTop = 34, reservedBottom = 18;
            const drawingArea = () => ({
                width: viewport.clientWidth,
                height: Math.max(0, viewport.clientHeight - reservedTop - reservedBottom)
            });

            const fit = animate => {
                const area = drawingArea();
                if (!area.width || !area.height) return;
                const k = Math.min(area.width / width, area.height / height, 1);
                const t = d3.zoomIdentity
                    .translate((area.width - width * k) / 2, reservedTop + (area.height - height * k) / 2)
                    .scale(k);
                (animate ? svg.transition().duration(250) : svg).call(zoom.transform, t);
                userMoved = false;
            };

            // --- Data, subset and drawing ---------------------------------------

            let fullData = {nodes: [], links: []};
            let hostGroup = "synthetic"; // from the module settings, sent with the data
            const urlState = readUrlState();
            let selected = urlState.hosts; // host names; empty means all hosts
            let notifiedOnly = urlState.notifiedOnly; // ignore services with notifications disabled
            const updateUrl = () => writeUrlState({hosts: selected, notifiedOnly}, container);
            // The service summary to show: all services, or only those with
            // notifications enabled (falls back if the server doesn't send it)
            const serviceSummary = d => notifiedOnly && d.services_notified !== undefined ? d.services_notified : d.services;
            let drawn = null; // {structure, update(data)} for what is on screen
            let laidOutFor = {width: 0, height: 0};

            const visibleData = () => selected.length ? subsetAbove(fullData, selected) : fullData;

            const draw = view => {
                const data = visibleData();
                const nodes = (data.nodes || []).map(n => Object.assign({}, n));
                const links = data.links || [];
                content.selectAll("*").remove();
                emptyMessage.hidden = nodes.length > 0;
                emptyMessage.textContent = `No hosts found in the "${hostGroup}" host group.`;
                laidOutFor = {width: viewport.clientWidth, height: viewport.clientHeight};
                const area = drawingArea();
                if (!nodes.length) {
                    drawn = {structure: structureOf(data), update: () => {}, restyle: () => {}};
                    return;
                }

                const geo = computeLayout(nodes, links, area);
                width = geo.width;
                height = geo.height;
                content.attr("transform", `translate(0,${-geo.top})`);
                const margin = 40;
                zoom.translateExtent([[-margin, -margin], [width + margin, height + margin]]);

                const nodeByName = new Map(nodes.map(n => [n.name, n]));
                // Arrows take the colour of a child that is down or unreachable;
                // handled problems are faded
                const childOf = e => nodeByName.get(e.child);
                const arrowColour = e => isProblem(childOf(e)) ? stateColor(childOf(e)) : COLOURS.edge;
                const arrowOpacity = e => !isProblem(childOf(e)) ? 0.5 : isHandled(childOf(e)) ? 0.35 : 0.85;
                const arrowRank = e => !isProblem(childOf(e)) ? 0 : isHandled(childOf(e)) ? 1 : 2;

                // Boxes stay unfilled so an edge from an outer box can be followed
                // across inner ones back to where it starts
                const boxRects = content.append("g")
                    .attr("fill", "none")
                    .attr("stroke", textColor)
                    .attr("stroke-opacity", 0.45)
                    .attr("stroke-width", 1.2)
                    .selectAll("rect")
                    .data(geo.boxes)
                    .join("rect")
                    .attr("x", b => b.x0)
                    .attr("y", b => b.y0)
                    .attr("width", b => b.x1 - b.x0)
                    .attr("height", b => b.y1 - b.y0)
                    .attr("rx", 7)
                    .attr("ry", 7);

                const edgePaths = content.append("g")
                    .attr("fill", "none")
                    .attr("stroke-width", 1.6)
                    .selectAll("path")
                    .data(geo.edges)
                    .join("path")
                    .attr("d", d3.linkHorizontal()
                        .x(p => p.x)
                        .y(p => p.y));

                const node = content.append("g")
                    .selectAll("a")
                    .data(nodes)
                    .join("a")
                    .attr("href", d => d.link)
                    .attr("transform", d => {
                        const p = geo.coords.get(d.name);
                        return `translate(${p.x},${p.y})`;
                    });

                const titles = node.append("title");

                // A ring around the dot for the worst service problem: solid for
                // unhandled problems, dashed and faded if all are handled
                const rings = node.append("circle")
                    .attr("r", 8.5)
                    .attr("fill", "none")
                    .attr("stroke-width", 2);

                const circles = node.append("circle")
                    .attr("r", 5)
                    .attr("stroke", d => d.synthetic ? "none" : textColor)
                    .attr("stroke-dasharray", "2,2");

                const labels = node.append("text")
                    .attr("x", -LABEL_OFFSET)
                    .attr("dy", "0.32em")
                    .attr("text-anchor", "end")
                    .attr("font-weight", d => d.synthetic ? "bold" : "normal")
                    .attr("font-style", d => d.synthetic ? "normal" : "italic")
                    .attr("stroke", background || "none")
                    .attr("stroke-width", 3)
                    .attr("stroke-linejoin", "round")
                    .attr("paint-order", "stroke")
                    .text(d => d.label);

                // Everything that depends on host states, so a refresh can
                // recolour the drawing in place without touching the layout
                const applyStates = () => {
                    titles.text(d => [
                        d.name,
                        "state: " + stateName(d)
                            + (d.acknowledged ? ", acknowledged" : "")
                            + (d.in_downtime ? ", in downtime" : ""),
                        stateName(d) === "unreachable" ? "(down because a parent is down)" : null,
                        servicesText(serviceSummary(d), notifiedOnly),
                        d.zone ? "zone: " + d.zone : null,
                        d.synthetic ? null : "not in the " + hostGroup + " host group"
                    ].filter(Boolean).join("\n"));
                    const ringState = d => {
                        const summary = serviceSummary(d);
                        return summary && (summary.worst_unhandled || (summary.worst && summary.worst !== "ok" ? summary.worst : null));
                    };
                    const allHandled = d => !!serviceSummary(d) && !serviceSummary(d).worst_unhandled;
                    rings
                        .attr("display", d => ringState(d) ? null : "none")
                        .attr("stroke", d => COLOURS[ringState(d)] || "none")
                        .attr("stroke-dasharray", d => allHandled(d) ? "2,2" : null)
                        .attr("stroke-opacity", d => allHandled(d) ? 0.6 : 1);
                    circles
                        .attr("fill", d => stateColor(d))
                        .attr("fill-opacity", d => isHandled(d) ? 0.45 : 1);
                    labels
                        .attr("fill", d => d.synthetic ? stateColor(d) : textColor)
                        .attr("opacity", d => (d.synthetic ? 1 : 0.6) * (isHandled(d) ? 0.6 : 1));
                    edgePaths
                        .attr("stroke", arrowColour)
                        .attr("opacity", arrowOpacity)
                        .attr("marker-end", e => markerFor(arrowColour(e)))
                        // Unhandled problems are drawn last so they stay on top
                        .sort((a, b) => arrowRank(a) - arrowRank(b));
                };
                applyStates();

                // Hovering a host highlights everything above and below it (and
                // the arrows along those chains) and dims the rest
                const parentsOf = new Map(nodes.map(n => [n.name, []]));
                const childrenOf = new Map(nodes.map(n => [n.name, []]));
                links.forEach(l => {
                    if (!parentsOf.has(l.target) || !childrenOf.has(l.source)) return;
                    parentsOf.get(l.target).push(l.source);
                    childrenOf.get(l.source).push(l.target);
                });
                const reach = (start, next) => {
                    const seen = new Set();
                    const queue = [start];
                    while (queue.length) {
                        next.get(queue.shift()).forEach(n => {
                            if (!seen.has(n)) {
                                seen.add(n);
                                queue.push(n);
                            }
                        });
                    }
                    return seen;
                };
                const highlight = name => {
                    const above = reach(name, parentsOf);
                    const below = reach(name, childrenOf);
                    const related = new Set([name, ...above, ...below]);
                    const onChain = e => e.parents.some(p =>
                        (above.has(p) && (e.child === name || above.has(e.child)))
                        || ((p === name || below.has(p)) && below.has(e.child)));
                    node.style("opacity", d => related.has(d.name) ? null : 0.15);
                    boxRects.style("opacity", b => b.names.some(n => related.has(n)) ? null : 0.15);
                    edgePaths.style("opacity", e => onChain(e) ? 1 : 0.06);
                };
                const clearHighlight = () => {
                    node.style("opacity", null);
                    boxRects.style("opacity", null);
                    edgePaths.style("opacity", null);
                };
                node.on("mouseenter.highlight", (event, d) => highlight(d.name))
                    .on("mouseleave.highlight", clearHighlight);

                drawn = {
                    structure: structureOf(data),
                    update: fresh => {
                        (fresh.nodes || []).forEach(n => {
                            const shown = nodeByName.get(n.name);
                            if (!shown) return;
                            shown.state = n.state;
                            shown.last_check = n.last_check;
                            shown.zone = n.zone;
                            shown.reachable = n.reachable;
                            shown.acknowledged = n.acknowledged;
                            shown.in_downtime = n.in_downtime;
                            shown.services = n.services;
                            shown.services_notified = n.services_notified;
                        });
                        applyStates();
                    },
                    // Recolour after the notified-services option changes
                    restyle: applyStates
                };

                if (view) {
                    svg.call(zoom.transform, view);
                    userMoved = true;
                } else {
                    fit(false);
                }
            };

            // --- Controls --------------------------------------------------------

            const controls = document.createElement("div");
            controls.className = "topologygraph-controls";

            // Subset picker: tick one or more hosts without children to show
            // only them and everything above them
            const pickerButton = document.createElement("button");
            pickerButton.type = "button";
            pickerButton.className = "topologygraph-picker-button";
            pickerButton.title = "Show only some hosts and everything above them";
            const panel = document.createElement("div");
            panel.className = "topologygraph-picker";
            panel.hidden = true;
            const filter = document.createElement("input");
            filter.type = "search";
            filter.placeholder = "Filter hosts";
            const showAll = document.createElement("button");
            showAll.type = "button";
            showAll.textContent = "Show all";
            const panelHead = document.createElement("div");
            panelHead.className = "topologygraph-picker-head";
            panelHead.append(filter, showAll);
            const list = document.createElement("div");
            list.className = "topologygraph-picker-list";
            panel.append(panelHead, list);

            const applySelection = () => {
                pickerButton.textContent = selected.length === 0 ? "All hosts \u25be"
                    : selected.length === 1 ? (fullData.nodes.find(n => n.name === selected[0]) || {label: selected[0]}).label + " \u25be"
                    : selected.length + " hosts \u25be";
                list.querySelectorAll("input").forEach(box => box.checked = selected.includes(box.value));
                updateUrl();
            };
            const choose = names => {
                selected = names;
                applySelection();
                draw(null);
            };

            let pickerFor = null;
            const updatePicker = () => {
                const structure = structureOf(fullData);
                if (structure !== pickerFor) {
                    pickerFor = structure;
                    const hosts = hostsWithoutChildren(fullData);
                    list.replaceChildren(...hosts.map(n => {
                        const row = document.createElement("label");
                        const box = document.createElement("input");
                        box.type = "checkbox";
                        box.value = n.name;
                        row.append(box, " " + n.label);
                        row.dataset.filter = (n.label + " " + n.name).toLowerCase();
                        return row;
                    }));
                    pickerButton.hidden = !hosts.length;
                    filterList();
                }
                // Drop selected hosts that are gone or now have children
                const available = new Set([...list.querySelectorAll("input")].map(box => box.value));
                selected = selected.filter(name => available.has(name));
                applySelection();
            };
            const filterList = () => {
                const text = filter.value.trim().toLowerCase();
                list.querySelectorAll("label").forEach(row => row.hidden = !!text && !row.dataset.filter.includes(text));
            };

            list.addEventListener("change", () => {
                choose([...list.querySelectorAll("input:checked")].map(box => box.value));
            });
            filter.addEventListener("input", filterList);
            showAll.addEventListener("click", () => choose([]));
            const closePanel = () => { panel.hidden = true; };
            pickerButton.addEventListener("click", event => {
                event.preventDefault();
                panel.hidden = !panel.hidden;
                if (!panel.hidden) filter.focus();
            });
            // Close when clicking elsewhere or pressing Escape
            const onOutsideClick = event => {
                if (!viewport.isConnected) {
                    document.removeEventListener("mousedown", onOutsideClick, true);
                    return;
                }
                if (!panel.hidden && !panel.contains(event.target) && event.target !== pickerButton) closePanel();
            };
            // Capture phase: the zoom behaviour stops mousedown on the diagram
            // from bubbling up to the document
            document.addEventListener("mousedown", onOutsideClick, true);
            panel.addEventListener("keydown", event => { if (event.key === "Escape") closePanel(); });
            // Option: leave out services with notifications disabled
            const notifiedToggle = document.createElement("label");
            notifiedToggle.className = "topologygraph-toggle";
            notifiedToggle.title = "Leave out services with notifications disabled from the rings and counts";
            const notifiedBox = document.createElement("input");
            notifiedBox.type = "checkbox";
            notifiedBox.checked = notifiedOnly;
            notifiedBox.addEventListener("change", () => {
                notifiedOnly = notifiedBox.checked;
                updateUrl();
                if (drawn) drawn.restyle();
            });
            notifiedToggle.append(notifiedBox, " Notified services only");

            controls.append(notifiedToggle, pickerButton);
            viewport.append(panel);

            const isFullscreen = () =>
                (document.fullscreenElement || document.webkitFullscreenElement) === viewport;
            const canFullscreen = !!(viewport.requestFullscreen || viewport.webkitRequestFullscreen);
            const toggleFullscreen = () => {
                if (isFullscreen()) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                } else {
                    (viewport.requestFullscreen || viewport.webkitRequestFullscreen).call(viewport);
                }
            };

            let fullscreenButton = null;
            [
                ["+", "Zoom in", () => svg.transition().duration(200).call(zoom.scaleBy, 1.4)],
                ["\u2212", "Zoom out", () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.4)],
                ["Fit", "Fit the whole diagram", () => fit(true)],
                ["1:1", "Show at 100%", () => {
                    const t = d3.zoomTransform(svg.node());
                    svg.transition().duration(250).call(zoom.scaleBy, 1 / t.k);
                }],
                canFullscreen ? ["Full screen", "Toggle full screen (Esc to leave)", toggleFullscreen] : null
            ].filter(Boolean).forEach(([label, title, action]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.title = title;
                button.addEventListener("click", event => {
                    event.preventDefault();
                    if (action !== toggleFullscreen) userMoved = true;
                    action();
                });
                controls.append(button);
                if (action === toggleFullscreen) fullscreenButton = button;
            });
            viewport.append(controls);

            const hint = document.createElement("div");
            hint.className = "topologygraph-hint";
            const status = document.createElement("span");
            hint.append(status, "Scroll to zoom \u00b7 Drag or Shift + scroll to move");
            viewport.append(hint);

            // Legend for the colours, bottom left
            const legend = document.createElement("div");
            legend.className = "topologygraph-legend";
            const swatch = (fill, opts = {}) => {
                const ns = "http://www.w3.org/2000/svg";
                const icon = document.createElementNS(ns, "svg");
                icon.setAttribute("width", "20");
                icon.setAttribute("height", "12");
                icon.setAttribute("viewBox", "-10 -6 20 12");
                if (opts.ring) {
                    const ring = document.createElementNS(ns, "circle");
                    ring.setAttribute("r", "5");
                    ring.setAttribute("fill", "none");
                    ring.setAttribute("stroke", opts.ring);
                    ring.setAttribute("stroke-width", "1.5");
                    icon.append(ring);
                }
                const dot = document.createElementNS(ns, "circle");
                dot.setAttribute("r", opts.ring ? "2.5" : "4");
                dot.setAttribute("fill", fill);
                if (opts.faded) dot.setAttribute("fill-opacity", "0.45");
                icon.append(dot);
                return icon;
            };
            [
                [swatch(COLOURS.up), "up"],
                [swatch(COLOURS.down), "down"],
                [swatch(COLOURS.unreachable), "unreachable (parent down)"],
                [swatch(COLOURS.down, {faded: true}), "acknowledged / downtime"],
                [swatch(COLOURS.pending), "pending"],
                [swatch(COLOURS.up, {ring: COLOURS.warning}), "service problem"]
            ].forEach(([icon, text]) => {
                const item = document.createElement("span");
                item.append(icon, text);
                legend.append(item);
            });
            viewport.append(legend);

            // --- Sizing ----------------------------------------------------------

            container.replaceChildren(viewport);

            const scroller = () => {
                for (let el = viewport.parentElement; el && el !== document.body; el = el.parentElement) {
                    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
                }
                return document.scrollingElement || document.documentElement;
            };
            // Fill the window from the viewport's top edge down to the bottom, and
            // reach into the padding of the surrounding page so the graph runs
            // edge to edge (upwards only if nothing sits above it)
            const sizeToWindow = () => {
                const style = viewport.style;
                if (isFullscreen()) {
                    style.margin = "0";
                    style.width = "100vw";
                    style.height = "100vh";
                    return;
                }
                const outer = scroller();
                let left = 0, right = 0, top = 0, bottom = 0, nothingAbove = !viewport.previousElementSibling;
                for (let el = viewport.parentElement; el && el !== outer && el !== document.body; el = el.parentElement) {
                    const cs = getComputedStyle(el);
                    left += parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
                    right += parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
                    bottom += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
                    if (nothingAbove) top += parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
                    if (el.previousElementSibling) nothingAbove = false;
                }
                style.margin = `${-top}px ${-right}px ${-bottom}px ${-left}px`;
                style.width = `calc(100% + ${left + right}px)`;
                style.height = Math.max(200, window.innerHeight - viewport.getBoundingClientRect().top) + "px";
                // If the page would still scroll, take that much off
                const excess = outer.scrollHeight - outer.clientHeight;
                if (excess > 0) style.height = Math.max(200, viewport.clientHeight - excess) + "px";
            };

            // Re-lay out (and refit) after the viewport settles at a new size,
            // unless the user has zoomed or panned
            let relayoutTimer = null;
            const relayoutSoon = force => {
                clearTimeout(relayoutTimer);
                relayoutTimer = setTimeout(() => {
                    if (!viewport.isConnected) return;
                    if (force || !userMoved) draw(null);
                }, 200);
            };
            if (window.ResizeObserver) {
                new ResizeObserver(() => {
                    if (Math.abs(viewport.clientWidth - laidOutFor.width) > 20
                        || Math.abs(viewport.clientHeight - laidOutFor.height) > 20) {
                        relayoutSoon(false);
                    }
                }).observe(viewport);
            }

            const onWindowResize = () => {
                // Icinga replaces the diagram on refresh; drop listeners of old ones
                if (!viewport.isConnected) {
                    window.removeEventListener("resize", onWindowResize);
                    return;
                }
                sizeToWindow();
            };
            window.addEventListener("resize", onWindowResize);
            const onFullscreenChange = () => {
                if (!viewport.isConnected) {
                    document.removeEventListener("fullscreenchange", onFullscreenChange);
                    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
                    return;
                }
                sizeToWindow();
                if (fullscreenButton) fullscreenButton.textContent = isFullscreen() ? "Exit full screen" : "Full screen";
                relayoutSoon(true);
            };
            document.addEventListener("fullscreenchange", onFullscreenChange);
            document.addEventListener("webkitfullscreenchange", onFullscreenChange);

            sizeToWindow();

            return {
                isConnected: () => viewport.isConnected,
                setStatus: text => { status.textContent = text ? text + " \u00b7 " : ""; },
                // New data: recolour in place if the shown hosts and dependencies
                // are unchanged, else re-lay out (keeping the user's view)
                setData: data => {
                    fullData = {nodes: data.nodes || [], links: data.links || []};
                    hostGroup = data.hostgroup || "synthetic";
                    updatePicker();
                    const visible = visibleData();
                    if (drawn && structureOf(visible) === drawn.structure) {
                        drawn.update(visible);
                    } else {
                        draw(drawn && userMoved ? d3.zoomTransform(svg.node()) : null);
                    }
                }
            };
        }
    };

    Icinga.availableModules.topologygraph = Topologygraph;

}(Icinga));
