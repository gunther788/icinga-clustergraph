<?php

namespace Icinga\Module\Topologygraph\Common;

/**
 * The host groups the graph offers, from the module settings: one pattern per
 * line (commas also separate), matched against host group object names.
 *
 *     synthetic        an exact name
 *     app-*            * matches any characters, ? exactly one
 *     !*-test          a leading ! excludes the groups it matches
 *
 * A group is offered if it matches at least one pattern without ! and no
 * pattern with !. The default host group is always offered.
 */
final class HostGroupPatterns
{
    /** @var string[] */
    private $include = [];

    /** @var string[] */
    private $exclude = [];

    public function __construct($text)
    {
        foreach (preg_split('/[\r\n,]+/', (string) $text) as $line) {
            $line = trim($line);
            if ($line === '' || $line === '!') {
                continue;
            }
            if ($line[0] === '!') {
                $this->exclude[] = trim(substr($line, 1));
            } else {
                $this->include[] = $line;
            }
        }
        $this->include = array_values(array_unique($this->include));
        $this->exclude = array_values(array_unique(array_filter($this->exclude, 'strlen')));
    }

    /** Whether any group besides the default is offered */
    public function isEmpty()
    {
        return ! $this->include;
    }

    /** Whether a host group name matches, as Icinga's match() would */
    public function matches($name)
    {
        $name = (string) $name;
        $any = function (array $patterns) use ($name) {
            foreach ($patterns as $pattern) {
                if (preg_match(self::regex($pattern), $name)) {
                    return true;
                }
            }
            return false;
        };

        return $any($this->include) && ! $any($this->exclude);
    }

    /**
     * An Icinga API filter for the matching host groups
     *
     * @return array ['filter' => string, 'filter_vars' => array]
     */
    public function apiFilter()
    {
        $vars = [];
        $terms = function (array $patterns, $prefix) use (&$vars) {
            $parts = [];
            foreach ($patterns as $i => $pattern) {
                $vars[$prefix . $i] = $pattern;
                $parts[] = 'match(' . $prefix . $i . ', hostgroup.name)';
            }
            return $parts;
        };
        $filter = '(' . implode(' || ', $terms($this->include, 'include')) . ')';
        $excluded = $terms($this->exclude, 'exclude');
        if ($excluded) {
            $filter .= ' && !(' . implode(' || ', $excluded) . ')';
        }

        return ['filter' => $filter, 'filter_vars' => $vars];
    }

    /**
     * The offered host groups, sorted by name, the default first if it isn't
     * among the matches
     *
     * @param callable $api     function (string $endpoint, array $body): array of API results
     * @param string   $default The default host group
     *
     * @return array[] [['name' => ..., 'label' => ...], ...]
     */
    public function offered(callable $api, $default)
    {
        $groups = [];
        if (! $this->isEmpty()) {
            foreach ($api('objects/hostgroups?attrs=name&attrs=display_name', $this->apiFilter()) as $group) {
                $name = (string) $group['name'];
                // Checked here too, in case the API ignored part of the filter
                if ($this->matches($name)) {
                    $groups[$name] = ['name' => $name, 'label' => (string) ($group['attrs']['display_name'] ?? $name)];
                }
            }
        }
        ksort($groups, SORT_STRING);
        if (! isset($groups[$default])) {
            $groups = [$default => ['name' => $default, 'label' => $default]] + $groups;
        }

        return array_values($groups);
    }

    /**
     * The host groups to graph for those asked for in the page address
     *
     * @param string[] $requested    hostgroup= values
     * @param string   $default      The default host group
     * @param callable $offeredNames function (): string[], the offered group names (only called when needed)
     *
     * @return array [groups to graph, requested groups that are not offered]
     */
    public function choose(array $requested, $default, callable $offeredNames)
    {
        $requested = array_values(array_unique(array_filter(array_map(function ($name) {
            return trim((string) $name);
        }, $requested), 'strlen')));
        if (! $requested) {
            return [[$default], []];
        }
        $known = $this->isEmpty() ? [$default] : $offeredNames();
        $groups = array_values(array_filter($requested, function ($name) use ($known) {
            return in_array($name, $known, true);
        }));

        return [$groups ?: [$default], array_values(array_diff($requested, $groups))];
    }

    private static function regex($pattern)
    {
        return '/^' . strtr(preg_quote($pattern, '/'), ['\*' => '.*', '\?' => '.']) . '$/su';
    }
}
