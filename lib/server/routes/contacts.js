'use strict';

const Router = require('./index');
const errors = require('storj-service-error-types');
const inherits = require('util').inherits;
const middleware = require('storj-service-middleware');
const log = require('../../logger');
const limiter = require('../limiter').DEFAULTS;
const rawBody = require('../middleware/raw-body');
const {getPOWMiddleware, getChallenge} = require('../middleware/pow');
const {authFarmer} = require('../middleware/farmer-auth');

/**
 * Handles endpoints for all contact related endpoints
 * @constructor
 * @extends {Router}
 */
function ContactsRouter(options) {
  if (!(this instanceof ContactsRouter)) {
    return new ContactsRouter(options);
  }

  Router.apply(this, arguments);

  this.redis = options.redis;
  this.checkPOW = getPOWMiddleware(options.redis);
  this.getLimiter = middleware.rateLimiter(options.redis);
}

inherits(ContactsRouter, Router);

ContactsRouter.DEFAULTS = {
  skip: 0,
  limit: 30
};

/**
 * Returns the correct skip and limit from the supplied page number
 * @private
 */
ContactsRouter.prototype._getSkipLimitFromPage = function(page) {
  page = page || 1;

  return {
    limit: ContactsRouter.DEFAULTS.limit,
    skip: (page - 1) * ContactsRouter.DEFAULTS.limit
  };
};

ContactsRouter.prototype.createChallenge = function(req, res, next) {
  let powOpts = this.config.application.powOpts;
  getChallenge(this.redis, powOpts, function(err, data) {
    if (err) {
      return next(new errors.InternalError(err.message));
    }
    res.status(201).send(data);
  });
};

ContactsRouter.prototype.createContact = function(req, res, next) {
  const Contact = this.storage.models.Contact;
  Contact.record({
    nodeID: req.headers['x-node-id'],
    address: req.body.address,
    port: req.body.port,
    lastSeen: Date.now(),
    spaceAvailable: req.body.spaceAvailable,
    responseTime: 10000, // Need to set a default responseTime for new contacts
    protocol: req.body.protocol
  }, function(err, contact) {
    if (err) {
      return next(new errors.InternalError(err.message));
    }
    // TODO Send 201 status when created, and 200 when it already
    // exists. Multiple calls to record should behave the same,
    // as is current.
    res.status(200).send({
      nodeID: contact.nodeID,
      address: contact.address,
      port: contact.port
    });
  });
};

ContactsRouter.prototype.setDefaultResponseTime = function(nodeID) {
  this.storage.models.Contact.findOneAndUpdate({
    _id: nodeID,
    responseTime: { $exists: false }
  }, {
    $set: {
      responseTime: 10000
    }
  }, {
    upsert: false
  }, (err) => {
    if (err) {
      log.error('Error setting default responseTime for %s, reason: %s',
                nodeID, err.message);
    }
  });
};

ContactsRouter.prototype.setDefaultReputation = function(nodeID) {
  this.storage.models.Contact.findOneAndUpdate({
    _id: nodeID,
    reputation: { $exists: false }
  }, {
    $set: {
      reputation: 0
    }
  }, {
    upsert: false
  }, (err) => {
    if (err) {
      log.error('Error setting default reputation for %s, reason: %s',
                nodeID, err.message);
    }
  });
};

ContactsRouter.prototype.patchContactByNodeID = function(req, res, next) {
  const Contact = this.storage.models.Contact;
  const nodeID = req.headers['x-node-id'];

  const data = {};
  if (req.body.address) {
    data.address = req.body.address;
  }

  if (req.body.port) {
    data.port = req.body.port;
  }

  if (req.body.protocol) {
    data.protocol = req.body.protocol;
  }

  if (req.body.spaceAvailable === false ||
      req.body.spaceAvailable === true) {
    data.spaceAvailable = req.body.spaceAvailable;
  }

  Contact.findOneAndUpdate({ _id: nodeID }, { $set: data }, {
    upsert: false,
    returnNewDocument: true
  }, (err, contact) => {
    if (err) {
      return next(new errors.InternalError(err.message));
    }
    if (!contact) {
      return next(new errors.NotFoundError('Contact not found'));
    }
    if (!contact.responseTime) {
      this.setDefaultResponseTime(nodeID);
    }
    if (!contact.reputation) {
      this.setDefaultReputation(nodeID);
    }

    res.status(201).send({
      nodeID: contact.nodeID,
      address: contact.address,
      port: contact.port,
      spaceAvailable: contact.spaceAvailable
    });
  });
};

/**
 * Lists the contacts according the the supplied query
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Function} next
 */
ContactsRouter.prototype.getContactList = function(req, res, next) {
  const Contact = this.storage.models.Contact;

  let allowedQueryParams = ['address'];
  let opts = this._getSkipLimitFromPage(req.query.page);
  let skip = opts.skip;
  let limit = opts.limit;
  let query = {};

  for (let param in req.query) {
    if (allowedQueryParams.indexOf(param) !== -1) {
      query[param] = req.query[param];
    }
  }

  let cursor = Contact.find(query).skip(skip).limit(limit).sort({
    lastSeen: -1
  });

  cursor.exec(function(err, contacts) {
    if (err) {
      return next(new errors.InternalError(err.message));
    }

    res.status(200).send(contacts.sort(function(c1, c2) {
      return c2.lastSeen - c1.lastSeen;
    }).map(function(c) {
      return c.toObject();
    }));
  });
};

/**
 * Returns the contact information for the given nodeID
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Function} next
 */
ContactsRouter.prototype.getContactByNodeID = function(req, res, next) {
  const Contact = this.storage.models.Contact;

  Contact.findOne({ _id: req.params.nodeID }, function(err, contact) {
    if (err) {
      return next(new errors.InternalError(err.message));
    }

    if (!contact) {
      return next(new errors.NotFoundError('Contact not found'));
    }

    res.status(200).send(contact.toObject());
  });
};

/**
 * Export definitions
 * @private
 */
ContactsRouter.prototype._definitions = function() {
  return [
    ['GET', '/contacts', this.getLimiter(limiter(200)), this.getContactList],
    ['GET', '/contacts/:nodeID', this.getLimiter(limiter(200)), this.getContactByNodeID],
    ['PATCH', '/contacts/:nodeID', this.getLimiter(limiter(200)), rawBody, authFarmer, this.patchContactByNodeID],
    ['POST', '/contacts', this.getLimiter(limiter(200)), this.checkPOW, rawBody, authFarmer, this.createContact],
    ['POST', '/contacts/challenges', this.getLimiter(limiter(200)), rawBody, authFarmer, this.createChallenge]
  ];
};

module.exports = ContactsRouter;
