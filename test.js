/* globals describe, it */

const assert = require('assert')
const CouchContinuum = require('.')
const { name, version } = require('./package.json')

describe([name, version].join(' @ '), function () {
  it('should exist', function () {
    assert(CouchContinuum)
  })

  it('should work', function () {
    this.timeout(1000 * 5) // 5s
    const continuum = new CouchContinuum({
      couchUrl: 'http://localhost:5984',
      dbName: 'test-continuum',
      q: 4
    })
    return continuum.start()
  })
})
