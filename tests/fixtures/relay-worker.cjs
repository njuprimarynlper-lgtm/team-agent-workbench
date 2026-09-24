// Run the production utility-process entry through Node IPC for background tests.
const { EventEmitter } = require('node:events');
const parent = new EventEmitter();
parent.postMessage = value => process.send(value);
process.parentPort = parent;
process.on('message', data => parent.emit('message', { data }));
process.on('disconnect', () => process.exit(0));
require(process.argv[2]);
