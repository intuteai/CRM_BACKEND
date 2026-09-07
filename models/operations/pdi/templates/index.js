'use strict';

const general = require('./general');

const TEMPLATES = [general];

module.exports = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
