/* globals describe, it, before, after */

const assert = require('assert')
const CouchContinuum = require('.')
const request = require('request')
const { name, version } = require('./package.json')

describe([name, version].join(' @ '), function () {
  this.timeout(1000 * 20)
  const couchUrl = process.env.COUCH_URL || 'http://localhost:5984'
  const dbName = 'test-continuum'
  const q = 4

  before(function (done) {
    // ensure db exists
    const url = [couchUrl, dbName].join('/')
    request({ url, method: 'PUT' }, (err) => {
      if (err) return done(err)
      // add test docs
      request({
        url: [url, '_bulk_docs'].join('/'),
        method: 'POST',
        json: {
          docs: [1, 2, 3, 4, 5].map((n) => {
            return { _id: `doc_${n}` }
          })
        }
      }, (err, res, body) => {
        if (err || body.error) return done(err || body)
        else return done()
      })
    })
  })

  after(function (done) {
    // destroy db
    const url = [couchUrl, dbName].join('/')
    request({ url, method: 'DELETE' }, (err, res, body) => {
      if (err || body.indexOf('error') > -1) return done(err || body)
      else return done()
    })
  })

  it('should exist', function () {
    assert(CouchContinuum)
  })

  it('should retrieve all non-special dbs', function () {
    CouchContinuum.allDbs(couchUrl).then((dbNames) => {
      assert(dbNames.length > 0)
      dbNames.forEach((dbName) => {
        assert.notEqual(dbName[0], '_')
      })
    })
  })

  it('should create replicas repeatedly OK', function () {
    const options = { couchUrl, dbName, q }
    const continuum = new CouchContinuum(options)
    return continuum.createReplica().then(() => {
      return continuum.createReplica()
    })
  })

  it('should replicate and replace a primary', function () {
    this.timeout(30 * 1000) // 30s
    const options = { couchUrl, dbName, q }
    const continuum = new CouchContinuum(options)
    return continuum.createReplica().then(() => {
      return continuum.replacePrimary()
    })
  })

  it('should check if a db is in use', function () {
    const continuum = new CouchContinuum({ couchUrl, dbName, q })
    return continuum._isInUse(dbName)
  })

  it('should filter tombstones', function () {
    const options = { couchUrl, dbName, filterTombstones: true }
    const continuum = new CouchContinuum(options)
    return continuum.createReplica()
  })

  it('should migrate all OK', function () {
    this.timeout(30 * 1000)
    return CouchContinuum
      .getCheckpoint(couchUrl)
      .then(() => {
        const options = { couchUrl, dbName, q }
        return [new CouchContinuum(options)]
      })
      .then((continuums) => {
        return CouchContinuum
          .createReplicas(continuums)
          .then(() => {
            return CouchContinuum
              .replacePrimaries(continuums)
          })
      })
      .then(() => {
        return CouchContinuum
          .removeCheckpoint()
      })
  })

  it('should clean up after itself', function (done) {
    const url = [couchUrl, '_all_dbs'].join('/')
    request({ url, json: true }, (err, response, allDbs) => {
      if (err) return done(err)
      const leftovers = allDbs.filter((db) => {
        return (db.substring(0, 1) !== '_') && (db !== dbName)
      })
      if (leftovers.length > 0) {
        done(new Error('There should be no DBs leftover from testing.'))
      } else {
        done()
      }
    })
  })
})
