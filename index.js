var Libpq = require('libpq');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var Client = module.exports = function(types) {
  if(!(this instanceof Client)) {
    return new Client(types);
  }

  EventEmitter.call(this);
  if(!types) {
    var pgTypes = require('pg-types');
    types = pgTypes.getTypeParser.bind(pgTypes);
  } else {
    types = types.getTypeParser.bind(types);
  }
  this.pq = new Libpq();
  this.types = types;
  this._reading = false;
  this._read = this._read.bind(this);
  var self = this;
  this.on('newListener', function(event) {
    if(event != 'notification') return;
    self._startReading();
  })
};

util.inherits(Client, EventEmitter);

Client.prototype.connect = function(params, cb) {
  this.pq.connect(params, cb);
};

Client.prototype.connectSync = function(params) {
  this.pq.connectSync(params);
};

Client.prototype.end = function(cb) {
  this._stopReading();
  this.pq.finish();
  if(cb) setImmediate(cb);
};

Client.prototype._readError = function(message) {
  this._stopReading();
  var err = new Error(message || this.pq.errorMessage());
  this.emit('error', err);
};

Client.prototype._stopReading = function() {
  if(!this._reading) return;
  this._reading = false;
  this.pq.stopReader();
  this.pq.removeListener('readable', this._read);
};

//called when libpq is readable
Client.prototype._read = function() {
  var pq = this.pq;
  //read waiting data from the socket
  //e.g. clear the pending 'select'
  if(!pq.consumeInput()) {
    return this._readError();
  }

  //check if there is still outstanding data
  //if so, wait for it all to come in
  if(pq.isBusy()) {
    return;
  }

  //load our result object
  while(pq.getResult()) {
    if(pq.resultStatus() == 'PGRES_COPY_OUT')  break;
  };

  var status = pq.resultStatus();
  switch(status) {
    case 'PGRES_FATAL_ERROR':
      return this._readError();
    case 'PGRES_COMMAND_OK':
    case 'PGRES_TUPLES_OK':
    case 'PGRES_COPY_OUT':
    case 'PGRES_EMPTY_QUERY': {
      this.emit('result');
      break;
    }
    default:
      return this._readError('unrecognized cmmand status: ' + status);
  }

  var notice;
  while(notice = this.pq.notifies()) {
    this.emit('notification', notice);
  }
};

//ensures the client is reading and
//everything is set up for async io
Client.prototype._startReading = function() {
  if(this._reading) return;
  this._reading = true;
  this.pq.setNonBlocking(true);
  this.pq.startReader();
  this.pq.on('readable', this._read);
};

var throwIfError = function(pq) {
  var err = pq.resultErrorMessage() || pq.errorMessage();
  if(err) {
    throw new Error(err);
  }
}

var mapResults = function(pq, types) {
  var rows = [];
  var rowCount = pq.ntuples();
  var colCount = pq.nfields();
  for(var i = 0; i < rowCount; i++) {
    var row = {};
    rows.push(row);
    for(var j = 0; j < colCount; j++) {
      var rawValue = pq.getvalue(i, j);
      var value = rawValue;
      if(rawValue == '') {
        if(pq.getisnull()) {
          value = null;
        }
      } else {
        value = types(pq.ftype(j))(rawValue);
      }
      row[pq.fname(j)] = value;
    }
  }
  return rows;
};

Client.prototype._awaitResult = function(cb) {
  this._startReading();
  var self = this;
  var onError = function(e) {
    self.removeListener('error', onError);
    self.removeListener('result', onResult);
    cb(e);
  };

  var onResult = function() {
    self.removeListener('error', onError);
    self.removeListener('result', onResult);
    cb(null);
  };
  this.once('error', onError);
  this.once('result', onResult);
}

//wait for the writable socket to drain
var waitForDrain = function(pq, cb) {
  var res = pq.flush();
  if(res === 0) return cb();
  if(res === -1) return cb(pq.errorMessage());
  return pq.writable(function() {
    waitForDrain(pq, cb);
  });
};

//send an async query to libpq and wait for it to
//finish writing query text to the socket
var dispatchQuery = function(pq, fn, cb) {
  var success = pq.setNonBlocking(true);
  if(!success) return cb(new Error('Unable to set non-blocking to true'));
  var sent = fn();
  if(!sent) return cb(new Error(pq.errorMessage() || 'Something went wrong dispatching the query'));
  return waitForDrain(pq, cb);
};

Client.prototype.query = function(text, values, cb) {
  var queryFn;
  var pq = this.pq
  var types = this.types
  if(typeof values == 'function') {
    cb = values;
    queryFn = function() { return pq.sendQuery(text); };
  } else {
    queryFn = function() { return pq.sendQueryParams(text, values); };
  }

  var self = this
  dispatchQuery(pq, queryFn, function(err) {
    if(err) return cb(err);
    self._awaitResult(function(err) {
      return cb(err, err ? null : mapResults(pq, types));
    });
  });
};

Client.prototype.prepare = function(statementName, text, nParams, cb) {
  var self = this;
  var pq = this.pq;
  var fn = function() {
    return pq.sendPrepare(statementName, text, nParams);
  }
  dispatchQuery(pq, fn, function(err) {
    if(err) return cb(err);
    self._awaitResult(cb);
  });
};

Client.prototype.execute = function(statementName, parameters, cb) {
  var pq = this.pq;
  var self = this;
  var types = this.types;
  var fn = pq.sendQueryPrepared.bind(pq, statementName, parameters);
  dispatchQuery(pq, fn, function(err, rows) {
    if(err) return cb(err);
    self._awaitResult(function(err) {
      return cb(err, err ? null : mapResults(pq, types));
    });
  });
};

var CopyStream = require('./lib/copy-stream');
Client.prototype.getCopyStream = function() {
  this.pq.setNonBlocking(true);
  this._stopReading();
  return new CopyStream(this.pq);
};

Client.prototype.querySync = function(text, values) {
  var queryFn;
  var pq = this.pq;
  pq[values ? 'execParams' : 'exec'].call(pq, text, values);
  throwIfError(this.pq);
  return mapResults(pq, this.types);
};

Client.prototype.prepareSync = function(statementName, text, nParams) {
  this.pq.prepare(statementName, text, nParams);
  throwIfError(this.pq);
};

Client.prototype.executeSync = function(statementName, parameters) {
  this.pq.execPrepared(statementName, parameters);
  throwIfError(this.pq);
  return mapResults(this.pq, this.types);
};
