'use strict';

const general = require('./general');
const autonxt = require('./autonxt');

const TEMPLATES = [general, autonxt];

module.exports = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
