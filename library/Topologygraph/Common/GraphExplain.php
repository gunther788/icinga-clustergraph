<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Explains a graph built by GraphSource, for comparing it with Icinga or
 * other reference data:
 *
 * - every drawn host, whether it is drawn as a member of the host group from
 *   the module settings (blue, bold) or as a host outside it (gray), and why
 *   it is in the graph at all;
 * - every line, and which request found it;
 * - for a selection (host= / hostgroup= in the page address), which drawn
 *   hosts it shows and why;
 * - the hosts in a selected host group, or selected by name, that are not in
 *   the graph, with the host-to-host dependencies they do have.
 *
 * The API is passed in as a callable, as for GraphSource.
 */
final class GraphExplain
{
    /**
     * @param array    $graph           As returned by GraphSource::fetch()
     * @param string   $settingsGroup   Host group from the module settings
     * @param string[] $hosts           Hosts selected by name (host=)
     * @param string[] $hostgroups      Host groups selected (hostgroup=)
     * @param callable $api             function (string $endpoint, array $body): array of API results
     *
     * @return array
     */
    public static function explain(array $graph, $settingsGroup, array $hosts, array $hostgroups, callable $api)
    {
        $hosts = array_values(array_unique(array_map('strval', $hosts)));
        $hostgroups = array_values(array_unique(array_map('strval', $hostgroups)));

        $nodes = [];
        foreach ($graph['nodes'] as $node) {
            $nodes[(string) $node['name']] = $node;
        }
        $parents = $children = [];
        foreach ($graph['links'] as $link) {
            $parents[$link['target']][] = $link['source'];
            $children[$link['source']][] = $link['target'];
        }
        $isMember = function ($name) use ($nodes) {
            return isset($nodes[$name]) && ! empty($nodes[$name]['synthetic']);
        };

        // What the selection shows, as the page works it out: the hosts
        // selected by name or by group, then everything above them
        $selecting = (bool) ($hosts || $hostgroups);
        $whyShown = [];
        foreach ($hosts as $name) {
            if (isset($nodes[$name])) {
                $whyShown[$name][] = 'selected by name';
            }
        }
        foreach ($nodes as $name => $node) {
            foreach (array_intersect($node['groups'], $hostgroups) as $group) {
                $whyShown[$name][] = 'in selected host group ' . $group;
            }
        }
        $queue = array_keys($whyShown);
        while ($queue) {
            $name = array_shift($queue);
            foreach ($parents[$name] ?? [] as $parent) {
                if (! isset($whyShown[$parent])) {
                    $whyShown[$parent] = ['parent of shown host ' . $name];
                    $queue[] = $parent;
                }
            }
        }

        $explained = [];
        foreach ($nodes as $name => $node) {
            $member = $isMember($name);
            $why = [];
            if ($member) {
                $why[] = 'in the ' . $settingsGroup . ' host group';
            } else {
                foreach ($children[$name] ?? [] as $child) {
                    if ($isMember($child)) {
                        $why[] = 'parent of ' . $child;
                    }
                }
                foreach ($parents[$name] ?? [] as $parent) {
                    if ($isMember($parent)) {
                        $why[] = 'child of ' . $parent;
                    }
                }
            }
            $explained[] = [
                'name'           => $name,
                'display_name'   => $node['label'],
                'drawn_as'       => $member ? 'member' : 'outside',
                'why_drawn'      => $why,
                'groups'         => $node['groups'],
                'parents'        => $parents[$name] ?? [],
                'children'       => $children[$name] ?? [],
                'shown'          => ! $selecting || isset($whyShown[$name]),
                'why_shown'      => $selecting ? ($whyShown[$name] ?? []) : ['no selection: everything is shown']
            ];
        }
        usort($explained, function ($a, $b) {
            return [$a['drawn_as'] !== 'member', $a['name']] <=> [$b['drawn_as'] !== 'member', $b['name']];
        });

        $links = [];
        foreach ($graph['links'] as $link) {
            $links[] = [
                'parent' => $link['source'],
                'child'  => $link['target'],
                'found'  => $isMember($link['source']) || $isMember($link['target'])
                    ? 'touches a member'
                    : 'between two outside hosts'
            ];
        }

        // Selected hosts and group members that aren't in the graph
        $groupReports = [];
        $missing = [];
        foreach ($hostgroups as $group) {
            $members = $api(
                'objects/hosts?attrs=name&attrs=display_name&attrs=groups',
                ['filter' => 'group in host.groups', 'filter_vars' => ['group' => $group]]
            );
            $drawn = $notDrawn = [];
            foreach ($members as $host) {
                $name = (string) $host['name'];
                if (isset($nodes[$name])) {
                    $drawn[] = $name;
                } else {
                    $notDrawn[] = $name;
                    $missing[$name] = $host;
                }
            }
            sort($drawn);
            sort($notDrawn);
            $groupReports[$group] = [
                'hosts_in_icinga' => count($members),
                'drawn'           => $drawn,
                'drawn_as_member' => array_values(array_filter($drawn, $isMember)),
                'drawn_outside'   => array_values(array_filter($drawn, function ($name) use ($isMember) {
                    return ! $isMember($name);
                })),
                'not_drawn'       => $notDrawn
            ];
            if (! $members) {
                $groupReports[$group]['note'] = 'Icinga has no hosts in this group. Group names are object names,'
                    . ' not display names.';
            }
        }

        $unknownNames = array_values(array_filter($hosts, function ($name) use ($nodes, $missing) {
            return ! isset($nodes[$name]) && ! isset($missing[$name]);
        }));
        if ($unknownNames) {
            foreach ($api(
                'objects/hosts?attrs=name&attrs=display_name&attrs=groups',
                ['filter' => 'host.name in names', 'filter_vars' => ['names' => $unknownNames]]
            ) as $host) {
                $missing[(string) $host['name']] = $host;
            }
        }

        $notDrawn = [];
        if ($missing) {
            $dependencies = $api(
                'objects/dependencies?' . GraphSource::DEPENDENCY_ATTRS,
                [
                    'filter'      => 'dependency.child_service_name == ""'
                        . ' && (dependency.parent_host_name in names || dependency.child_host_name in names)',
                    'filter_vars' => ['names' => array_map('strval', array_keys($missing))]
                ]
            );
            $byHost = [];
            foreach ($dependencies as $dependency) {
                $parent = (string) $dependency['attrs']['parent_host_name'];
                $child = (string) $dependency['attrs']['child_host_name'];
                $entry = ['parent' => $parent, 'child' => $child];
                foreach (array_unique([$parent, $child]) as $end) {
                    if (isset($missing[$end]) && ! in_array($entry, $byHost[$end] ?? [], true)) {
                        $byHost[$end][] = $entry;
                    }
                }
            }
            ksort($missing, SORT_STRING);
            foreach ($missing as $name => $host) {
                $name = (string) $name;
                $deps = $byHost[$name] ?? [];
                $toDrawn = array_values(array_unique(array_filter(array_map(function ($d) use ($name) {
                    return $d['parent'] === $name ? $d['child'] : $d['parent'];
                }, $deps), function ($other) use ($nodes) {
                    return isset($nodes[$other]);
                })));
                if (! $deps) {
                    $reason = 'no host-to-host dependencies at all';
                } elseif ($toDrawn) {
                    $reason = 'only depends on (or is depended on by) hosts outside the ' . $settingsGroup
                        . ' host group (' . implode(', ', $toDrawn) . '); the graph draws the group and'
                        . ' its direct neighbours only';
                } else {
                    $reason = 'none of its host-to-host dependencies lead to a host in the graph';
                }
                $notDrawn[] = [
                    'name'                     => $name,
                    'display_name'             => $host['attrs']['display_name'] ?? $name,
                    'groups'                   => array_values(array_map('strval', (array) ($host['attrs']['groups'] ?? []))),
                    'reason'                   => 'not in the ' . $settingsGroup . ' host group, and ' . $reason,
                    'host_dependencies'        => $deps
                ];
            }
        }
        foreach ($hosts as $name) {
            if (! isset($nodes[$name]) && ! isset($missing[$name])) {
                $notDrawn[] = ['name' => $name, 'reason' => 'Icinga has no host with this name'];
            }
        }

        $members = count(array_filter(array_keys($nodes), $isMember));
        return [
            'settings_hostgroup' => $settingsGroup,
            'selection'          => ['hosts' => $hosts, 'hostgroups' => $hostgroups],
            'counts'             => [
                'drawn'            => count($nodes),
                'drawn_as_member'  => $members,
                'drawn_outside'    => count($nodes) - $members,
                'links'            => count($links),
                'shown'            => count(array_filter($explained, function ($h) {
                    return $h['shown'];
                })),
                'selected_but_not_drawn' => count($notDrawn)
            ],
            'how_it_works'       => [
                'The graph has the hosts in the ' . $settingsGroup . ' host group (from the module settings),'
                    . ' plus the hosts with a host-to-host dependency on one of them.',
                'Only hosts in the ' . $settingsGroup . ' host group are drawn as members (blue, bold); all others'
                    . ' are drawn as outside hosts (gray).',
                'Selecting hosts or host groups (host= / hostgroup=) only picks from the hosts already in the'
                    . ' graph: it never adds hosts, and never changes how they are drawn.'
            ],
            'hostgroups'         => (object) $groupReports,
            'selected_but_not_drawn' => $notDrawn,
            'hosts'              => $explained,
            'links'              => $links
        ];
    }
}
