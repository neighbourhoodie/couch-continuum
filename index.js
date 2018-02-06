'use strict'

const assert = require('assert')
const request = require('request')

const prefix = '[couch-continuum]'
function log () {
  if (process.env.DEBUG || process.env.LOG) {
    arguments[0] = [prefix, arguments[0]].join(' ')
    console.log.apply(console, arguments)
  }
}

module.exports =
class CouchContinuum {
  constructor ({ couchUrl, dbName, q }) {
    assert(couchUrl, 'The Continuum requires a URL for accessing CouchDB.')
    assert(dbName, 'The Continuum requires a target database.')
    assert(q, 'The Continuum requires a desired "q" setting.')
    this.url = couchUrl
    this.db1 = dbName
    this.db2 = this.db1 + '_temp_copy'
    this.q = q
  }

  _createDb (dbName) {
    return new Promise((resolve, reject) => {
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'PUT',
        json: { q: this.q }
      }, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  _destroyDb (dbName) {
    return new Promise((resolve, reject) => {
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'DELETE'
      }, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  _setUnavailable (dbName) {
    return new Promise((resolve, reject) => {
      const url = [this.url, dbName, '_local', 'in-maintenance'].join('/')
      request({
        url,
        method: 'PUT',
        json: { down: true }
      }, (err, res) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  _setAvailable (dbName) {
    return new Promise((resolve, reject) => {
      const url = [this.url, dbName, '_local', 'in-maintenance'].join('/')
      request({
        url,
        method: 'GET',
        json: true
      }, (err, res, doc) => {
        if (err) return reject(err)
        request({
          url,
          method: 'DELETE',
          json: { rev: doc._rev }
        }, (err) => {
          if (err) return reject(err)
          else return resolve()
        })
      })
    })
  }

  _replicate (source, target) {
    return new Promise((resolve, reject) => {
      const url = [this.url, '_replicate'].join('/')
      request({
        url,
        method: 'POST',
        json: { source, target }
      }, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  start () {
    log('Creating temp db:', this.db2)
    return this._createDb(this.db2).then(() => {
      log('Setting primary db as unavailable...')
      return this._setUnavailable(this.db1)
    }).then(() => {
      log('Beginning replication of primary to temp...')
      return this._replicate(this.db1, this.db2)
    }).then(() => {
      log('Replicated. Destroying primary...')
      return this._destroyDb(this.db1)
    }).then(() => {
      log('Recreating primary with new settings...')
      return this._createDb(this.db1)
    }).then(() => {
      log('Setting primary as unavailable (again)...')
      return this._setUnavailable(this.db1)
    }).then(() => {
      log('Beginning replication of temp to primary...')
      return this._replicate(this.db2, this.db1)
    }).then(() => {
      log('Replicated. Destroying temp...')
      return this._destroyDb(this.db2)
    }).then(() => {
      log('Setting primary as available...')
      return this._setAvailable(this.db1)
    })
  }
}
