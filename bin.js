#!/usr/bin/env node
'use strict'

const CouchContinuum = require('.')

const prefix = '[couch-continuum]'
function log () {
  arguments[0] = [prefix, arguments[0]].join(' ')
  console.log.apply(console, arguments)
}

require('yargs')
  .command({
    command: '$0',
    aliases: ['start'],
    builder: function (yargs) {
      yargs.options({
        couchUrl: {
          alias: 'u',
          description: 'The URL of the CouchDB cluster to act upon.',
          default: process.env.COUCH_URL || 'http://localhost:5984'
        },
        dbName: {
          alias: 'n',
          description: 'The name of the database to modify.',
          required: true,
          type: 'string'
        },
        q: {
          description: 'The desired "q" value for the new database.',
          required: true,
          type: 'number'
        },
        verbose: {
          alias: 'v',
          description: 'Enable verbose logging.'
        }
      })
    },
    handler: function (argv) {
      const { couchUrl, dbName, q, verbose } = argv
      if (verbose) process.env.LOG = true
      const continuum = new CouchContinuum({ couchUrl, dbName, q })
      log(`Migrating database '${dbName}' to { q: ${q} }...`)
      continuum.start().then(function () {
        log('...success!')
      })
    }
  })
  .config()
  .alias('h', 'help')
  .parse()
