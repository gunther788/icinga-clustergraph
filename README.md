# Topology Graph for Icinga Web 2

`topologygraph` is an Icinga Web 2 module that draws a **parent/child topology graph of the hosts in a host group**
(`synthetic` by default), with their state, their service problems and live updates.

It started as a fork of [sol1/icinga-clustergraph](https://github.com/sol1/icinga-clustergraph), which draws the
Icinga 2 cluster: zones, the endpoints in each zone, and which zone reports to which parent. This fork reused that
module's settings page and API plumbing, then replaced what it draws. It was renamed from `clustergraph` to
`topologygraph` so the two can't be confused and can be installed side by side. See
[Upgrading from clustergraph](#upgrading-from-clustergraph).

## How the module was repurposed

The upstream module asks the Icinga 2 API for zones and endpoints and draws them as a tree. This fork swaps both ends:

- **Data:** `IndexController::dataAction()` asks the API for hosts, `Dependency` objects and services instead of
  zones. It returns every host in the configured host group, plus any direct parent or child of one that is outside
  the group, and the parent → child links between them. Only host-to-host dependencies are used; service
  dependencies are ignored.
- **Drawing:** `public/js/module.js` replaces the zone tree with a layered dependency graph built with D3, described
  below.
- **Permissions:** the API user needs `objects/query/Host`, `objects/query/Dependency` and
  `objects/query/Service` instead of the zone and endpoint permissions.

The settings page and the API connection work as they did upstream, with two new settings: the host group and the
refresh interval.

## What the graph shows

- **Layout:** parents are on the right and children on the left. Each arrow points from a parent to its child.
- **Rightmost column:** hosts with no parents (typically the synthetic checks themselves) form the rightmost level.
  Hosts that are parents of exactly the same children are drawn together in one rounded box with a single exit point
  for their arrows. That column is wrapped into several side-by-side sub-columns, so a long list of checks doesn't
  make the graph very tall.
- **Colours:** dots and names show host state: green for up, red for down, purple for unreachable (down only
  because a parent is down), blue for pending, grey for unknown. Problems that are acknowledged or in downtime are
  faded. Arrows take the colour of the host they point at.
- **Service problems:** a ring around a host's dot shows its worst service problem: red for critical, orange for
  warning, purple for unknown. The ring is solid while any problem is unhandled, and dashed and faded when all of
  them are acknowledged or in downtime. A legend in the bottom-left corner explains the colours.
- **Hosts outside the group:** they're drawn faded and in italics.
- **Hovering a host:** highlights everything above and below it, along with the arrows on those chains, and dims
  the rest. The hover text shows the host's state, its service counts and its zone. Click a host to open it in
  Icinga Web.

The layout tries to:

- keep arrows horizontal, by lining each host up with one of the hosts it connects to;
- cross as few arrows as possible, and avoid running arrows through boxes or host names;
- match the shape of the browser window, so the diagram fills it at full text size.

## Using it

- **Moving around:**
  - Scroll the mouse wheel, or pinch on a trackpad, to zoom in and out around the pointer.
  - Drag to move the diagram, or hold Shift and scroll.
- **Buttons** (top right): zoom in, zoom out, **Fit** (the whole diagram), **1:1** (100%) and **Full screen** (Esc to
  leave).
- **Showing a subset:** the host button (it reads **All hosts ▾** until you choose) opens a checklist of every host
  without children, with a filter box. Tick one or more hosts to show only them and everything above them: their
  parents, their parents' parents, and so on. **Show all** goes back to everything.
- **Bookmarking a subset:** the selection is kept in the page address as repeated `host` parameters. Bookmark or
  share it like any other link, for example:

  ```
  https://icinga.example.com/icingaweb2/topologygraph?host=db-1&host=cache-1
  ```

- **Ignoring services without notifications:** tick **Notified services only** to leave out services that have
  notifications disabled. They then don't count towards the service rings or the counts in the hover text. The
  option is kept in the page address as `services=notified`, and combines with a host selection, for example
  `…/topologygraph?host=db-1&services=notified`.
- **Live updates:** while the page is visible, the graph fetches fresh data at the refresh interval (15 seconds by
  default) and catches up straight away when you return to the tab. A change of host state only recolours the existing drawing, so your zoom and
  position stay put. If hosts or dependencies were added or removed, the graph is laid out again. The bottom-right
  corner shows when it last updated.

## Prerequisites

- Icinga Web 2, with the icinga-php-library (0.11.0 or later)
- Icinga 2 with the REST API enabled and an API user (see below)
- A host group to draw (`synthetic` unless you choose another in the settings)
- Host parent/child relationships defined as Icinga 2 `Dependency` objects

The graph is built from `Dependency` objects only. If your parents are kept in a custom variable, add an apply rule
that turns it into dependencies, for example:

```
apply Dependency "host-parent" for (parent in host.vars.parents) to Host {
  parent_host_name = parent
  assign where host.vars.parents
}
```

## Installation

1. Clone the repository into the Icinga Web 2 `modules` directory as `topologygraph` (the folder name must match the
   module name):

   ```
   git clone https://github.com/gunther788/icinga-topologygraph.git /usr/share/icingaweb2/modules/topologygraph
   ```

2. Enable the module in the Icinga Web 2 web interface, or on the command line:

   ```
   icingacli module enable topologygraph
   ```

## Configuration

1. Add an API user to Icinga 2, for example in `api-users.conf`:

   ```
   object ApiUser "topologygraph" {
     password = "change-me"
     permissions = [ "objects/query/Host", "objects/query/Dependency", "objects/query/Service" ]
   }
   ```

2. In Icinga Web 2, go to **Configuration → Modules → topologygraph → Config**.
3. Fill in the settings:
   - **API user, password, endpoint (host name) and port** of the Icinga 2 API;
   - **Web UI:** where host links open, Icinga Web 2 (monitoring) or Icinga DB Web;
   - **Host group:** the group to draw (default `synthetic`);
   - **Refresh interval:** seconds between updates while the graph is open (default 15, at least 5).
4. Save the changes, then open **Topology Graph** from the menu.

Without `objects/query/Service` the graph still works, but without service rings. The hover text then says that
service details are not available.

Font size and spacing are constants (`FONT_SIZE` and `BASE`) near the top of `public/js/module.js`.

## Load on the Icinga API

Each update makes up to four small requests, each filtered on the Icinga side:

1. the hosts in the group;
2. the host-to-host dependencies that touch them;
3. the hosts outside the group at the other end of those dependencies;
4. the services of all drawn hosts.

The finished graph is cached on the Icinga Web server for half the refresh interval, in a folder in the system's
temporary directory. Several people with the page open therefore share one set of requests. Failed requests are
not cached.

## Upgrading from clustergraph

If you ran this fork under its old name, `clustergraph`:

1. Disable the old module:

   ```
   icingacli module disable clustergraph
   ```

2. Rename the module folder, point it at the renamed repository and update it:

   ```
   mv /usr/share/icingaweb2/modules/clustergraph /usr/share/icingaweb2/modules/topologygraph
   git -C /usr/share/icingaweb2/modules/topologygraph remote set-url origin https://github.com/gunther788/icinga-topologygraph.git
   git -C /usr/share/icingaweb2/modules/topologygraph pull
   ```

   GitHub redirects the old `icinga-clustergraph` address, so a pull works without changing the remote, but the new
   address is safer.

3. Move the settings:

   ```
   mv /etc/icingaweb2/modules/clustergraph /etc/icingaweb2/modules/topologygraph
   ```

4. Enable the new module:

   ```
   icingacli module enable topologygraph
   ```

5. Update anything that refers to the old name:
   - bookmarks, which now start `…/topologygraph` instead of `…/clustergraph`;
   - Icinga Web roles that grant `module/clustergraph`, which should grant `module/topologygraph`.

Add `objects/query/Service` to the API user's permissions if it doesn't have it yet.

## Tests

The `tests/` folder has PHP tests for the data the module sends and browser tests for the graph itself. See
[tests/README.md](tests/README.md) for how to run them.

## Limitations

- On very large graphs (more than 400 arrows) the slower layout refinements are skipped to keep the page
  responsive, so the layout may be less tidy.
- Only one arrow into a host can be level when its parents sit at different heights, so graphs where most hosts have
  several parents will still have sloped arrows.
- On touch devices, dragging on the graph moves the diagram instead of scrolling the page.

## Contributing

Changes go to https://github.com/gunther788/icinga-topologygraph. The original zone and endpoint graph lives
upstream at https://github.com/sol1/icinga-clustergraph.

## License

All code here is licensed under GPL V2.
