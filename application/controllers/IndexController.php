<?php


namespace Icinga\Module\Topologygraph\Controllers;

error_reporting(E_ALL);
ini_set('display_errors', '1');

use Icinga\Application\Icinga;
use Icinga\Application\Logger;
use Icinga\Module\Topologygraph\Common\GraphExplain;
use Icinga\Module\Topologygraph\Common\GraphSource;
use Icinga\Module\Topologygraph\Common\HostGroupPatterns;
use Icinga\Module\Topologygraph\Common\IcingaApi;
use Icinga\Module\Topologygraph\Common\JsonCache;
use Icinga\Web\Controller;

class IndexController extends Controller
{
    public function indexAction()
    {
        $config = \Icinga\Application\Config::module('topologygraph');

        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');


        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }

        $this->view->tabs = $this->getTabs();

    }

    /**
     * Serve the vendored ELK layout library (elkjs). It is large, so instead of
     * adding it to the script bundle Icinga Web loads on every page, the graph
     * page loads it from here only when the ELK layout is chosen.
     */
    public function elkAction()
    {
        $file = $this->Module()->getBaseDir() . '/public/js/vendor/elkjs/elk.bundled.js';
        if (! is_readable($file)) {
            $this->httpNotFound('ELK is not installed');
        }

        header('Content-Type: application/javascript; charset=utf-8');
        header('Content-Length: ' . filesize($file));
        header('Cache-Control: public, max-age=604800');
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', filemtime($file)) . ' GMT');
        readfile($file);
        exit;
    }

    public function testAction()
    {
        echo "Test Successful";
        exit;
    }


    /**
     * The graph as JSON. hostgroup= (repeatable) chooses the host groups to
     * graph, from those the module settings offer; without it, or if none of
     * them is offered, the default host group is graphed.
     */
    public function dataAction()
    {
        $source = $this->source();
        list($groups, $ignored) = $source['choose']($this->params->getValues('hostgroup'));
        $graph = $source['graph']($groups);
        $graph['hostgroups'] = $groups;
        $graph['hostgroups_ignored'] = $ignored;
        $graph['hostgroups_offered'] = $source['offered']();
        $graph['hostgroup_default'] = $source['default'];
        // Older pages read a single host group from here
        $graph['hostgroup'] = implode(', ', $groups);
        $graph['refresh'] = $source['refresh'];
        $this->_helper->json($graph);
    }

    /**
     * The graph as JSON with explanations: why each host is drawn, how
     * (member or outside), and which of them a host selection shows. Takes the
     * same host= and hostgroup= parameters as the graph page, and lists the
     * selected hosts that are not in the graph, with the reason.
     */
    public function explainAction()
    {
        $source = $this->source();
        list($groups, $ignored) = $source['choose']($this->params->getValues('hostgroup'));
        $explanation = GraphExplain::explain(
            $source['graph']($groups),
            $groups,
            $this->params->getValues('host'),
            $source['api']
        );
        $explanation = ['generated' => date('c')] + $explanation;
        if ($ignored) {
            $explanation['hostgroups_ignored'] = [
                'names'  => $ignored,
                'reason' => 'not among the host groups offered in the module settings'
            ];
        }

        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($explanation, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    /**
     * Where the graph comes from, per the module settings
     *
     * @return array [
     *     'api'     => callable for the Icinga API,
     *     'default' => the default host group,
     *     'refresh' => refresh interval in seconds,
     *     'offered' => function (): offered host groups [['name', 'label'], ...],
     *     'choose'  => function (string[] $requested): [groups to graph, requested ones not offered],
     *     'graph'   => function (string[] $groups): the graph, shared through the cache
     * ]
     */
    private function source()
    {
        $config = \Icinga\Application\Config::module('topologygraph');
        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');
        $ICINGAWEB_TYPE = $config->get('graph', 'ui');

        $ICINGAWEB_BASEURL = Icinga::app()->getRequest()->getBaseUrl() . '/';
        $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'icingadb/host?name=';
        if ($ICINGAWEB_TYPE == 'icingaweb2') {
            $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'monitoring/host/show?host=';
        }

        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }

        // Default host group, the others on offer, and refresh interval
        $default = trim((string) $config->get('graph', 'hostgroup', 'synthetic'));
        if ($default === '') {
            $default = 'synthetic';
        }
        $patternText = (string) $config->get('graph', 'hostgroups', '');
        $patterns = new HostGroupPatterns($patternText);
        $refresh = max(5, (int) $config->get('graph', 'refresh', 15));

        // Everyone looking at the graph gets the same data (one API user), so
        // share it for half the refresh interval: several open pages then cause
        // one set of API requests instead of one each
        $cache = new JsonCache(sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'icingaweb2-topologygraph');
        $cacheBase = [$ICINGA_API_ENDPOINT, $config->get('api', 'port'), $ICINGA_API_USER];
        $api = $this->apiCallable(new IcingaApi());

        // The list of host groups rarely changes: keep it for five minutes
        // (without the HostGroup permission, only the default is offered)
        $offered = function () use ($cache, $cacheBase, $patterns, $patternText, $default, $api) {
            try {
                return $cache->remember(json_encode(array_merge($cacheBase, ['offered', $patternText, $default])), 300,
                    function () use ($patterns, $api, $default) {
                        return $patterns->offered($api, $default);
                    });
            } catch (\Exception $e) {
                Logger::warning('topologygraph: could not fetch host groups: %s', $e->getMessage());
                return [['name' => $default, 'label' => $default]];
            }
        };

        // Requested groups that aren't offered are ignored
        $choose = function (array $requested) use ($patterns, $default, $offered) {
            return $patterns->choose($requested, $default, function () use ($offered) {
                return array_column($offered(), 'name');
            });
        };

        $graph = function (array $groups) use ($cache, $cacheBase, $refresh, $api, $ICINGAWEB_HOST_PATH) {
            sort($groups, SORT_STRING);
            $key = json_encode(array_merge($cacheBase, [$groups, $ICINGAWEB_HOST_PATH]));
            return $cache->remember($key, intdiv($refresh, 2), function () use ($api, $groups, $ICINGAWEB_HOST_PATH) {
                return GraphSource::fetch(
                    $api,
                    $groups,
                    $ICINGAWEB_HOST_PATH,
                    function (\Exception $e) {
                        Logger::warning('topologygraph: could not fetch services: %s', $e->getMessage());
                    }
                );
            });
        };

        return compact('api', 'default', 'refresh', 'offered', 'choose', 'graph');
    }

    private function apiCallable(IcingaApi $api)
    {
        return function ($endpoint, $body) use ($api) {
            $results = $api->sendCommand('GET', $endpoint, $body);
            if (! is_array($results)) {
                throw new \Exception("Failed to fetch or decode data from the Icinga2 API.");
            }
            return $results;
        };
    }
}

