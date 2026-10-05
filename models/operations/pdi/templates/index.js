'use strict';

const general = require('./general');
const autonxt = require('./autonxt');
const autonxtController = require('./autonxt_controller');

const TEMPLATES = [general, autonxt, autonxtController];

module.exports = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
