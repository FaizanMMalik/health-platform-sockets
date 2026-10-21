// db.js
const knex = require('knex');
require('dotenv').config();
const config = require('./knexfile'); // Path to your knexfile.js

const environment = process.env.NODE_ENV || 'development';
const knexConfig = config[environment];

const db = knex(knexConfig);

module.exports = db;



