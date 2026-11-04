<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * Fetches just what the graph needs from the Icinga 2 API, in small requests
 * filtered on the Icinga side, and builds the graph with GraphBuilder:
 *
 * 1. the hosts in the group
 * 2. the host-to-host dependencies that touch them
 * 3. the hosts outside the group at the other end of those dependencies
 * 4. the services of all drawn hosts (optional: without permission, or on
 *    error, the graph is built without service details)
 *
 * The API is passed in as a callable so this can be tested without Icinga.
 */
final class GraphSource
{
    const HOST_ATTRS = 'attrs=name&attrs=display_name&attrs=state&attrs=last_check&attrs=groups&attrs=zone'
        . '&attrs=last_reachable&attrs=acknowledgement&attrs=downtime_depth';
    const DEPENDENCY_ATTRS = 'attrs=parent_host_name&attrs=child_host_name&attrs=child_service_name';
    const SERVICE_ATTRS = 'attrs=host_name&attrs=state&attrs=last_check&attrs=acknowledgement&attrs=downtime_depth';

    /**
     * @param callable $api      function (string $endpoint, array $body): array of API results
     * @param string   $group    Host group to draw
     * @param string   $hostPath Icinga Web URL prefix for a host's detail page
     * @param callable $onServiceError Optional: called with the exception if services can't be fetched
     *
     * @return array ['nodes' => [...], 'links' => [...]]
     */
    public static function fetch(callable $api, $group, $hostPath, ?callable $onServiceError = null)
    {
        $groupHosts = $api(
            'objects/hosts?' . self::HOST_ATTRS,
            ['filter' => 'group in host.groups', 'filter_vars' => ['group' => $group]]
        );
        $groupNames = self::names($groupHosts);
        if (! $groupNames) {
            return GraphBuilder::build(GraphBuilder::select([], [], $group), [], [], $hostPath);
        }

        $dependencies = $api(
            'objects/dependencies?' . self::DEPENDENCY_ATTRS,
            [
                'filter'      => 'dependency.child_service_name == ""'
                    . ' && (dependency.parent_host_name in names || dependency.child_host_name in names)',
                'filter_vars' => ['names' => $groupNames]
            ]
        );

        $selection = GraphBuilder::select($groupHosts, $dependencies, $group);

        $neighbours = array_values(array_diff($selection['names'], $groupNames));
        $neighbourHosts = $neighbours ? $api(
            'objects/hosts?' . self::HOST_ATTRS,
            ['filter' => 'host.name in names', 'filter_vars' => ['names' => $neighbours]]
        ) : [];

        try {
            $services = $api(
                'objects/services?' . self::SERVICE_ATTRS,
                ['filter' => 'host.name in names', 'filter_vars' => ['names' => $selection['names']]]
            );
        } catch (\Exception $e) {
            if ($onServiceError !== null) {
                $onServiceError($e);
            }
            $services = null;
        }

        return GraphBuilder::build($selection, array_merge($groupHosts, $neighbourHosts), $services, $hostPath);
    }

    private static function names(array $hosts)
    {
        return array_values(array_map(function ($host) {
            return (string) $host['name'];
        }, $hosts));
    }
}
