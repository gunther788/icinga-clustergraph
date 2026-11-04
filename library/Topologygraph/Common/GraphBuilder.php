<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Turns Icinga 2 API results into the graph the front end draws.
 *
 * Pure array work with no Icinga Web dependencies, so it can be tested on its
 * own (see tests/php/GraphBuilderTest.php).
 */
final class GraphBuilder
{
    /** Service states, worst first, for picking a host's worst service problem */
    const SERVICE_SEVERITY = ['critical' => 3, 'unknown' => 2, 'warning' => 1, 'ok' => 0];

    /**
     * Pick the hosts to draw and the parent -> child links between them.
     *
     * Every host in $group is drawn, plus any direct parent or child of one that
     * is outside the group, so chains don't break. Only host-to-host
     * dependencies are used; service dependencies are ignored.
     *
     * @param array  $hosts        API results from objects/hosts (with attrs.groups)
     * @param array  $dependencies API results from objects/dependencies
     * @param string $group        Host group to draw
     *
     * @return array ['names' => string[], 'synthetic' => [name => true], 'links' => [['source', 'target']...]]
     */
    public static function select(array $hosts, array $dependencies, $group)
    {
        $synthetic = [];
        foreach ($hosts as $host) {
            if (in_array($group, $host['attrs']['groups'] ?? [], true)) {
                $synthetic[(string) $host['name']] = true;
            }
        }

        $links = [];
        foreach ($dependencies as $dependency) {
            $attrs = $dependency['attrs'] ?? [];
            if (! empty($attrs['child_service_name'])) {
                continue;
            }
            $parent = (string) ($attrs['parent_host_name'] ?? '');
            $child = (string) ($attrs['child_host_name'] ?? '');
            if ($parent === '' || $child === '' || $parent === $child) {
                continue;
            }
            if (! isset($synthetic[$parent]) && ! isset($synthetic[$child])) {
                continue;
            }
            $links[$parent . "\0" . $child] = ['source' => $parent, 'target' => $child];
        }

        $names = $synthetic;
        foreach ($links as $link) {
            $names[$link['source']] = true;
            $names[$link['target']] = true;
        }

        return [
            // PHP turns numeric string keys into ints; cast them back
            'names'     => array_map('strval', array_keys($names)),
            'synthetic' => $synthetic,
            'links'     => array_values($links)
        ];
    }

    /**
     * Summarise services per host.
     *
     * A service is pending until its first check, and a problem (warning,
     * critical or unknown) is handled when it is acknowledged or in downtime.
     *
     * @param array $services     API results from objects/services
     * @param bool  $onlyNotified Leave out services with notifications disabled
     *
     * @return array host name => ['total', 'ok', 'warning', 'critical', 'unknown', 'pending',
     *                             'unhandled', 'worst', 'worst_unhandled']
     */
    public static function summariseServices(array $services, $onlyNotified = false)
    {
        $names = [0 => 'ok', 1 => 'warning', 2 => 'critical', 3 => 'unknown'];
        $summary = [];
        foreach ($services as $service) {
            $attrs = $service['attrs'] ?? [];
            $host = (string) ($attrs['host_name'] ?? '');
            if ($host === '') {
                continue;
            }
            if ($onlyNotified && ($attrs['enable_notifications'] ?? true) === false) {
                continue;
            }
            if (! isset($summary[$host])) {
                $summary[$host] = [
                    'total' => 0, 'ok' => 0, 'warning' => 0, 'critical' => 0, 'unknown' => 0, 'pending' => 0,
                    'unhandled' => 0, 'worst' => null, 'worst_unhandled' => null
                ];
            }
            $entry = &$summary[$host];
            $entry['total']++;

            if (($attrs['last_check'] ?? 0) <= 0) {
                $entry['pending']++;
                unset($entry);
                continue;
            }

            $state = $names[(int) ($attrs['state'] ?? 3)] ?? 'unknown';
            $entry[$state]++;
            $entry['worst'] = self::worse($entry['worst'], $state);

            $handled = ($attrs['acknowledgement'] ?? 0) > 0 || ($attrs['downtime_depth'] ?? 0) > 0;
            if ($state !== 'ok' && ! $handled) {
                $entry['unhandled']++;
                $entry['worst_unhandled'] = self::worse($entry['worst_unhandled'], $state);
            }
            unset($entry);
        }

        return $summary;
    }

    /**
     * Build the data for the front end.
     *
     * @param array      $selection Result of select()
     * @param array      $hosts     API results from objects/hosts
     * @param array|null $services  API results from objects/services, or null if they couldn't be fetched
     * @param string     $hostPath  Icinga Web URL prefix for a host's detail page
     *
     * @return array ['nodes' => [...], 'links' => [...]]
     */
    public static function build(array $selection, array $hosts, $services, $hostPath)
    {
        $hostsByName = [];
        foreach ($hosts as $host) {
            $hostsByName[(string) $host['name']] = $host['attrs'] ?? [];
        }
        $serviceSummary = $services === null ? null : self::summariseServices($services);
        $notifiedSummary = $services === null ? null : self::summariseServices($services, true);
        $noServices = [
            'total' => 0, 'ok' => 0, 'warning' => 0, 'critical' => 0, 'unknown' => 0, 'pending' => 0,
            'unhandled' => 0, 'worst' => null, 'worst_unhandled' => null
        ];

        $nodes = [];
        foreach ($selection['names'] as $name) {
            $attrs = $hostsByName[$name] ?? null;
            $nodes[] = [
                'name'         => $name,
                'label'        => $attrs['display_name'] ?? $name,
                'state'        => $attrs['state'] ?? null,
                'last_check'   => $attrs['last_check'] ?? null,
                'zone'         => $attrs['zone'] ?? null,
                // Down only because a parent is down
                'reachable'    => $attrs === null ? true : (bool) ($attrs['last_reachable'] ?? true),
                'acknowledged' => ($attrs['acknowledgement'] ?? 0) > 0,
                'in_downtime'  => ($attrs['downtime_depth'] ?? 0) > 0,
                // null: service details unavailable (e.g. no permission)
                'services'     => $serviceSummary === null ? null : ($serviceSummary[$name] ?? $noServices),
                // The same, counting only services with notifications enabled
                'services_notified' => $notifiedSummary === null ? null : ($notifiedSummary[$name] ?? $noServices),
                'synthetic'    => isset($selection['synthetic'][$name]),
                'link'         => $hostPath . rawurlencode($name)
            ];
        }

        return ['nodes' => $nodes, 'links' => $selection['links']];
    }

    private static function worse($a, $b)
    {
        if ($a === null) {
            return $b;
        }

        return self::SERVICE_SEVERITY[$b] > self::SERVICE_SEVERITY[$a] ? $b : $a;
    }
}
