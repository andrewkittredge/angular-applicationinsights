/*
 *  angular-applicationinsights
 *	An angularJS module for using Microsoft Application Insights
 *  https://github.com/khaines/angular-applicationinsights
 */

(function (angular) {
/*jshint globalstrict:true*/
'use strict';

	
	var _version='angular-0.0.2';
	var _analyticsServiceUrl = 'https://dc.services.visualstudio.com/v2/track';

	var isDefined = angular.isDefined,
  		isUndefined = angular.isUndefined,
  		isNumber = angular.isNumber,
  		isObject = angular.isObject,
  		isArray = angular.isArray,
  		extend = angular.extend,
  		toJson = angular.toJson,
  		fromJson = angular.fromJson,
  		noop = angular.noop;

  	var	isNullOrUndefined = function(val) {
    	return isUndefined(val) || val === null; 
	};


	var generateGUID = function(){
        var value = [];
        var digits = "0123456789abcdef";
        for (var i = 0; i < 36; i++) {
            value[i] = digits.substr(Math.floor(Math.random() * 0x10), 1);
        }
        value[8] = value[13] = value[18] = value[23] = "-";
        value[14] = "4";
        value[19] = digits.substr((value[19] & 0x3) | 0x8, 1);  
        return value.join("");
	};


	// $log interceptor .. will send log data to application insights, once app insights is 
	// registered. $provide is only available in the config phase, so we need to setup
	// the decorator before app insights is instantiated.
	function LogInterceptor($provide){
		// original functions
		var debugFn,infoFn,warnFn,errorFn,logFn;

		// function to invoke ... initialized to noop
		var interceptFunction = noop;


		this.setInterceptFunction = function(func){
			interceptFunction = func;
		};

		this.getPrivateLoggingObject = function(){
			return {
				debug: isNullOrUndefined(debugFn) ? noop : debugFn,
				info: isNullOrUndefined(infoFn) ? noop : infoFn,
				warn: isNullOrUndefined(warnFn) ? noop : warnFn,
				error: isNullOrUndefined(errorFn) ? noop : errorFn,
				log: isNullOrUndefined(logFn) ? noop : logFn
			};
		};

		var delegator = function(orignalFn, level){
			return function( ){
				var args    = [].slice.call(arguments);
 
                  // track the call
                  interceptFunction(args[0],level);
                  // Call the original 
                  orignalFn.apply(null, args);
			};
		};

		$provide.decorator( '$log', [ "$delegate", function( $delegate )
        {
                debugFn = $delegate.debug;
 				infoFn = $delegate.info;
 				warnFn = $delegate.warn;
 				errorFn = $delegate.error;
 				logFn = $delegate.log;

                $delegate.debug = delegator(debugFn, 'debug');
                $delegate.info = delegator(infoFn, 'info');
                $delegate.warn = delegator(warnFn, 'warn');
                $delegate.error = delegator(errorFn,'error');
                $delegate.log = delegator(logFn,'log');
 
                return $delegate;
        }]);

	}

	var _logInterceptor;


	var angularAppInsights = angular.module('ApplicationInsightsModule', ['LocalStorageModule']);

	// setup some features that can only be done during the configure pass
	angularAppInsights.config(['$provide',function ($provide) {
    	 _logInterceptor = new LogInterceptor($provide);
	}]);

	angularAppInsights.provider('applicationInsightsService', function() {
		// configuration properties for the provider
		var _instrumentationKey = '';
		var _applicationName =''; 
		var _enableAutoPageViewTracking = true;

		this.configure = function(instrumentationKey, applicationName, enableAutoPageViewTracking){
			_instrumentationKey = instrumentationKey;
			_applicationName = applicationName;
			_enableAutoPageViewTracking = isNullOrUndefined(enableAutoPageViewTracking) ? true : enableAutoPageViewTracking;
		};


		// invoked when the provider is run
		this.$get = ['localStorageService', '$http', '$locale','$window','$location', function(localStorageService, $http, $locale, $window, $location){	
				return new ApplicationInsights(localStorageService, $http, $locale, $window, $location);
		}];



		// Application Insights implementation
		function ApplicationInsights(localStorage, $http, $locale, $window, $location){
			
			var _log = _logInterceptor.getPrivateLoggingObject(); // so we can log output without causing a recursive loop.
			var _contentType = 'application/json';
			var _namespace = 'Microsoft.ApplicationInsights.';
			var _names = {
  				pageViews: _namespace+'Pageview',
  				traceMessage: _namespace +'Message',
  				events: _namespace +'Event',
  				metrics: _namespace +'Metric'
  			};
  			var _types ={
  				pageViews: _namespace+'PageviewData',
  				traceMessage: _namespace+'MessageData',
  				events: _namespace +'EventData',
  				metrics: _namespace +'MetricData'
  			};

			var getUUID = function(){
				var uuidKey = '$$appInsights__uuid';
				// see if there is already an id stored locally, if not generate a new value
				var uuid =  localStorage.get(uuidKey);
				if(isNullOrUndefined(uuid)){
					uuid = generateGUID();
					localStorage.set(uuidKey, uuid);
				}
				return uuid;
			};

			var sessionKey = '$$appInsights_session';
			var makeNewSession = function(){
				// no existing session data
					var sessionData = {
						id:generateGUID(),
						accessed: new Date().getTime()
					};
					localStorage.set(sessionKey,sessionData);
					return sessionData;
			};

			var getSessionID = function(){
				_log.debug('getSessionID called');
				var sessionData = localStorage.get(sessionKey);
				_log.debug('sessionData = '+ toJson(sessionData));
				if(isNullOrUndefined(sessionData)){
					_log.debug('no existing session data');
					// no existing session data
					sessionData = makeNewSession();
				}
				else
				{
					_log.debug('existing session data');
					// session data exists ... see if it has past the inactivity timeout 
					// TODO: Make this configurable during the config option refactoring.
					var inactivityTimeout = 1800000; // 30mins in ms
					var lastAccessed = isNullOrUndefined(sessionData.accessed) ? 0 : sessionData.accessed;
					var now = new Date().getTime();
					if(( now - lastAccessed > inactivityTimeout))
					{
						_log.debug('session is expired, generating new data');
						// this session is expired, make a new one
						sessionData = makeNewSession();
					}
					else
					{
						_log.debug('session data is current, reusing existing data');
						// valid session, update the last access timestamp
						sessionData.accessed = now;
						localStorage.set(sessionKey, sessionData);
					}
				}

				return sessionData.id;
			};

			var sendData = function(data){
				var request = {
					method: 'POST',
					url:_analyticsServiceUrl,
					headers: {
						'Content-Type': _contentType
					},
					data:data
				};

				$http(request);
			};

			var trackPageView = function(pageName){
				var data = generateAppInsightsData(_names.pageViews, 
											_types.pageViews,
											{
												ver: 1,
												url: $location.absUrl(),
												name: isNullOrUndefined(pageName) ? $location.path() : pageName 
											});
				sendData(data);
			};

			var trackEvent = function(eventName){
				var data = generateAppInsightsData(_names.events,
											_types.events,
											{
												ver:1,
												name:eventName
											});
				sendData(data);
			};

			var trackTraceMessage = function(message, level){
				var data = generateAppInsightsData(_names.traceMessage, 
											_types.traceMessage,
											{
												ver: 1,
												message: message,
												severity: level
											});
				sendData(data);
			};

			var trackMetric = function(name, value){
				var data = generateAppInsightsData(_names.metrics, 
												_types.metrics,
												{
													ver: 1,
													metrics: [{name:name,value:value}]
												});
				sendData(data);
			};

			var generateAppInsightsData = function(payloadName, payloadDataType, payloadData){

				return {
					name: payloadName,
					time: new Date().toISOString(),
					ver: 1,
					iKey: _instrumentationKey,
					user: {id: getUUID()},
					session: {
						id: getSessionID()
					},
					operation: {
						id: generateGUID()
					},
					device: {
						id: 'browser',
						locale: $locale.id,
						resolution: $window.screen.availWidth +'x'+ $window.screen.availHeight
					},
					internal: {
						sdkVersion: _version
					},
					data:{
						type: payloadDataType,
						item: payloadData
					}
				};
			};

			// set traceTraceMessage as the intercept method of the log decorator
			_logInterceptor.setInterceptFunction(trackTraceMessage);

			// public api surface
			return {
				'trackPageView': trackPageView,
				'trackTraceMessage': trackTraceMessage,
				'trackEvent': trackEvent,
				'trackMetric': trackMetric,
				'applicationName': _applicationName,
				'autoPageViewTracking': _enableAutoPageViewTracking
			};

		}
	})
	// the run block sets up automatic page view tracking
	.run(['$rootScope', '$location', 'applicationInsightsService', function($rootScope,$location,applicationInsightsService){
        $rootScope.$on('$locationChangeSuccess', function() {
           	
           		if(applicationInsightsService.autoPageViewTracking){
                	applicationInsightsService.trackPageView(applicationInsightsService.applicationName + $location.path());
 				}
        });
     }]);

})( window.angular );