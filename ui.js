var inited = false;

module.exports = function(RED) {
	if (!inited) {
		inited = true;
		init(RED.server, RED.httpAdmin, RED.log, RED.settings);
	}
	
	return { 
		add: add, 
		emit: emit,
		toNumber: toNumber,
	};
};

var serveStatic = require('serve-static'),
	socketio = require('socket.io'),
	path = require('path'),
	fs = require('fs'),
	events = require('events');

var tabs = [];

var updateValueEventName = 'update-value';

var io = undefined;
var currentValues = {};
var replayMessages = {};
var ev = new events.EventEmitter();
var settings = {};

function toNumber(config, input) {
	if (typeof input === "number")
		return input;
	
	var nr = parseInt(input.toString());
	return isNaN(nr) ? config.min : nr;
}

function emit(event, data) {
	io.emit(event, data);
}

function noConvert(value) {
	return value;
}

function beforeEmit(msg, value) {
	return { value: value };
}

function beforeSend(msg) {
	//do nothing
}

/*
options:
	node - the node that represents the control on a flow
	control - the control to be added
	tab - tab config node that this control belongs to
	group - group name
	[emitOnlyNewValues] - boolean (default true). 
		If true, it checks if the payload changed before sending it
		to the front-end. If the payload is the same no message is sent.
	
	[convert] - callback to convert the value before sending it to the front-end
	[convertBack] - callback to convert the message from front-end before sending it to the next connected node
	
	[beforeEmit] - callback to prepare the message that is emitted to the front-end
	[beforeSend] - callback to prepare the message that is sent to the output 
*/
function add(opt) {
	if (typeof opt.emitOnlyNewValues === 'undefined')
		opt.emitOnlyNewValues = true;
	opt.beforeEmit = opt.beforeEmit || beforeEmit;
	opt.beforeSend = opt.beforeSend || beforeSend;
	opt.convert = opt.convert || noConvert;
	opt.convertBack = opt.convertBack || noConvert;
	opt.control.id = opt.node.id;
	var remove = addControl(opt.tab, opt.group, opt.control);
	
	opt.node.on("input", function(msg) {
		var oldValue = currentValues[opt.node.id];
		var newValue = opt.convert(msg.payload, oldValue, msg);

		if (typeof newValue !== 'undefined' && (!opt.emitOnlyNewValues || oldValue != newValue)) {
			currentValues[opt.node.id] = newValue;
			
			var toEmit = opt.beforeEmit(msg, newValue);
			toEmit.id = opt.node.id;
			io.emit(updateValueEventName, toEmit);
			replayMessages[opt.node.id] = toEmit;
 
 			if (opt.node._wireCount) {
				//forward to output
				msg.payload = opt.convertBack(newValue);
				opt.beforeSend(msg);
				opt.node.send(msg);
			}
		}
	});
	
	var handler = function (msg) {
		if (msg.id !== opt.node.id) return;
		var converted = opt.convertBack(msg.value);
		currentValues[msg.id] = converted;
		replayMessages[msg.id] = msg;
		
		var toSend = {payload: converted};
		opt.beforeSend(toSend);
		opt.node.send(toSend);
		
		//fwd to all UI clients
		io.emit(updateValueEventName, msg);
	};
	
	ev.on(updateValueEventName, handler);
	
	return function() {
		ev.removeListener(updateValueEventName, handler);
		remove();
		delete currentValues[opt.node.id];
		delete replayMessages[opt.node.id];
	};
}

//from: http://stackoverflow.com/a/28592528/3016654
function join() {
	var trimRegex = new RegExp('^\\/|\\/$','g'),
	paths = Array.prototype.slice.call(arguments);
	return '/'+paths.map(function(e){return e.replace(trimRegex,"");}).filter(function(e){return e;}).join('/');
}

function init(server, app, log, redSettings) {
	var uiSettings = redSettings.ui || {};
	settings.path = uiSettings.path || 'ui';
	settings.title = uiSettings.title || 'Node-Red UI';
	settings.defaultGroupHeader = uiSettings.defaultGroup || 'Default';
	
	var fullPath = join(redSettings.httpAdminRoot, settings.path);
	var socketIoPath = join(fullPath, 'socket.io');
	
	io = socketio(server, {path: socketIoPath});

	fs.stat(path.join(__dirname, 'dist/index.html'), function(err, stat) { 
		if (!err) { 
			app.use(join(settings.path), serveStatic(path.join(__dirname, "dist"))); 
		} else {
			log.info("Using development folder");
			app.use(join(settings.path), serveStatic(path.join(__dirname, "src")));
			
			var vendor_packages = [
				'angular', 'angular-sanitize', 
				'angular-animate', 'angular-aria', 
				'angular-material', 'angular-material-icons',
				
				'd3', 'nvd3', 'angularjs-nvd3-directives'
			];
			
			vendor_packages.forEach(function (packageName) {
				app.use(join(settings.path, 'vendor', packageName), serveStatic(path.join(__dirname, 'node_modules', packageName)));
			});
		}
	}); 

	log.info("UI started at " + fullPath);

	io.on('connection', function(socket) {
		updateUi(socket);
		
		socket.on(updateValueEventName, 
			ev.emit.bind(ev, updateValueEventName));
		
		socket.on('ui-replay-state', function() {
			var ids = Object.getOwnPropertyNames(replayMessages);
			ids.forEach(function (id) {
				socket.emit(updateValueEventName, replayMessages[id]);
			});
			
			socket.emit('ui-replay-done');
		});
	});
}

var updateUiPending = false;
function updateUi(to) {
	if (!to) {
		if (updateUiPending) return; 
		updateUiPending = true;
		to = io;
	}

	process.nextTick(function() {
		to.emit('ui-controls', {
			title: settings.title,
			tabs: tabs
		});
		updateUiPending = false;
	});
}

function find(array, predicate) {
	for (var i=0; i<array.length; i++) {
		if (predicate(array[i]))
			return array[i];
	}
}

function itemSorter(item1, item2) {
	return item1.order - item2.order;
}

function addControl(tab, groupHeader, control) {
	if (typeof control.type !== 'string') return;
	groupHeader = groupHeader || settings.defaultGroupHeader;
	control.order = parseInt(control.order);
	
	var foundTab = find(tabs, function (t) {return t.id === tab.id });
	if (!foundTab) {
		foundTab = {
			id: tab.id,
			header: tab.config.name,
			order: parseInt(tab.config.order),
			icon: tab.config.icon,
			items: []
		};
		tabs.push(foundTab);
		tabs.sort(itemSorter);
	}
	
	var foundGroup = find(foundTab.items, function (g) {return g.header === groupHeader;});
	if (!foundGroup) {
		foundGroup = {
			header: groupHeader,
			items: []
		};
		foundTab.items.push(foundGroup);
	}
	foundGroup.items.push(control);
	foundGroup.items.sort(itemSorter);
	
	foundGroup.order = foundGroup.items.reduce(function (prev, c) { return prev + c.order; }, 0) / foundGroup.items.length;
	foundTab.items.sort(itemSorter);
	
	updateUi();
	
	return function() {
		var index = foundGroup.items.indexOf(control);
		if (index >= 0) {
			foundGroup.items.splice(index, 1);
			
			if (foundGroup.items.length === 0) {
				index = foundTab.items.indexOf(foundGroup);
				if (index >= 0) {
					foundTab.items.splice(index, 1);
					
					if (foundTab.items.length === 0) {
						index = tabs.indexOf(foundTab);
						if (index >= 0) {
							tabs.splice(index, 1);
						}
					}
				}
			}
			
			updateUi();
		}
	}
}
