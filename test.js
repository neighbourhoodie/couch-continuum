/* globals describe, it, before, after */

const assert = require('assert')
const CouchContinuum = require('.')
const request = require('request')
const { name, version } = require('./package.json')

describe([name, version].join(' @ '), function () {
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

  it('should work', function () {
    this.timeout(1000 * 10) // 5s
    const options = { couchUrl, dbName, q }
    const continuum = new CouchContinuum(options)
    return continuum.start()
  })
})
