<?php


namespace Icinga\Module\Clustergraph\Controllers;

error_reporting(E_ALL);
ini_set('display_errors', '1');

use Icinga\Application\Icinga;
use Icinga\Application\Logger;
use Icinga\Module\Clustergraph\Common\GraphSource;
use Icinga\Module\Clustergraph\Common\IcingaApi;
use Icinga\Module\Clustergraph\Common\JsonCache;
use Icinga\Web\Controller;

class IndexController extends Controller
{
    public function indexAction()
    {
        $config = \Icinga\Application\Config::module('clustergraph');

        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');


        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }

        $this->view->tabs = $this->getTabs();

    }

    public function testAction()
    {
        echo "Test Successful";
        exit;
    }


    public function dataAction()
    {
        // Configuration

        $config = \Icinga\Application\Config::module('clustergraph');
        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');
        $ICINGAWEB_TYPE = $config->get('graph', 'ui');
        
        $ICINGAWEB_BASEURL = Icinga::app()->getRequest()->getBaseUrl() . '/';
        if ($ICINGAWEB_TYPE == 'icingaweb2') {
            $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'monitoring/host/show?host=';
        } elseif ($ICINGAWEB_TYPE == 'icingadb') {
            $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'icingadb/host?name=';  
        }
        

        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }


        // Host group to draw and refresh interval, from the module settings
        $group = trim((string) $config->get('graph', 'hostgroup', 'synthetic'));
        if ($group === '') {
            $group = 'synthetic';
        }
        $refresh = max(5, (int) $config->get('graph', 'refresh', 15));

        // Everyone looking at the graph gets the same data (one API user), so
        // share it for half the refresh interval: several open pages then cause
        // one set of API requests instead of one each
        $cache = new JsonCache(sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'icingaweb2-clustergraph');
        $cacheKey = json_encode([
            $ICINGA_API_ENDPOINT, $config->get('api', 'port'), $ICINGA_API_USER, $group, $ICINGAWEB_HOST_PATH
        ]);
        $api = new IcingaApi();
        $graph = $cache->remember($cacheKey, intdiv($refresh, 2), function () use ($api, $group, $ICINGAWEB_HOST_PATH) {
            return GraphSource::fetch(
                function ($endpoint, $body) use ($api) {
                    $results = $api->sendCommand('GET', $endpoint, $body);
                    if (! is_array($results)) {
                        throw new \Exception("Failed to fetch or decode data from the Icinga2 API.");
                    }
                    return $results;
                },
                $group,
                $ICINGAWEB_HOST_PATH,
                function (\Exception $e) {
                    Logger::warning('clustergraph: could not fetch services: %s', $e->getMessage());
                }
            );
        });

        $graph['hostgroup'] = $group;
        $graph['refresh'] = $refresh;
        $this->_helper->json($graph);
    }


}

