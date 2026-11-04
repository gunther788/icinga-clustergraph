<?php


namespace Icinga\Module\Clustergraph\Controllers;

error_reporting(E_ALL);
ini_set('display_errors', '1');

use Icinga\Application\Icinga;
use Icinga\Application\Logger;
use Icinga\Module\Clustergraph\Common\GraphBuilder;
use Icinga\Module\Clustergraph\Common\IcingaApi;
use Icinga\Module\Clustergraph\Common\IcingaDbZones;
use Icinga\Module\Clustergraph\Common\IdoZones;
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


        $api = new IcingaApi();
        $hosts = $api->sendCommand(
            'GET',
            'objects/hosts?attrs=name&attrs=display_name&attrs=state&attrs=last_check&attrs=groups&attrs=zone'
            . '&attrs=last_reachable&attrs=acknowledgement&attrs=downtime_depth'
        );
        $dependencies = $api->sendCommand(
            'GET',
            'objects/dependencies?attrs=parent_host_name&attrs=child_host_name&attrs=child_service_name'
        );

        if (!is_array($hosts) || !is_array($dependencies)) {
            throw new \Exception("Failed to fetch or decode data from the Icinga2 API.");
        }

        // Every host in the "synthetic" group, plus direct parents and children
        $selection = GraphBuilder::select($hosts, $dependencies, 'synthetic');

        // Services of the drawn hosts, filtered on the Icinga side. Without
        // them (no services, or the API user may not query them) the graph is
        // drawn without service problem rings.
        $services = [];
        if ($selection['names']) {
            try {
                $services = $api->sendCommand(
                    'GET',
                    'objects/services?attrs=host_name&attrs=state&attrs=last_check'
                    . '&attrs=acknowledgement&attrs=downtime_depth',
                    ['filter' => 'host.name in names', 'filter_vars' => ['names' => $selection['names']]]
                );
            } catch (\Exception $e) {
                Logger::warning('clustergraph: could not fetch services: %s', $e->getMessage());
                $services = null;
            }
        }

        $this->_helper->json(GraphBuilder::build($selection, $hosts, $services, $ICINGAWEB_HOST_PATH));
    }


}

