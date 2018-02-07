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

function makeCallBack (resolve, reject) {
  return (err, res, body) => {
    if (typeof body === 'string') body = JSON.parse(body)
    if (err || body.error) return reject(err || body)
    else return resolve()
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

  _checkDb (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName].join('/')
      request({ url }, done)
    })
  }

  _createDb (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'PUT',
        json: { q: this.q }
      }, done)
    })
  }

  _destroyDb (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'DELETE'
      }, done)
    })
  }

  _isAvailable (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName, '_local', 'in-maintenance'].join('/')
      request({ url }, done)
    })
  }

  _setUnavailable (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName, '_local', 'in-maintenance'].join('/')
      request({
        url,
        method: 'PUT',
        json: { down: true }
      }, done)
    })
  }

  _setAvailable (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName, '_local', 'in-maintenance'].join('/')
      request({
        url,
        method: 'GET',
        json: true
      }, (err, res, doc) => {
        if (doc.error) {
          if (doc.error === 'not_found') return resolve()
          else return reject(doc)
        }
        if (err) return reject(err)
        request({
          url,
          method: 'DELETE',
          json: { rev: doc._rev }
        }, done)
      })
    })
  }

  _replicate (source, target) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, '_replicate'].join('/')
      request({
        url,
        method: 'POST',
        json: { source, target }
      }, done)
    })
  }

  start () {
    log('Creating temp db:', this.db2)
    return this._createDb(this.db2).then(() => {
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
    }).catch((e) => {
      log('Unexpected error: %j', e)
      return this.rollBack()
    })
  }

  rollBack () {
    log('Rolling back changes...')
    return this._checkDb(this.db2).then(() => {
      log('Restoring documents from temp to primary...')
      return this._replicate(this.db2, this.db1)
    }).then(() => {
      log('Removing temp db...')
      return this._destroyDb(this.db2)
    }).then(() => {
      log('Setting primary as available...')
      return this._setAvailable(this.db1)
    })
  }
}
