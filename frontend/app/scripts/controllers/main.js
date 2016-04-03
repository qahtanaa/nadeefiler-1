'use strict';

/**
 * @ngdoc function
 * @name frontendApp.controller:MainCtrl
 * @description
 * # MainCtrl
 * Controller of the frontendApp
 */
angular.module('frontendApp')
  .controller('MainCtrl', function(
    $scope,
    $rootScope,
    $resource,
    ENV,
    Upload,
    uiGridConstants,
    lodash,
    $q,
    highchartsNG
  ) {
    // prepare RESTful resources
    // TODO: move into a factory

    var _ = lodash;

    var Project = $resource(
      ENV.API_BASE_URL + '/projects/:projectId',
      {
        projectId: '@id'
      },
      {
        update: {
          method: 'PUT'
        }
      }
    );

    var Dataset = $resource(
      ENV.API_BASE_URL + '/datasets/:action/:datasetId?projectId=:projectId',
      {
        datasetId: '@id'
      },
      {
        profile: {
          method: 'PUT',
          params: {action: 'profile'}
        }
      }
    );

    var Tuple = $resource(
      ENV.API_BASE_URL + '/tuples?datasetId=:datasetId',
      {
        datasetId: '@id'
      }
    );

    var Result = $resource(
      ENV.API_BASE_URL + '/results?datasetId=:datasetId&key=:key&histogram=:histogram',
      {
        datasetId: '@id'
      }
    );

    // sockets connection
    // TODO jshint complains about io being undefined
    var sailsSocket = io.sails.connect(ENV.SOCKETIO_BASE_URL);
    sailsSocket.on('connect', function() {
      console.log("Socket connected!");
    });
    sailsSocket.on('profilerResults', function(task) {
      console.log("Received socket data for event 'profilerResults'", task);
      var datasetId = task.dataset;
      var dataset = _.find($scope.datasets, function(dataset){return dataset.id === datasetId});
      if (dataset) {
        getResults(dataset);
        $scope.$apply();  // because sailsSocket.on happens outside angular scope
      }
    });

    var socketCommand = function(url) {
      console.log("requesting socket via url: " + url);
      sailsSocket.get(ENV.API_BASE_URL + url, function responseFromServer (body, response) {
        console.log("The server responded with status " + response.statusCode + " and said: ", body);
      });
    }

    var socketSubscribe = function(project) {
      socketCommand('/projects/subscribe/' + project.id);
    };

    var socketUnsubscribe = function(project) {
      socketCommand('/projects/unsubscribe/' + project.id);
    };

    var adaptDatasetResults = function(results, dataset) {
      // pivot results over "profiler" key
      var groups = _.groupBy(results, function(result){return result.profiler;});
      // TODO isolate messystreams logic in its module
      if (groups.messystreams) {
        var unsorted = _(groups.messystreams)
        .map(function(result){
          return {key: result.key, types: resultSorter(result, dataset.count), result: result}
        })
        .groupBy(function(result){return result.key})
        .value();
        var keys = _.map($scope.datasetGrid.columnDefs, 'name');
        dataset.keys = keys;
        groups.messystreams = _.map(keys, function(key){return unsorted[key][0];})

        // setup widget chart
        var widgets = _.filter(dataset.widgets, function(w){return w.type === 'datatypes'});
        if (widgets.length > 0) {
          widgets[0].chartConfig.xAxis.categories = keys;
          var types = ["string", "date", "percent", "float", "integer", "boolean", "null"];
          var colors = ["gray", "lightgreen", "darkblue", "cyan", "blue", "green", "red"];
          widgets[0].chartConfig.series = _.map(types, function(type, index){
            return {
              name: type, color: colors[index],
              data: _.map(keys, function(key){
                return unsorted[key][0].result[type];
              })
            }
          })
        }
      }

      dataset.results = groups;
    };

    var resultSorter = function(result, datasetCount) {
      return _(result)
        .keys()
        .without('key', 'profiler', '$$hashKey', '_id', 'createdAt', 'dataset')
        .map(function(k){return {name: k, count: result[k], percentage: Math.round(result[k]*100/datasetCount)}})
        .filter(function(o){return o.count !== 0})
        .sortBy('count')
        .value();
    }

    Project.query(function(projects){
      $scope.projects = projects;
    });

    $scope.addProject = function () {
      var project = new Project({name: $scope.newProjectName});
      project.$save(function(project){
        $scope.projects.push(project);
        $scope.selectProject(project);
      });
      $scope.newProjectName = '';
    };

    $scope.removeProject = function($event, project, index) {
      project.$remove(function(){
        $scope.projects.splice(index, 1);
        if (project === $scope.selectedProject) {
          $scope.selectProject(null);
        }
      });
      $scope.preventDefault($event);
    };

    $scope.selectProject = function(project) {
      if ($scope.selectedProject === project) {
        console.log("selecting same project, doing nothing");
        return;
      }

      if ($scope.selectedProject)
        socketUnsubscribe($scope.selectedProject);

      $scope.selectedProject = project;
      if (project) {
        Dataset.query({projectId: project.id}, function(datasets){
          $scope.datasets = datasets;
          $scope.selectDataset(null);
          socketSubscribe(project);
        });
      }
    };

    var getResults = function(dataset) {
      Result.query({
        datasetId: dataset.id
      }, function(results){
        adaptDatasetResults(results, dataset);
      });
    }

    var getHistogram = function(dataset, key, type, limit) {
      var deferred = $q.defer();

      Result.query({
        datasetId: dataset.id,
        histogram: type,
        key: key,
        limit: limit
      }, function(histogram){
        if (!dataset.histograms) dataset.histograms = {};
        if (!dataset.histograms[key]) dataset.histograms[key] = {};
        dataset.histograms[key][type] = histogram;
        deferred.resolve(histogram);
      });

      return deferred.promise;
    }

    $scope.selectDataset = function(dataset, index, $event) {
      $scope.selectedDataset = dataset;
      $scope.selectedDatasetIndex = index;

      if (dataset) {
        $scope.datasetGrid.totalItems = dataset.count;
        $scope.datasetGrid.columnDefs = [];
        paginationOptions.sort = null;
        // paginationOptions.pageNumber = 1;
        // $scope.gridApi.pagination.seek(1);
        getPage().then(function(){
          // request dataset results
          // this is chained after getPage because results needs physical order of keys to sort itself
          if (!dataset.results) {
            getResults(dataset);
          }
        })
        if (!dataset.widgets) {
          $scope.resetDatasetWidgets();
        }
      }
      $scope.preventDefault($event);
    };

    $scope.deleteDataset = function() {
      if ($scope.selectedDataset) {
        $scope.selectedDataset.$delete(function(){
          $scope.datasets.splice($scope.selectedDatasetIndex, 1);
          $scope.selectDataset(null);
        });
      }
    };

    $scope.profileDataset = function() {
      if ($scope.selectedDataset) {
        Dataset.profile({}, $scope.selectedDataset);
      }
    };

    $scope.resetDatasetWidgets = function() {
      // install root level widgets per dataset
      var dataset = $scope.selectedDataset;
      if (!dataset) return;

      if (dataset.results) {
        console.log(dataset.results.messystreams)
        var keys = _.map(dataset.results.messystreams, 'key');
      }

      dataset.widgets = [
        {
          sizeX: 3, sizeY: 2, row: 0, col: 0, type: 'datatypes',
          title: 'Data types', vizType: 'chart',
          chartConfig: {
            // highcharts standard options
            options: {
              chart: {
                  type: 'column'
              },
              credits: {enabled: false},
              tooltip: {
                headerFormat: '<span style="font-size: 10px">{point.key}</span><br/>',
                pointFormat: '<span style="font-size: 12px">{series.name}: <b>{point.y}</b></span>'
              },
              plotOptions: {
                column: {
                  stacking: 'normal'
                },
                cursor: 'pointer',
                series: {
                  events: {
                    click: function(event) {
                      if ($scope.datatypeHasHistogram(this))
                        $scope.datatypeClicked(dataset.keys[event.point.x], this.name);
                    }
                  }
                }
              },            
            },
            // The below properties are watched separately for changes.
            title: {text: ''},
            xAxis: {title: {text: ''}},
            yAxis: {title: {text: ''}},
            useHighStocks: false,
            //size (optional) if left out the chart will default to size of the div or something sensible.
            // size: {
            //   width: 400,
            //   height: 300
            // },
          }
        }
      ]
    };

    var paginationOptions = {
      pageNumber: 1,
      pageSize: 10,
      sort: null
    };

    var getPage = function() {
      var deferred = $q.defer();

      $scope.loadingData = true;

      Tuple.query({
        datasetId: $scope.selectedDataset.id,
        pageNumber: paginationOptions.pageNumber,
        pageSize: paginationOptions.pageSize,
        sortColumn: paginationOptions.sort ? paginationOptions.sort.col : null,
        sortDirection: paginationOptions.sort ? paginationOptions.sort.dir : null
      }, function(tuples){
        $scope.datasetGrid.data = tuples;
        $scope.gridApi.core.notifyDataChange(uiGridConstants.dataChange.ALL);
        $scope.loadingData = false;
        deferred.resolve();
      });

      return deferred.promise;
    };

    $scope.datasetGrid = {
      paginationPageSizes: [10, 25, 50, 100],
      paginationPageSize: 10,
      useExternalPagination: true,
      useExternalSorting: true,
      onRegisterApi: function(gridApi) {
        $scope.gridApi = gridApi;
        gridApi.core.on.sortChanged($scope, function(grid, sortColumns) {
          if (sortColumns.length === 0) {
            paginationOptions.sort = null;
          } else {
            paginationOptions.sort = {
              col: sortColumns[0].name,
              dir: sortColumns[0].sort.direction
            };
          }
          getPage();
        });
        gridApi.pagination.on.paginationChanged($scope, function (newPage, pageSize) {
          paginationOptions.pageNumber = newPage;
          paginationOptions.pageSize = pageSize;
          getPage();
        });    
      },
    };

    $scope.gridsterOpts = {
        columns: 6, // the width of the grid, in columns
        pushing: true, // whether to push other items out of the way on move or resize
        floating: true, // whether to automatically float items up so they stack (you can temporarily disable if you are adding unsorted items with ng-repeat)
        swapping: true, // whether or not to have items of the same size switch places instead of pushing down if they are the same size
        width: 'auto', // can be an integer or 'auto'. 'auto' scales gridster to be the full width of its containing element
        colWidth: 'auto', // can be an integer or 'auto'.  'auto' uses the pixel width of the element divided by 'columns'
        rowHeight: 'match', // can be an integer or 'match'.  Match uses the colWidth, giving you square widgets.
        margins: [10, 10], // the pixel distance between each widget
        outerMargin: true, // whether margins apply to outer edges of the grid
        isMobile: true, // stacks the grid items if true
        mobileBreakPoint: 600, // if the screen is not wider that this, remove the grid layout and stack the items
        mobileModeEnabled: true, // whether or not to toggle mobile mode when screen width is less than mobileBreakPoint
        minColumns: 1, // the minimum columns the grid must have
        minRows: 2, // the minimum height of the grid, in rows
        maxRows: 100,
        defaultSizeX: 2, // the default width of a gridster item, if not specifed
        defaultSizeY: 1, // the default height of a gridster item, if not specified
        minSizeX: 1, // minimum column width of an item
        maxSizeX: null, // maximum column width of an item
        minSizeY: 1, // minumum row height of an item
        maxSizeY: null, // maximum row height of an item
        resizable: {
           enabled: true,
           handles: ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']
        },
        draggable: {
           enabled: true, // whether dragging items is supported
           handle: '.my-class' // optional selector for resize handle
        }
    };

    // TODO embed toggle logic in each widget definition module
    $scope.toggleWidget = function(widget) {
      if (!$scope.selectedDataset) {return null;}

      switch(widget.type) {
        case 'data':
        case 'raw':
        case 'histogram':
          return true;
        case 'datatypes':
          var results = $scope.selectedDataset.results;
          return results && results.messystreams;
        default:
          return false;
          // TODO: toggle widget based on its type/status
      }
    };

    $scope.removeWidget = function(widget, index) {
      $scope.selectedDataset.widgets.splice(index, 1);
    };

    $scope.preventDefault = function($event) {
      if ($event) {
        $event.preventDefault();
        $event.stopPropagation();
      }
    };

    $scope.alerts = [];
    $scope.closeAlert = function(index) {
      $scope.alerts.splice(index, 1);
    };

    $scope.uploadFiles = function (files) {
      $scope.uploadedFiles = files;
      if (files && files.length) {
        Upload.upload({
          url: ENV.API_BASE_URL + '/datasets',
          data: {projectId: $scope.selectedProject.id, files: files},
          arrayKey: ''
        }).then(function (response) {
          $scope.alerts.push({type: 'success', message: response.data.message});
          $scope.datasets = $scope.datasets.concat(response.data.datasets);
        }, function (response) {
          $scope.alerts.push({type: 'danger', message: 'Error uploading files (' + response.status + ')'});
        }, function (evt) {
          $scope.uploadProgress = 
            Math.min(100, parseInt(100.0 * evt.loaded / evt.total));
        });
      }
    };

    $scope.datatypeHasHistogram = function(type) {
      return type.name !== 'null';
    }

    $scope.datatypeClicked = function(key, type) {
      // show histogram
      var dataset = $scope.selectedDataset;
      if (!dataset) return;

      var widgetTitle = "'" + key + "' as " + type;
      var widget = {
        sizeX: 2, sizeY: 2, type: 'histogram',
        title: widgetTitle,
        key: key,
        datatype: type,
        vizType: 'chart',
        chartConfig: {
          // highcharts standard options
          options: {
            chart: {
                type: 'column',
                zoomType: 'x'
            },
            credits: {enabled: false},
            column: {
              pointPadding: 0,
              borderWidth: 0,
              groupPadding: 0,
              shadow: false
            },
            legend: {enabled: false},
            tooltip: {
              headerFormat: '<span style="font-size: 10px">{point.key}</span><br/>',
              pointFormat: '<span style="font-size: 12px">Count: <b>{point.y}</b></span>'
            }
          },
          // The below properties are watched separately for changes.
          title: {text: ''},
          xAxis: {title: {text: ''}},
          yAxis: {title: {text: ''}},
          useHighStocks: false,
          //size (optional) if left out the chart will default to size of the div or something sensible.
          // size: {
          //   width: 400,
          //   height: 300
          // },
        }
      }

      dataset.widgets.push(widget);

      // query from server
      getHistogram(dataset, key, type)
      .then(function(histogram){
        widget.chartConfig.series = [{
          name: '', grouping: true, // TODO grouping not working?
          data: _.map(histogram, function(result){
            return result.count;
          })
        }];
        widget.chartConfig.xAxis.categories = _.map(histogram, function(result){
          return result.value;
        });
      })
    }

    $scope.widgetTypeClass = function(widget, vizType) {
      return widget.vizType === vizType ? 'box-content-action-active' : 'box-content-action';
    }

    $scope.toggleWidgetType = function(widget, vizType) {
      if (widget.vizType === vizType) return;
      widget.vizType = vizType;
    }

    /* NOT WORKING! 
    $rootScope.$on('gridster-resized', function(sizes, gridster) {
      console.log('gridster-resized', sizes, gridster);
    })

    $rootScope.$on('gridster-item-initialized', function(item) {
      console.log(item);
    })

    $rootScope.$on('gridster-item-resized', function(item) {
      console.log(item);
    })
    */

  //   $scope.$watch('widgets', function(widgets){
  //     // var dataWidgets = _.filter(widgets, function(widget){
  //     //   return widget.type == 'data'}
  //     // );

  //     // TODO CONSIDER MARGIN WIDTHS
  //     // TODO handle instead in gridster/window resize
  //     $scope.widgetContentHeightUnit = angular.element(document.querySelector('div[gridster]'))[0].offsetWidth / $scope.gridsterOpts.columns;
  //     console.log("widgetContentHeightUnit", $scope.widgetContentHeightUnit);
  // }, true);

  // $scope.widgetContentHeight = function(widget) {
  //   var newHeight = Math.floor(widget.sizeY * $scope.widgetContentHeightUnit) - 40 - 2;
  //   if (widget.type == 'data') {
  //     newHeight -= 26;  // pagination toolbar
  //   }
  //   console.log("some widget height", newHeight);
  //   // $scope.gridApi.core.notifyDataChange(uiGridConstants.dataChange.ALL);
  //   return newHeight;
  // }

  })

  ;